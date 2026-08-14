import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseItemSystem } from '@dnd/shared';

/**
 * Browsing the compendium, and hand-entering what it does not have.
 *
 * Two things are worth a test rather than a look. The category filter matches
 * the SRD's own prose, which is inconsistent by source — the same shelf is
 * "Weapon" in one dataset and "Weapons" in the other, "Ring" and "Rings" — so a
 * filter that reads correctly can still miss half a shelf.
 *
 * And a hand-entered weapon has to arrive with a real `system` blob, not a name
 * in a box. If `damageDice` or `proficient` are lost on the way in, the sheet
 * shows a blank to-hit and the target panel will not let you swing it, which
 * looks like the item was added successfully.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-compendium-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';

let baseUrl: string;
let close: () => Promise<void>;
let cookie: string;
let actorId: string;

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request failed');
  return payload as T;
}

interface ItemRow {
  id: string;
  name: string;
  category: string;
  itemType: string;
}

interface SpellRow {
  id: string;
  name: string;
  level: number;
  school: string;
  classes: string[];
}

beforeAll(async () => {
  const { buildApp } = await import('../app.js');
  const { runMigrations } = await import('../db/migrate.js');

  await runMigrations();
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  close = async () => {
    await app.close();
  };

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dm@compendium.local', displayName: 'DM', password: 'password12345' }),
  });
  cookie = (registered.headers.get('set-cookie') ?? '').split(';')[0];

  const actor = await api<{ actor: { id: string } }>('POST', '/api/actors', { name: 'Test Fighter' });
  actorId = actor.actor.id;

  // A miniature compendium. The category strings are copied verbatim from the
  // real datasets, singular/plural inconsistency included — that is the point.
  const { db } = await import('../db/index.js');
  const { srdItems, srdMonsters, srdSpells } = await import('../db/schema.js');
  const { newId } = await import('../lib/id.js');

  const gear = (name: string, category: string, itemType = 'equipment') => ({
    id: newId(),
    ruleset: '2014' as const,
    name,
    category,
    itemType,
    cost: '1 gp',
    weight: 1,
    description: '',
    system: parseItemSystem(itemType === 'weapon' ? 'weapon' : 'equipment', {}),
  });

  await db.insert(srdItems).values([
    gear('Longsword', 'Weapon', 'weapon'),
    gear('Shortbow', 'Weapons', 'weapon'),
    gear('Chain Mail', 'Armor'),
    gear('Shield', 'Armor'),
    gear('Rope, Hempen', 'Adventuring Gear'),
    gear("Smith's Tools", "Artisan's Tools"),
    gear('Lute', 'Musical Instruments'),
    gear('Potion of Healing', 'Potion'),
    gear('Spell Scroll', 'Scrolls'),
    gear('Ring of Protection', 'Ring'),
    gear('Ring of Invisibility', 'Rings'),
    gear('Bag of Holding', 'Wondrous Items'),
    gear('Riding Horse', 'Mounts and Vehicles'),
  ]);

  const spell = (name: string, level: number, school: string, classes: string[]) => ({
    id: newId(),
    ruleset: '2014' as const,
    name,
    level,
    school,
    castingTime: '1 action',
    range: '60 feet',
    components: 'V, S',
    duration: 'Instantaneous',
    concentration: false,
    ritual: false,
    description: '',
    higherLevel: '',
    classes,
    system: parseItemSystem('spell', { level, school }),
  });

  await db.insert(srdSpells).values([
    spell('Fire Bolt', 0, 'Evocation', ['Sorcerer', 'Wizard']),
    spell('Fireball', 3, 'Evocation', ['Sorcerer', 'Wizard']),
    spell('Counterspell', 3, 'Abjuration', ['Sorcerer', 'Warlock', 'Wizard']),
    spell('Cure Wounds', 1, 'Evocation', ['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger']),
    spell('Shield of Faith', 1, 'Abjuration', ['Cleric', 'Paladin']),
    spell('Bless', 1, 'Enchantment', ['Cleric', 'Paladin']),
  ]);

  // Enough monsters to page. Named so alphabetical order is obvious in a
  // failure message.
  await db.insert(srdMonsters).values(
    ['Aboleth', 'Basilisk', 'Cockatrice', 'Dryad', 'Ettin', 'Ghoul'].map((name) => ({
      id: newId(),
      ruleset: '2014' as const,
      name,
      size: 'Medium',
      type: 'monstrosity',
      data: {},
    })),
  );
}, 60000);

afterAll(async () => {
  await close?.();
  const { client } = await import('../db/index.js');
  client.close();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // Not worth failing a passing suite over.
  }
});

describe('browsing without searching', () => {
  it('lists everything when no filter is given', async () => {
    const { items } = await api<{ items: ItemRow[] }>('GET', '/api/compendium/items');
    // You cannot search for a thing whose name you do not know.
    expect(items.length).toBe(13);
  });

  it('lists spells the same way', async () => {
    const { spells } = await api<{ spells: SpellRow[] }>('GET', '/api/compendium/spells');
    expect(spells.length).toBe(6);
  });
});

describe('category filters', () => {
  const names = (items: ItemRow[]) => items.map((i) => i.name).sort();

  it('catches both spellings of a shelf', async () => {
    // "Weapon" and "Weapons"; "Ring" and "Rings". The 2014 and 2024 datasets
    // disagree, and a filter that only matched one would quietly halve the list.
    const weapons = await api<{ items: ItemRow[] }>('GET', '/api/compendium/items?category=weapon');
    expect(names(weapons.items)).toEqual(['Longsword', 'Shortbow']);

    const magic = await api<{ items: ItemRow[] }>('GET', '/api/compendium/items?category=magic');
    expect(names(magic.items)).toEqual([
      'Bag of Holding',
      'Ring of Invisibility',
      'Ring of Protection',
    ]);
  });

  it('groups armour, gear, tools, consumables and vehicles', async () => {
    const cases: [string, string[]][] = [
      ['armor', ['Chain Mail', 'Shield']],
      ['gear', ['Rope, Hempen']],
      ['tools', ['Lute', "Smith's Tools"]],
      ['consumable', ['Potion of Healing', 'Spell Scroll']],
      ['vehicle', ['Riding Horse']],
    ];

    for (const [category, expected] of cases) {
      const res = await api<{ items: ItemRow[] }>('GET', `/api/compendium/items?category=${category}`);
      expect(names(res.items), category).toEqual(expected);
    }
  });

  it('rejects a category it does not know rather than returning everything', async () => {
    await expect(
      api('GET', '/api/compendium/items?category=nonsense'),
    ).rejects.toThrow();
  });
});

describe('spell filters', () => {
  it('narrows by class', async () => {
    const wizard = await api<{ spells: SpellRow[] }>('GET', '/api/compendium/spells?class=Wizard');
    expect(wizard.spells.map((s) => s.name).sort()).toEqual(['Counterspell', 'Fire Bolt', 'Fireball']);
  });

  it('narrows by school, and stacks with class and level', async () => {
    const abjuration = await api<{ spells: SpellRow[] }>(
      'GET',
      '/api/compendium/spells?school=Abjuration',
    );
    expect(abjuration.spells.map((s) => s.name).sort()).toEqual(['Counterspell', 'Shield of Faith']);

    // Browsing is only useful if the filters combine.
    const stacked = await api<{ spells: SpellRow[] }>(
      'GET',
      '/api/compendium/spells?school=Abjuration&class=Wizard&level=3',
    );
    expect(stacked.spells.map((s) => s.name)).toEqual(['Counterspell']);
  });
});

describe('paging past the first page', () => {
  it('reports more, and the next page does not repeat the first', async () => {
    const first = await api<{ spells: SpellRow[]; more: boolean }>(
      'GET',
      '/api/compendium/spells?limit=2',
    );
    expect(first.spells).toHaveLength(2);
    expect(first.more).toBe(true);

    const second = await api<{ spells: SpellRow[]; more: boolean }>(
      'GET',
      '/api/compendium/spells?limit=2&offset=2',
    );
    const overlap = second.spells.filter((s) => first.spells.some((f) => f.id === s.id));
    expect(overlap).toHaveLength(0);
  });

  it('stops offering more on a short page', async () => {
    const last = await api<{ spells: SpellRow[]; more: boolean }>(
      'GET',
      '/api/compendium/spells?limit=4&offset=4',
    );
    // Six spells, so the second page holds two - and there is nothing after it.
    expect(last.spells).toHaveLength(2);
    expect(last.more).toBe(false);
  });

  it('pages the bestiary too', async () => {
    // The regression: monsters were the one shelf paging was never applied to,
    // so the browser showed the server's default 60 of 337 and had no way to
    // know the rest existed - which reads as a bestiary that stops at C.
    const first = await api<{ monsters: { id: string; name: string }[]; more: boolean }>(
      'GET',
      '/api/compendium/monsters?limit=4',
    );
    expect(first.monsters.map((m) => m.name)).toEqual([
      'Aboleth',
      'Basilisk',
      'Cockatrice',
      'Dryad',
    ]);
    expect(first.more).toBe(true);

    const second = await api<{ monsters: { id: string; name: string }[]; more: boolean }>(
      'GET',
      '/api/compendium/monsters?limit=4&offset=4',
    );
    expect(second.monsters.map((m) => m.name)).toEqual(['Ettin', 'Ghoul']);
    expect(second.more).toBe(false);
  });
});

describe('hand-entered items', () => {
  it('keeps the numbers an attack needs', async () => {
    const { item } = await api<{ item: { id: string; type: string; system: Record<string, unknown> } }>(
      'POST',
      `/api/actors/${actorId}/items`,
      {
        type: 'weapon',
        name: 'Longsword +1',
        system: {
          damageDice: '1d8',
          damageBonus: 1,
          damageType: 'slashing',
          attackBonus: 1,
          ability: 'str',
          proficient: true,
          range: { type: 'touch', value: 5, long: null },
          properties: ['versatile'],
          versatile: true,
          versatileDice: '1d10',
        },
      },
    );

    // Every one of these is read by the attack table or the target panel. A
    // missing damageDice renders an empty cell rather than an error.
    expect(item.type).toBe('weapon');
    expect(item.system.damageDice).toBe('1d8');
    expect(item.system.attackBonus).toBe(1);
    expect(item.system.proficient).toBe(true);
    expect(item.system.range).toEqual({ type: 'touch', value: 5, long: null });
    expect(item.system.versatileDice).toBe('1d10');
  });

  it('fills the rest from the schema rather than leaving holes', async () => {
    const { item } = await api<{ item: { system: Record<string, unknown> } }>(
      'POST',
      `/api/actors/${actorId}/items`,
      { type: 'weapon', name: 'Improvised Club', system: { damageDice: '1d4' } },
    );

    // The form only sends what was filled in; undefined here would crash the
    // attack row on `s.range.type`.
    expect(item.system.ability).toBe('str');
    expect(item.system.proficient).toBe(true);
    expect(item.system.range).toEqual({ type: 'touch', value: 5, long: null });
    expect(item.system.properties).toEqual([]);
  });

  it('takes a spell with a save', async () => {
    const { item } = await api<{ item: { system: Record<string, unknown> } }>(
      'POST',
      `/api/actors/${actorId}/items`,
      {
        type: 'spell',
        name: 'Homebrew Blast',
        system: {
          level: 2,
          school: 'Evocation',
          damageDice: '4d6',
          damageType: 'fire',
          save: { ability: 'dex', halfOnSuccess: true },
          range: { type: 'ranged', value: 60, long: null },
        },
      },
    );

    expect(item.system.save).toEqual({ ability: 'dex', halfOnSuccess: true });
    expect(item.system.damageDice).toBe('4d6');
  });

  it('refuses a system blob that does not fit the declared type', async () => {
    // A weapon's damage dice are a string; sending a number should be rejected
    // rather than stored and rendered as "[object Object]" later.
    await expect(
      api('POST', `/api/actors/${actorId}/items`, {
        type: 'weapon',
        name: 'Nonsense',
        system: { damageDice: 12, ability: 'wis' },
      }),
    ).rejects.toThrow();
  });
});
