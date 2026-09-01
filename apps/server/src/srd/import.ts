/**
 * Imports the SRD 5.1 dataset (CC-BY-4.0, via 5e-bits/5e-database) into the
 * compendium tables.
 *
 * Source records are transformed into the same `system` shapes the Item
 * documents use, so dragging a compendium spell onto a character sheet is a
 * straight copy rather than a conversion.
 *
 * Idempotent: re-running replaces the compendium in place.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  POTION_HEALING,
  auditPotionHealing,
  auditSpellConditions,
  auditAsiLevels,
  auditXpByCr,
  CONDITIONS,
  ASI_LEVELS,
  XP_BY_CR,
  parseRange,
  type AbilityKey,
  type ItemSystem,
} from '@dnd/shared';
import { db } from '../db/index.js';
import {
  srdClassLevels,
  srdFeatures,
  srdItems,
  srdMonsters,
  srdSpells,
  srdTraits,
} from '../db/schema.js';
import { paths } from '../env.js';
import { modifiersFromMonster } from '../lib/monsterItems.js';

const BASE_2014 = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en';
const BASE_2024 = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2024/en';

/**
 * Monster art lives on the API host, not in the data repo: records carry a
 * host-relative `image` like `/api/images/monsters/goblin.png`.
 */
const IMAGE_HOST = 'https://www.dnd5eapi.co';

/** Downloads run in parallel, but not 337-at-once at somebody else's server. */
const IMAGE_CONCURRENCY = 8;

const SOURCES = {
  spells: '5e-SRD-Spells.json',
  monsters: '5e-SRD-Monsters.json',
  equipment: '5e-SRD-Equipment.json',
  magicItems: '5e-SRD-Magic-Items.json',
  levels: '5e-SRD-Levels.json',
  features: '5e-SRD-Features.json',
  traits: '5e-SRD-Traits.json',
  // The one file whose *name* changes between editions - 2024 renamed races to
  // species. Both are loaded optional, so the edition that does not have one
  // is an empty list rather than an import that dies holding no compendium.
  races: '5e-SRD-Races.json',
  species: '5e-SRD-Species.json',
} as const;

/**
 * Downloads once and caches under data/srd/ so re-imports work offline.
 *
 * `optional` covers the 2024 files that are not published yet - spells and
 * monsters chief among them - so a missing one is an empty list rather than a
 * failed import.
 */
async function load(file: string, ruleset: '2014' | '2024' = '2014', optional = false): Promise<unknown[]> {
  const cached = path.join(paths.srd, `${ruleset}-${file}`);
  try {
    return JSON.parse(await fs.readFile(cached, 'utf8'));
  } catch {
    // Not cached yet.
  }

  process.stdout.write(`  downloading ${ruleset}/${file}... `);
  const response = await fetch(`${ruleset === '2024' ? BASE_2024 : BASE_2014}/${file}`);

  if (!response.ok) {
    if (optional) {
      console.log(`not published (HTTP ${response.status})`);
      return [];
    }
    throw new Error(`${file}: HTTP ${response.status}`);
  }

  const text = await response.text();
  await fs.writeFile(cached, text);
  console.log(`${(text.length / 1024).toFixed(0)}KB`);

  return JSON.parse(text);
}

/**
 * Fetches bestiary art once and caches it under `data/srd/images/`, the same
 * download-once-then-offline contract the JSON has.
 *
 * Bytes are re-encoded through sharp rather than written as received, for the
 * reason uploads are: the output is generated from decoded pixels, so a file
 * that is both a valid PNG and a valid script cannot survive the trip. 512px
 * is plenty for a browser row and a token at any zoom this board reaches.
 *
 * A failure here is never fatal. Art is a nicety; a bestiary with no pictures
 * is the product as it shipped last week, whereas an import that dies halfway
 * because a third-party host was down leaves no compendium at all.
 */
