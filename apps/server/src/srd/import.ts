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
import { parseRange, type ItemSystem } from '@dnd/shared';
import { db } from '../db/index.js';
import { srdItems, srdMonsters, srdSpells } from '../db/schema.js';
import { paths } from '../env.js';

const BASE_2014 = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en';
const BASE_2024 = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2024/en';

const SOURCES = {
  spells: '5e-SRD-Spells.json',
  monsters: '5e-SRD-Monsters.json',
  equipment: '5e-SRD-Equipment.json',
  magicItems: '5e-SRD-Magic-Items.json',
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

/* -------------------------------------------------------------- helpers */

type Json = Record<string, any>;

function joinDesc(value: unknown): string {
  if (Array.isArray(value)) return value.join('\n\n');
  return typeof value === 'string' ? value : '';
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

  // Replace wholesale so a re-run picks up upstream corrections.
  await db.delete(srdSpells);
  await db.delete(srdMonsters);
  await db.delete(srdItems);

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
    data: m as Record<string, unknown>,
  });

  const monsterRows = dedupe([
    ...(monsters as Json[]).map((m) => toMonsterRow(m, '2014')),
    ...(monsters2024 as Json[]).map((m) => toMonsterRow(m, '2024')),
  ]);

  const toItemRow = (e: Json, ruleset: '2014' | '2024') => {
    const { itemType, system } = toEquipmentSystem(e);
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

  // Chunked: SQLite has a hard limit on variables per statement.
  for (const [table, rows] of [
    [srdSpells, spellRows],
    [srdMonsters, monsterRows],
    [srdItems, itemRows],
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
  console.log('  2024 spells are not published in the SRD dataset; 2024 campaigns use the 2014 list');
}

if (process.argv[1]?.endsWith('import.ts') || process.argv[1]?.endsWith('import.js')) {
  const { runMigrations } = await import('../db/migrate.js');
  await runMigrations();
  await importSrd();
  process.exit(0);
}
