/**
 * Seeds an example campaign so the app can be exercised without hand-building
 * a party first: a DM, two players, three characters with real SRD gear and
 * spells, and a couple of NPCs.
 *
 * Idempotent - re-running wipes the demo accounts and rebuilds them. It only
 * ever touches users whose email ends in @example.com, so it will not disturb
 * real data.
 *
 *   npm run seed
 */
import { eq, inArray, like } from 'drizzle-orm';
import {
  actorInputSchema,
  emptyActor,
  parseItemSystem,
  type ActorInput,
  type ItemType,
} from '@dnd/shared';
import { db } from './db/index.js';
import {
  actorCampaigns,
  actors,
  campaignMembers,
  campaigns,
  items,
  srdItems,
  srdSpells,
  users,
} from './db/schema.js';
import { runMigrations } from './db/migrate.js';
import { hashPassword } from './auth/password.js';
import { newId, newInviteCode } from './lib/id.js';

export const DEMO_PASSWORD = 'demo-password';
const DEMO_DOMAIN = '@example.com';

interface SeedCharacter {
  name: string;
  fields: Partial<ActorInput>;
  spells?: string[];
  gear?: string[];
}

const PARTY: Record<string, SeedCharacter> = {
  'thorin@example.com': {
    name: 'Thorin Oakenshield',
    fields: {
      className: 'Fighter',
      race: 'Dwarf',
      background: 'Soldier',
      level: 5,
      str: 18, dex: 12, con: 16, int: 10, wis: 13, cha: 8,
      armorClass: 18, speed: 25, hpMax: 47, hpCurrent: 47,
      hitDiceTotal: '5d10',
      saveProficiencies: { str: true, con: true, dex: false, int: false, wis: false, cha: false },
      skillProficiencies: { athletics: 1, intimidation: 1, perception: 1 } as never,
    },
    gear: ['longsword', 'shield', 'plate-armor', 'handaxe'],
  },
  'elaria@example.com': {
    name: 'Elaria Moonwhisper',
    fields: {
      className: 'Wizard',
      race: 'High Elf',
      background: 'Sage',
      level: 5,
      str: 8, dex: 16, con: 14, int: 18, wis: 12, cha: 10,
      armorClass: 12, speed: 30, hpMax: 27, hpCurrent: 27,
      hitDiceTotal: '5d6',
      spellcastingAbility: 'int',
      // A 5th-level wizard: four 1st, three 2nd, two 3rd.
      spellSlots: { max: [4, 3, 2, 0, 0, 0, 0, 0, 0], used: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      saveProficiencies: { int: true, wis: true, str: false, dex: false, con: false, cha: false },
      skillProficiencies: { arcana: 1, history: 1, investigation: 1 } as never,
    },
    spells: ['fireball', 'magic-missile', 'shield', 'mage-armor', 'misty-step', 'fire-bolt'],
    gear: ['quarterstaff', 'dagger'],
  },
  'gareth@example.com': {
    name: 'Brother Gareth',
    fields: {
      className: 'Cleric',
      race: 'Human',
      background: 'Acolyte',
      level: 5,
      str: 14, dex: 10, con: 15, int: 11, wis: 18, cha: 13,
      armorClass: 18, speed: 30, hpMax: 38, hpCurrent: 38,
      hitDiceTotal: '5d8',
      spellcastingAbility: 'wis',
      spellSlots: { max: [4, 3, 2, 0, 0, 0, 0, 0, 0], used: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      saveProficiencies: { wis: true, cha: true, str: false, dex: false, con: false, int: false },
      skillProficiencies: { medicine: 1, religion: 1, insight: 1 } as never,
    },
    spells: ['cure-wounds', 'bless', 'guiding-bolt', 'spiritual-weapon', 'sacred-flame'],
    gear: ['mace', 'chain-mail', 'shield'],
  },
};

const BESTIARY = ['goblin', 'ancient-red-dragon', 'owlbear'];

async function createUser(email: string, displayName: string, passwordHash: string) {
  const user = {
    id: newId(),
    email,
    displayName,
    passwordHash,
    avatarUrl: null,
    createdAt: Date.now(),
  };
  await db.insert(users).values(user);
  return user;
}

async function grant(actorId: string, kind: 'spell' | 'item', srdId: string): Promise<boolean> {
  if (kind === 'spell') {
    const found = await db.select().from(srdSpells).where(eq(srdSpells.id, srdId)).limit(1);
    if (!found[0]) return false;
    await db.insert(items).values({
      id: newId(),
      ownerActorId: actorId,
      campaignId: null,
      type: 'spell',
      name: found[0].name,
      imageUrl: null,
      system: parseItemSystem('spell', found[0].system),
      sortOrder: 0,
      createdAt: Date.now(),
    });
    return true;
  }

  const found = await db.select().from(srdItems).where(eq(srdItems.id, srdId)).limit(1);
  if (!found[0]) return false;

  const type = found[0].itemType as ItemType;
  await db.insert(items).values({
    id: newId(),
    ownerActorId: actorId,
    campaignId: null,
    type,
    name: found[0].name,
    imageUrl: null,
    system: parseItemSystem(type, found[0].system),
    sortOrder: 0,
    createdAt: Date.now(),
  });
  return true;
}

export async function seed(): Promise<{ inviteCode: string; campaignId: string }> {
  const compendium = await db.select({ id: srdSpells.id }).from(srdSpells).limit(1);
  if (compendium.length === 0) {
    throw new Error('Compendium is empty. Run `npm run srd:import` first.');
  }

  // Remove any previous demo run. Cascades clear campaigns, actors and items.
  const existing = await db.select({ id: users.id }).from(users).where(like(users.email, `%${DEMO_DOMAIN}`));
  if (existing.length > 0) {
    await db.delete(users).where(inArray(users.id, existing.map((u) => u.id)));
    console.log(`  cleared ${existing.length} previous demo accounts`);
  }

  // One hash reused across demo accounts; Argon2 is deliberately slow.
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const dm = await createUser(`dm${DEMO_DOMAIN}`, 'Jeri (DM)', passwordHash);

  const campaign = {
    id: newId(),
    name: 'Curse of Strahd',
    description: 'The mists of Barovia close in. A demo campaign with a full party.',
    dmUserId: dm.id,
    activeSceneId: null,
    inviteCode: newInviteCode(),
    bannerUrl: null,
    createdAt: Date.now(),
  };
  await db.insert(campaigns).values(campaign);
  await db.insert(campaignMembers).values({
    campaignId: campaign.id,
    userId: dm.id,
    role: 'dm',
    joinedAt: Date.now(),
  });

  let itemCount = 0;

  for (const [email, spec] of Object.entries(PARTY)) {
    const player = await createUser(email, spec.name.split(' ')[0], passwordHash);
    await db.insert(campaignMembers).values({
      campaignId: campaign.id,
      userId: player.id,
      role: 'player',
      joinedAt: Date.now(),
    });

    const input = actorInputSchema.parse({ ...emptyActor(spec.name), ...spec.fields, name: spec.name });
    const {
      skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken, ...rest
    } = input;

    const actorId = newId();
    await db.insert(actors).values({
      id: actorId,
      ownerUserId: player.id,
      campaignId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...rest,
      skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken,
    });
    await db.insert(actorCampaigns).values({
      actorId,
      campaignId: campaign.id,
      assignedAt: Date.now(),
    });

    for (const srdId of spec.gear ?? []) if (await grant(actorId, 'item', srdId)) itemCount++;
    for (const srdId of spec.spells ?? []) if (await grant(actorId, 'spell', srdId)) itemCount++;

    console.log(`  ${spec.name.padEnd(22)} ${email}`);
  }

  // NPCs for the DM, sized from their stat blocks.
  const { srdMonsters } = await import('./db/schema.js');
  for (const monsterId of BESTIARY) {
    const found = await db.select().from(srdMonsters).where(eq(srdMonsters.id, monsterId)).limit(1);
    const monster = found[0];
    if (!monster) continue;

    const input = actorInputSchema.parse({
      ...emptyActor(monster.name, 'npc'),
      name: monster.name,
      type: 'npc',
      str: monster.str, dex: monster.dex, con: monster.con,
      int: monster.int, wis: monster.wis, cha: monster.cha,
      armorClass: monster.armorClass,
      hpCurrent: monster.hitPoints,
      hpMax: monster.hitPoints,
      hitDiceTotal: monster.hitDice,
      challengeRating: monster.challengeRating,
      race: monster.type,
      alignment: monster.alignment,
      prototypeToken: {
        w: monster.tokenSize,
        h: monster.tokenSize,
        actorLinked: false,
        disposition: 'hostile',
      },
    });
    const {
      skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken, ...rest
    } = input;

    const npcId = newId();
    await db.insert(actors).values({
      id: npcId,
      ownerUserId: dm.id,
      campaignId: campaign.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...rest,
      skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken,
    });
    await db.insert(actorCampaigns).values({
      actorId: npcId,
      campaignId: campaign.id,
      assignedAt: Date.now(),
    });

    console.log(`  NPC: ${monster.name.padEnd(17)} ${monster.tokenSize}x${monster.tokenSize} squares, CR ${monster.challengeRating}`);
  }

  console.log(`\n  ${itemCount} items and spells granted`);
  return { inviteCode: campaign.inviteCode, campaignId: campaign.id };
}

if (process.argv[1]?.includes('seed')) {
  await runMigrations();
  console.log('Seeding example campaign\n');

  const { inviteCode } = await seed();

  console.log(`\n  Campaign invite code: ${inviteCode}`);
  console.log(`\n  Sign in with any of these — password is "${DEMO_PASSWORD}":`);
  console.log(`    dm${DEMO_DOMAIN}       (Dungeon Master)`);
  for (const email of Object.keys(PARTY)) console.log(`    ${email}`);
  process.exit(0);
}