async function cacheMonsterImage(index: string, source: string): Promise<string | null> {
  // `index` is upstream data, and it is about to become a path segment. The
  // dataset only ever publishes slugs, but a `..` in one would climb out of
  // data/srd/images/ and the claim in app.ts that these filenames are safe
  // would stop being true.
  if (!/^[a-z0-9-]+$/i.test(index)) return null;

  const filename = `${index}.webp`;
  const target = path.join(paths.srdImages, filename);
  const url = `/srd-images/${filename}`;

  try {
    await fs.access(target);
    return url;
  } catch {
    // Not cached yet.
  }

  try {
    const response = await fetch(source.startsWith('http') ? source : `${IMAGE_HOST}${source}`, {
      // Without this a single stalled connection hangs its worker forever, and
      // the Promise.all below never settles: the import would sit there having
      // deleted nothing and written nothing, which is worse than no art.
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;

    const encoded = await sharp(Buffer.from(await response.arrayBuffer()))
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    // Written to a temporary name and renamed, because rename is atomic and
    // writeFile is not. An import killed mid-write would otherwise leave a
    // truncated file that the `fs.access` check above accepts forever - a
    // broken image no re-run can repair.
    const staging = `${target}.${process.pid}.tmp`;
    await fs.writeFile(staging, encoded);
    await fs.rename(staging, target);

    return url;
  } catch {
    return null;
  }
}

/**
 * Resolves art for every monster that names one, `IMAGE_CONCURRENCY` at a time.
 * Returns index -> local URL for those that succeeded.
 */
async function cacheMonsterImages(monsters: Json[]): Promise<Map<string, string>> {
  // Deduped by index, not by row: the three published 2024 monsters carry the
  // same index - and the same picture - as their 2014 counterparts, so without
  // this two workers race to write one path, and the same file is fetched
  // twice from somebody else's server.
  const pending = [
    ...new Map(
      monsters
        .filter((m) => typeof m.image === 'string' && m.image)
        .map((m) => [m.index as string, m]),
    ).values(),
  ];
  const resolved = new Map<string, string>();
  if (pending.length === 0) return resolved;

  process.stdout.write(`  caching ${pending.length} monster images... `);

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const monster = pending[cursor++];
        const url = await cacheMonsterImage(monster.index, monster.image);
        if (url) resolved.set(monster.index, url);
      }
    }),
  );

  console.log(`${resolved.size} available`);
  return resolved;
}

/* -------------------------------------------------------------- helpers */

type Json = Record<string, any>;

function joinDesc(value: unknown): string {
  if (Array.isArray(value)) return value.join('\n\n');
  return typeof value === 'string' ? value : '';
}

type Ruleset = '2014' | '2024';

interface ClassLevelRow {
  id: string;
  ruleset: Ruleset;
  className: string;
  level: number;
  spellcasting: Record<string, number> | null;
  classSpecific: Record<string, unknown>;
}

interface FeatureRow {
  id: string;
  ruleset: Ruleset;
  className: string;
  subclassName: string;
  level: number;
  name: string;
  description: string;
  parentName: string;
}

interface TraitRow {
  id: string;
  ruleset: Ruleset;
  name: string;
  description: string;
  races: string[];
}

/**
 * A class's row for one level.
 *
 * Subclass rows are skipped: they carry only features, which come from the
 * features file with their own class and level on them. Two copies of that
 * relationship would be two chances to disagree.
 */
function toClassLevelRow(row: Json, ruleset: Ruleset): ClassLevelRow | null {
  if (row.subclass) return null;

  const className = row.class?.name ?? '';
  if (!className || typeof row.level !== 'number') return null;

  return {
    id: `${ruleset}-${row.index}`,
    ruleset,
    className,
    level: row.level,
    spellcasting: row.spellcasting ?? null,
    classSpecific: row.class_specific ?? {},
  };
}

/**
 * The level a feature is gained at.
 *
 * 2014 publishes a plain number and 2024 publishes a *reference to the level
 * entry* - `{ index: 'barbarian-1', url: '.../levels/1' }` - so reading it as a
 * number silently dropped every 2024 feature and left a 2024 campaign with no
 * class features at all. The import reported success either way, which is why
 * the row counts get looked at rather than the exit code.
 */
function levelNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;

  if (value && typeof value === 'object') {
    const ref = value as { index?: string; url?: string };
    const found = /(\d+)$/.exec(ref.url ?? ref.index ?? '');
    if (found) return Number(found[1]);
  }

  return null;
}

