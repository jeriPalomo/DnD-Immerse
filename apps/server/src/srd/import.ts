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

const BASE = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en';

const SOURCES = {
  spells: '5e-SRD-Spells.json',
  monsters: '5e-SRD-Monsters.json',
  equipment: '5e-SRD-Equipment.json',
  magicItems: '5e-SRD-Magic-Items.json',
} as const;

/** Downloads once and caches under data/srd/ so re-imports work offline. */
async function load(file: string): Promise<unknown[]> {
  const cached = path.join(paths.srd, file);
  try {
    return JSON.parse(await fs.readFile(cached, 'utf8'));
  } catch {
    // Not cached yet.
  }

  process.stdout.write(`  downloading ${file}... `);
  const response = await fetch(`${BASE}/${file}`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);

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
  const category: string = item.equipment_category?.index ?? '';
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
    const isRanged = item.weapon_range === 'Ranged';
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

/* --------------------------------------------------------------- import */

export async function importSrd(): Promise<void> {
  console.log('Importing SRD 5.1 (CC-BY-4.0, 5e-bits/5e-database)');

  const [spells, monsters, equipment, magicItems] = await Promise.all([
    load(SOURCES.spells),
    load(SOURCES.monsters),
    load(SOURCES.equipment),
    load(SOURCES.magicItems),
  ]);

  // Replace wholesale so a re-run picks up upstream corrections.
  await db.delete(srdSpells);
  await db.delete(srdMonsters);
  await db.delete(srdItems);

  const spellRows = (spells as Json[]).map((s) => ({
    id: s.index,
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
  }));

  const monsterRows = (monsters as Json[]).map((m) => ({
    id: m.index,
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
  }));

  const itemRows = [...(equipment as Json[]), ...(magicItems as Json[])].map((e) => {
    const { itemType, system } = toEquipmentSystem(e);
    return {
      id: e.index,
      name: e.name,
      category: e.equipment_category?.name ?? 'Wondrous Item',
      itemType,
      cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : '',
      weight: e.weight ?? 0,
      description: joinDesc(e.desc),
      system,
    };
  });

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

  console.log(
    `  ${spellRows.length} spells, ${monsterRows.length} monsters, ${itemRows.length} items`,
  );
}

if (process.argv[1]?.endsWith('import.ts') || process.argv[1]?.endsWith('import.js')) {
  const { runMigrations } = await import('../db/migrate.js');
  await runMigrations();
  await importSrd();
  process.exit(0);
}