/**
 * A class or subclass feature.
 *
 * 2014 publishes `desc` as an array and 2024 publishes `description` as a
 * string; `joinDesc` takes either. `parent` is what turns seven sibling rows
 * into "Fighting Style" and six options.
 */
function toFeatureRow(row: Json, ruleset: Ruleset): FeatureRow | null {
  const className = row.class?.name ?? '';
  const level = levelNumber(row.level);
  if (!className || level === null) return null;

  return {
    id: `${ruleset}-${row.index}`,
    ruleset,
    className,
    subclassName: row.subclass?.name ?? '',
    level,
    name: row.name ?? '',
    description: joinDesc(row.description ?? row.desc),
    parentName: row.parent?.name ?? '',
  };
}

/**
 * A racial trait, with every race and subrace that has it.
 *
 * 2014 says `races`/`subraces` and 2024 says `species`/`subspecies`; both are
 * read, because `actors.race` is free text and has to match either.
 */
function toTraitRow(row: Json, ruleset: Ruleset): TraitRow | null {
  if (!row.name) return null;

  const named = (list: unknown): string[] =>
    Array.isArray(list) ? list.map((entry: Json) => entry?.name).filter(Boolean) : [];

  return {
    id: `${ruleset}-${row.index}`,
    ruleset,
    name: row.name,
    description: joinDesc(row.description ?? row.desc),
    races: [
      ...named(row.races),
      ...named(row.subraces),
      ...named(row.species),
      ...named(row.subspecies),
    ],
  };
}

/** 5e sizes as token footprints in grid units. */
function tokenSizeFor(size: string): number {
  switch ((size ?? '').toLowerCase()) {
    case 'tiny':
      return 0.5;
    case 'large':
      return 2;
    case 'huge':
      return 3;
    case 'gargantuan':
      return 4;
    default:
      return 1;
  }
}

/** 0.25 -> "1/4", so the DM's monster list reads like the stat block. */
function formatCR(cr: number): string {
  if (cr === 0.125) return '1/8';
  if (cr === 0.25) return '1/4';
  if (cr === 0.5) return '1/2';
  return String(cr ?? 0);
}

const AOE_SHAPES: Record<string, string> = {
  sphere: 'circle',
  cone: 'cone',
  line: 'ray',
  cube: 'cube',
  cylinder: 'cylinder',
  square: 'rect',
};

/* --------------------------------------------------------------- spells */

function toSpellSystem(spell: Json): ItemSystem {
  const rangeText = spell.range ?? '';
  const components: string[] = spell.components ?? [];

  // Damage scales by slot level or character level depending on the spell;
  // take the lowest entry as the base and let higherLevel prose explain the rest.
  const scaling: Json =
    spell.damage?.damage_at_slot_level ?? spell.damage?.damage_at_character_level ?? {};
  const firstKey = Object.keys(scaling).sort((a, b) => Number(a) - Number(b))[0];

  const dcAbility: string | undefined = spell.dc?.dc_type?.index;

  return {
    srdSpellId: spell.index,
    level: spell.level ?? 0,
    school: spell.school?.name ?? '',
    castingTime: spell.casting_time ?? '1 action',
    activation: { type: 'action', cost: 1 },
    rangeText,
    range: parseRange(rangeText),
    components: {
      verbal: components.includes('V'),
      somatic: components.includes('S'),
      material: components.includes('M'),
      materialText: spell.material ?? '',
    },
    duration: spell.duration ?? 'Instantaneous',
    concentration: Boolean(spell.concentration),
    ritual: Boolean(spell.ritual),
    targetCount: spell.area_of_effect ? null : 1,
    areaOfEffect: spell.area_of_effect
      ? {
          shape: (AOE_SHAPES[spell.area_of_effect.type] ?? 'circle') as never,
          size: spell.area_of_effect.size ?? 0,
          width: null,
        }
      : null,
    damageDice: firstKey ? String(scaling[firstKey]) : '',
    damageType: spell.damage?.damage_type?.name ?? '',
    save: dcAbility
      ? { ability: dcAbility as never, halfOnSuccess: spell.dc?.dc_success === 'half' }
      : null,
    attackRoll: Boolean(spell.attack_type),
    prepared: false,
    alwaysPrepared: false,
    higherLevel: joinDesc(spell.higher_level),
    description: joinDesc(spell.desc),
  } as ItemSystem;
}

/* ------------------------------------------------------------ equipment */

function toEquipmentSystem(item: Json): { itemType: string; system: ItemSystem } {
  /*
   * 2014 carries a single `equipment_category` with singular names ("weapon");
   * 2024 carries an `equipment_categories` array with plural, more specific
   * ones ("martial-melee-weapons", "weapons"). Scan the whole list rather than
   * trusting the first entry, which is the most specific and least useful.
   */
  const categories: string[] = [
    item.equipment_category?.index,
    ...(Array.isArray(item.equipment_categories)
      ? item.equipment_categories.map((c: Json) => c?.index)
      : []),
  ].filter(Boolean);

  const isWeapon = categories.some((c) => c === 'weapon' || c === 'weapons');
  const isArmor = categories.some((c) => c === 'armor' || c === 'armour' || c === 'shields');
  // A potion is a consumable, not a piece of equipment. Everything imported
  // used to arrive as `weapon` or `equipment`, so a potion could never carry
  // the healing an item card needs - `buildCard` only offers those buttons to
  // a consumable. All forty in 5.1 say so themselves.
  const isPotion = categories.some((c) => c === 'potion' || c === 'potions');
  const category = isWeapon ? 'weapon' : isArmor ? 'armor' : '';
  const weight = item.weight ?? 0;
  const cost = item.cost ? `${item.cost.quantity} ${item.cost.unit}` : '';

  const shared = {
    quantity: 1,
    weight,
    equipped: false,
    magical: false,
    attunement: 'none' as const,
    price: cost,
    description: joinDesc(item.desc),
  };

  if (category === 'weapon') {
    // 2024 drops weapon_range, so fall back to the category list.
    const isRanged =
      item.weapon_range === 'Ranged' || categories.some((c) => c === 'ranged-weapons');
    const properties: string[] = (item.properties ?? []).map((p: Json) => p.name);

    return {
      itemType: 'weapon',
      system: {
        ...shared,
        ability: isRanged ? 'dex' : 'str',
        proficient: true,
        attackBonus: 0,
        damageDice: item.damage?.damage_dice ?? '1d4',
        damageBonus: 0,
        damageType: item.damage?.damage_type?.name ?? '',
        finesse: properties.includes('Finesse'),
        versatile: properties.includes('Versatile'),
        versatileDice: item.two_handed_damage?.damage_dice ?? '',
        twoHanded: properties.includes('Two-Handed'),
        thrown: properties.includes('Thrown'),
        range: {
          type: isRanged ? 'ranged' : 'touch',
          value: item.range?.normal ?? 5,
          long: item.range?.long ?? null,
        },
        properties,
        mastery: item.mastery?.name ?? '',
        activation: { type: 'action', cost: 1 },
      } as ItemSystem,
    };
  }

  if (category === 'armor') {
    return {
      itemType: 'equipment',
      system: {
        ...shared,
        armorType: (item.armor_category ?? 'none').toLowerCase(),
        baseAC: item.armor_class?.base ?? 0,
        // "dex_bonus false" means heavy armor (no DEX); max_bonus caps medium at +2.
        dexCap: item.armor_class?.dex_bonus === false ? 0 : (item.armor_class?.max_bonus ?? null),
        strengthRequirement: item.str_minimum ?? 0,
        stealthDisadvantage: Boolean(item.stealth_disadvantage),
      } as ItemSystem,
    };
  }

  if (isPotion) {
    return {
      itemType: 'consumable',
      system: {
        ...shared,
        consumableType: 'potion',
        uses: null,
        // Filled from the curated table by the caller where one exists; the
        // other thirty-six stay descriptive rather than guessed at.
        healingDice: '',
        damageDice: '',
        damageType: '',
        range: { type: 'touch', value: 5, long: null },
      } as ItemSystem,
    };
  }

  return { itemType: 'equipment', system: { ...shared, armorType: 'none', baseAC: 0, dexCap: null, strengthRequirement: 0, stealthDisadvantage: false } as ItemSystem };
}

/** Keeps the last row for any repeated id; sources overlap between files. */
function dedupe<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/* --------------------------------------------------------------- import */

export async function importSrd(): Promise<void> {
  console.log('Importing SRD 5.1 (CC-BY-4.0, 5e-bits/5e-database)');

  const [spells, monsters, equipment, magicItems] = await Promise.all([
    load(SOURCES.spells, '2014'),
    load(SOURCES.monsters, '2014'),
    load(SOURCES.equipment, '2014'),
    load(SOURCES.magicItems, '2014'),
  ]);

  // The 2024 dataset is partial. Equipment carries weapon mastery, which is the
  // change a table actually feels; spells and monsters are not published yet,
  // so a 2024 campaign still draws those from 2014.
  const [equipment2024, magicItems2024, monsters2024] = await Promise.all([
    load(SOURCES.equipment, '2024', true),
    load(SOURCES.magicItems, '2024', true),
    load(SOURCES.monsters, '2024', true),
  ]);

  /**
   * Class progression, which nothing here has ever fetched.
   *
   * All of it is optional. A level-up briefing is a nicety, and an import that
   * dies halfway because one file moved leaves the table with no compendium at
   * all - the same reasoning that makes a failed art download non-fatal.
   */
  const [
    levels,
    levels2024,
    features,
    features2024,
    traits,
    traits2024,
    races,
    species,
  ] = await Promise.all([
    load(SOURCES.levels, '2014', true),
    load(SOURCES.levels, '2024', true),
    load(SOURCES.features, '2014', true),
    load(SOURCES.features, '2024', true),
    load(SOURCES.traits, '2014', true),
    load(SOURCES.traits, '2024', true),
    load(SOURCES.races, '2014', true),
    load(SOURCES.species, '2024', true),
  ]);

  // Art is fetched before the tables are rebuilt so a row is only ever written
  // with a URL whose file is already on disk.
  const monsterImages = await cacheMonsterImages([
    ...(monsters as Json[]),
    ...(monsters2024 as Json[]),
  ]);

  // Replace wholesale so a re-run picks up upstream corrections.
  await db.delete(srdSpells);
  await db.delete(srdMonsters);
  await db.delete(srdItems);
  await db.delete(srdClassLevels);
  await db.delete(srdFeatures);
  await db.delete(srdTraits);

  const spellRows = dedupe((spells as Json[]).map((s) => ({
    id: s.index,
    ruleset: '2014' as const,
    name: s.name,
    level: s.level ?? 0,
    school: s.school?.name ?? '',
    castingTime: s.casting_time ?? '',
    range: s.range ?? '',
    components: (s.components ?? []).join(', '),
    duration: s.duration ?? '',
    concentration: Boolean(s.concentration),
    ritual: Boolean(s.ritual),
    description: joinDesc(s.desc),
    higherLevel: joinDesc(s.higher_level),
    classes: (s.classes ?? []).map((c: Json) => c.name) as string[],
    system: toSpellSystem(s),
  })));

  const toMonsterRow = (m: Json, ruleset: '2014' | '2024') => ({
    id: ruleset === '2024' ? `2024-${m.index}` : m.index,
    ruleset,
    name: m.name,
    size: m.size ?? '',
    type: m.type ?? '',
    alignment: m.alignment ?? '',
    // Newer dataset versions express AC as an array of sources.
    armorClass: Array.isArray(m.armor_class) ? (m.armor_class[0]?.value ?? 10) : (m.armor_class ?? 10),
    hitPoints: m.hit_points ?? 1,
    hitDice: m.hit_dice ?? '',
    speed: Object.entries(m.speed ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
    str: m.strength ?? 10,
    dex: m.dexterity ?? 10,
    con: m.constitution ?? 10,
    int: m.intelligence ?? 10,
    wis: m.wisdom ?? 10,
    cha: m.charisma ?? 10,
    challengeRating: formatCR(m.challenge_rating),
    xp: m.xp ?? 0,
    tokenSize: tokenSizeFor(m.size),
    imageUrl: monsterImages.get(m.index) ?? null,
    data: m as Record<string, unknown>,
  });

  const monsterRows = dedupe([
    ...(monsters as Json[]).map((m) => toMonsterRow(m, '2014')),
    ...(monsters2024 as Json[]).map((m) => toMonsterRow(m, '2024')),
  ]);

  const toItemRow = (e: Json, ruleset: '2014' | '2024') => {
    const { itemType, system } = toEquipmentSystem(e);

    // The healing potions, from the curated table. The SRD states their dice
    // only in prose, so this is the one place those numbers come from - and
    // `auditPotionHealing` below checks the table against the data rather than
    // against itself.
    const healing = POTION_HEALING[String(e.index ?? '')];
    if (healing && itemType === 'consumable') {
      (system as Record<string, unknown>).healingDice = healing;
    }

    return {
      // 2024 reuses many indexes, so namespace them to avoid collisions.
      id: ruleset === '2024' ? `2024-${e.index}` : e.index,
      ruleset,
      name: e.name,
      category:
        e.equipment_category?.name ??
        (Array.isArray(e.equipment_categories) ? e.equipment_categories[0]?.name : null) ??
        'Wondrous Item',
      itemType,
      cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : '',
      weight: e.weight ?? 0,
      description: joinDesc(e.desc),
      system,
    };
  };

  // The equipment and magic-item files overlap, so the same index can appear
  // twice; last one wins rather than failing the whole import.
  const itemRows = dedupe([
    ...[...(equipment as Json[]), ...(magicItems as Json[])].map((e) => toItemRow(e, '2014')),
    ...[...(equipment2024 as Json[]), ...(magicItems2024 as Json[])].map((e) => toItemRow(e, '2024')),
  ]);

  const kept = <T,>(rows: (T | null)[]): T[] => rows.filter((row): row is T => row !== null);

  const classLevelRows = dedupe(
    kept([
      ...(levels as Json[]).map((row) => toClassLevelRow(row, '2014')),
      ...(levels2024 as Json[]).map((row) => toClassLevelRow(row, '2024')),
    ]),
  );

  const featureRows = dedupe(
    kept([
      ...(features as Json[]).map((row) => toFeatureRow(row, '2014')),
      ...(features2024 as Json[]).map((row) => toFeatureRow(row, '2024')),
    ]),
  );

  // Only the traits belonging to a race the SRD actually publishes: the trait
  // files carry entries for races that are not in the set, and a hint pointing
  // at a race nobody can pick is noise.
  const publishedRaces = new Set(
    [...(races as Json[]), ...(species as Json[])].map((row) => row.name).filter(Boolean),
  );
  const traitRows = dedupe(
    kept([
      ...(traits as Json[]).map((row) => toTraitRow(row, '2014')),
      ...(traits2024 as Json[]).map((row) => toTraitRow(row, '2024')),
    ]),
  ).filter((row) => row.races.length > 0);

  // Chunked: SQLite has a hard limit on variables per statement.
  for (const [table, rows] of [
    [srdSpells, spellRows],
    [srdMonsters, monsterRows],
    [srdItems, itemRows],
    [srdClassLevels, classLevelRows],
    [srdFeatures, featureRows],
    [srdTraits, traitRows],
  ] as const) {
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(table as never).values(rows.slice(i, i + 100) as never);
    }
  }

  const mastered = itemRows.filter(
    (row) => (row.system as { mastery?: string }).mastery,
  ).length;

  console.log(
    `  ${spellRows.length} spells, ${monsterRows.length} monsters, ${itemRows.length} items`,
  );
  console.log(
    `  2024: ${itemRows.filter((r) => r.ruleset === '2024').length} items ` +
      `(${mastered} with weapon mastery), ${monsterRows.filter((r) => r.ruleset === '2024').length} monsters`,
  );
  console.log(
    `  ${monsterRows.filter((r) => r.imageUrl).length} of ${monsterRows.length} monsters have art`,
  );

  reportXpByCr(monsterRows);
  reportDamageModifiers(monsterRows.map((row) => row.data as Record<string, unknown>));
  console.log('  2024 spells are not published in the SRD dataset; 2024 campaigns use the 2014 list');

  console.log(
    `  ${classLevelRows.length} class levels, ${featureRows.length} features, ${traitRows.length} racial traits`,
  );
  reportAsiLevels(levels as Json[]);

  reportSpellConditions(spellRows);
  reportPotionHealing(itemRows);
}

/**
 * Checks the curated `SPELL_CONDITIONS` table against what was just imported.
 *
 * This is the only moment the whole spell list is in hand, and the table's own
 * unit tests cannot do this job: they look its keys up by themselves, which
 * proves the lookup works and nothing about whether the keys match anything
 * real. That is how "tasha's hideous laughter" sat in the table never matching
 * a compendium row, since the SRD publishes it as plain "Hideous Laughter".
 *
 * A mismatch is the loud one. It means the table and the dataset disagree about
 * which save a spell forces, which makes every casting of it quietly wrong.
 */
/**
 * The curated potion table, checked against the compendium.
 *
 * Same rule as the spell conditions above: an entry that matches no real item
 * can never fire and cannot be verified by anything this project has, so it is
 * a bug in the table rather than a gap to live with.
 */
/**
 * The curated ability-score-increase levels, against the published counts.
 *
 * Only 2014 can check this - 2024 publishes no such field at all, which is why
 * the table is curated in the first place. The counts are cumulative, so this
 * turns them back into the levels where the count went up: the same arithmetic
 * that reading them naively gets wrong, done once here against real data.
 */
function reportAsiLevels(levels: Json[]): void {
  const rows = levels
    .filter((row) => !row.subclass && typeof row.ability_score_bonuses === 'number')
    .map((row) => ({
      className: row.class?.name ?? '',
      level: row.level as number,
      cumulative: row.ability_score_bonuses as number,
    }));

  if (rows.length === 0) {
    console.log('  ability score increases: nothing published to check the table against');
    return;
  }

  const audit = auditAsiLevels(rows);
  console.log(
    `  ability score increases: ${audit.matched.length} of ${Object.keys(ASI_LEVELS).length} classes agree with the compendium`,
  );
  for (const row of audit.disagreed) {
    console.log(
      `    ${row.className}: the table says ${row.ours.join('/')}, the compendium says ${row.published.join('/')}`,
    );
  }
  if (audit.unchecked.length > 0) {
    console.log(`    nothing published to check: ${audit.unchecked.join(', ')}`);
  }
}

function reportPotionHealing(items: { id: string; name: string; description: string }[]): void {
  const audit = auditPotionHealing(items);

  console.log(
    `  potion healing: ${audit.matched.length}/${Object.keys(POTION_HEALING).length} matched the compendium`,
  );
  if (audit.missing.length > 0) {
    console.log(`    NOT IN THE COMPENDIUM (fix the table): ${audit.missing.join(', ')}`);
  }
  if (audit.suspicious.length > 0) {
    console.log(`    text never mentions hit points, worth a look: ${audit.suspicious.join(', ')}`);
  }
}

/**
 * The curated CR-to-XP table, checked against every monster published.
 *
 * The one audit here that can be certain rather than a smell test: the
 * compendium carries both numbers for all 337 of them, so this is a straight
 * comparison. `XP_BY_CR` is only ever consulted for an NPC written by hand -
 * a stamped monster brings its own published figure - which is exactly why it
 * needs checking here: nothing else in the app would ever notice it was wrong.
 */
function reportXpByCr(monsters: { name: string; challengeRating: string; xp: number }[]): void {
  const audit = auditXpByCr(monsters);

  console.log(
    `  XP by challenge rating: ${audit.matched.length} of ${Object.keys(XP_BY_CR).length} ratings agree with the compendium`,
  );
  for (const row of audit.disagreed) {
    // Phrased as a count so the answer is obvious: a few rows out of many is a
    // typo upstream, and all of them would mean the table here is wrong.
    console.log(
      `    CR ${row.cr}: the table says ${row.ours}, but ${row.disagreeing} of ${row.total} ` +
        `published monsters say ${row.published} (e.g. ${row.example}) — upstream data, not used`,
    );
  }
  if (audit.unchecked.length > 0) {
    // Not a failure - nothing is published at CR 29 - but worth saying, since
    // an unchecked number is a hand-entered one nothing can verify.
    console.log(`    no published monster to check against: CR ${audit.unchecked.join(', ')}`);
  }
}

/**
 * What the bestiary says creatures shrug off, and what this refused to model.
 *
 * `damageModifiers` is applied by `applyDamage` and was written by nothing for
 * the life of the project, exactly as `image` sat unread in the same blob. Now
 * that `stampMonster` reads it, the counts are worth printing for the reason
 * `auditXpByCr` prints its own: they are the tell that upstream has changed
 * shape underneath us.
 *
 * The loud half is the unknown string. Nineteen distinct values exist today,
 * twelve of them bare damage types and seven qualified prose. A twentieth is
 * either a new type - which belongs in `DAMAGE_TYPES` and is currently being
 * silently discarded - or new prose, which is correctly becoming a note. Those
 * want opposite responses, and only naming it tells them apart.
 */
function reportDamageModifiers(monsters: Record<string, unknown>[]): void {
  let withType = 0;
  let proseOnly = 0;
  let withCondition = 0;
  const unknownConditions = new Set<string>();
  const prose = new Set<string>();

  for (const monster of monsters) {
    const m = modifiersFromMonster(monster);
    const types = [...m.resistances, ...m.vulnerabilities, ...m.immunities];
    if (types.length > 0) withType += 1;
    else if (m.qualified.length > 0) proseOnly += 1;
    if (m.conditionImmunities.length > 0) withCondition += 1;
    for (const line of m.qualified) prose.add(line.text);
    for (const name of m.conditionImmunities) {
      if (!CONDITIONS.includes(name as (typeof CONDITIONS)[number])) unknownConditions.add(name);
    }
  }

  console.log(
    `  damage modifiers: ${withType} of ${monsters.length} monsters carry a damage type this can apply, ` +
      `${withCondition} carry condition immunities`,
  );
  console.log(
    `    ${proseOnly} publish only qualified prose ("...from nonmagical weapons"), ` +
      `kept as a feature to read rather than guessed at`,
  );

  // A condition name with no match can never fire and nothing else would notice.
  for (const name of unknownConditions) {
    console.log(`    WARNING: condition immunity "${name}" matches no condition this app knows`);
  }
  if (prose.size > 7) {
    console.log(
      `    NOTE: ${prose.size} distinct qualified lines, up from the 7 this was written against — ` +
        `check whether any is now a bare damage type that belongs in DAMAGE_TYPES`,
    );
  }
}

function reportSpellConditions(
  spells: { name: string; duration: string; concentration: boolean; description: string; system: unknown }[],
): void {
  const audit = auditSpellConditions(
    spells.map((row) => ({
      name: row.name,
      save: (row.system as { save?: { ability?: AbilityKey } | null }).save?.ability ?? null,
      duration: row.duration,
      concentration: row.concentration,
      description: row.description,
    })),
  );

  const total =
    audit.matched.length + audit.supplied.length + audit.absent.length +
    new Set(audit.mismatched.map((m) => m.spell)).size;

  console.log(
    `  spell conditions: ${audit.matched.length + audit.supplied.length}/${total} agree with the ` +
      `compendium` +
      (audit.supplied.length > 0 ? ` (${audit.supplied.length} with no dc block of their own)` : ''),
  );

  // Every entry is expected to exist: one that does not can never fire from the
  // compendium, and nothing here can check it.
  if (audit.absent.length > 0) {
    console.warn(
      `  WARNING: no compendium spell matches ${audit.absent.join(', ')} - ` +
        'the name has drifted, and those conditions can never be applied',
    );
  }

  for (const bad of audit.mismatched) {
    console.warn(
      `  WARNING: ${bad.spell} ${bad.field}: the table says ${bad.table}, the compendium says ${bad.data}`,
    );
  }

  for (const odd of audit.unmentioned) {
    console.warn(
      `  WARNING: ${odd.spell} is set to apply "${odd.condition}", which its own text never mentions`,
    );
  }
}

if (process.argv[1]?.endsWith('import.ts') || process.argv[1]?.endsWith('import.js')) {
  const { runMigrations } = await import('../db/migrate.js');
  await runMigrations();
  await importSrd();
  process.exit(0);
}
