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
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db } from './db/index.js';
import {
  actorCampaigns,
  actors,
  campaignMembers,
  campaigns,
  items,
  scenes,
  srdItems,
  srdMonsters,
  srdSpells,
  tokens,
  users,
  walls,
} from './db/schema.js';
import { runMigrations } from './db/migrate.js';
import { hashPassword } from './auth/password.js';
import { ensureDataDirs, paths } from './env.js';
import { stampMonster } from './routes/actors.js';
import { newId, newInviteCode } from './lib/id.js';

/**
 * The demo scene: two rooms, a corridor, a door, and goblins behind it.
 *
 * A campaign with no scene lands every visitor on "No active scene", which is
 * the correct message and a poor first impression - the battle map is the thing
 * worth showing, and it was the one thing `npm run seed` did not build. This
 * makes `npm run playtest` a table somebody can actually play a round on.
 *
 * The map is drawn here rather than shipped as a binary: an SVG rasterised by
 * the same `sharp` the upload route already uses, so there is no asset to keep
 * in the repository and it always matches the grid it is calibrated to.
 */
const GRID = 70;
const COLUMNS = 20;
const ROWS = 14;

function dungeonSvg(): string {
  const w = COLUMNS * GRID;
  const h = ROWS * GRID;

  /** One room, in grid squares, drawn as flagstones inside a wall line. */
  const room = (x: number, y: number, cols: number, rows: number) => `
    <rect x="${x * GRID}" y="${y * GRID}" width="${cols * GRID}" height="${rows * GRID}"
          fill="#3a3630" stroke="#15130f" stroke-width="6" />
    ${Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => {
        // A little variation, deterministic so the map is the same every run.
        const shade = ((x + c) * 7 + (y + r) * 13) % 5;
        return `<rect x="${(x + c) * GRID + 2}" y="${(y + r) * GRID + 2}"
                      width="${GRID - 4}" height="${GRID - 4}"
                      fill="#4a453d" opacity="${0.35 + shade * 0.05}" />`;
      }).join(''),
    ).join('')}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#14120f" />
    ${room(1, 1, 7, 5)}
    ${room(12, 1, 7, 5)}
    ${room(6, 8, 8, 5)}
    <rect x="${8 * GRID}" y="${3 * GRID}" width="${4 * GRID}" height="${GRID}"
          fill="#3a3630" stroke="#15130f" stroke-width="4" />
    <rect x="${9 * GRID}" y="${4 * GRID}" width="${GRID}" height="${4 * GRID}"
          fill="#3a3630" stroke="#15130f" stroke-width="4" />
  </svg>`;
}

/**
 * Writes the map, the scene, its walls and the creatures standing on it.
 *
 * Walls are laid on the rooms' own edges so dynamic vision has something to do -
 * the party starts in the west room and cannot see the goblins in the east one
 * until somebody opens the door between them.
 */
async function buildScene(
  campaignId: string,
  party: { actorId: string; ownerUserId: string; name: string }[],
  goblinActorId: string | null,
): Promise<void> {
  ensureDataDirs();

  // A fixed name, so re-seeding overwrites it rather than leaving a new PNG
  // behind on every run. Only this scene ever points at it, and the seed is
  // documented as idempotent.
  const file = 'demo-crypt.png';
  const onDisk = path.join(paths.uploads, 'maps', file);
  await sharp(Buffer.from(dungeonSvg())).png().toFile(onDisk);
  const { width = 0, height = 0 } = await sharp(onDisk).metadata();

  const sceneId = newId();
  await db.insert(scenes).values({
    id: sceneId,
    campaignId,
    name: 'The Sunken Crypt',
    mapImageUrl: `/uploads/maps/${file}`,
    mapWidth: width,
    mapHeight: height,
    gridSize: GRID,
    // On, because it is the feature worth showing and the walls below exist to
    // make it visible. The door is what makes the point: shut, the east room is
    // dark; opened, the goblins appear.
    visionEnabled: true,
    globalIllumination: false,
  } as never);

  // Room edges, with a door in the corridor between west and east.
  const segments: [number, number, number, number, 'wall' | 'door'][] = [
    // West room
    [1, 1, 8, 1, 'wall'], [1, 1, 1, 6, 'wall'], [1, 6, 8, 6, 'wall'],
    [8, 1, 8, 3, 'wall'], [8, 4, 8, 6, 'wall'],
    // East room
    [12, 1, 19, 1, 'wall'], [19, 1, 19, 6, 'wall'], [12, 6, 19, 6, 'wall'],
    [12, 1, 12, 3, 'wall'], [12, 4, 12, 6, 'wall'],
    // The corridor between them, with the door in the middle of it
    [8, 3, 12, 3, 'wall'], [8, 4, 9, 4, 'wall'], [10, 4, 12, 4, 'wall'],
    [10, 3, 10, 4, 'door'],
    // South room
    [6, 8, 14, 8, 'wall'], [6, 8, 6, 13, 'wall'], [14, 8, 14, 13, 'wall'],
    [6, 13, 14, 13, 'wall'],
  ];

  for (const [x1, y1, x2, y2, kind] of segments) {
    await db.insert(walls).values({
      id: newId(), sceneId, x1, y1, x2, y2,
      door: kind === 'door' ? 1 : 0,
    } as never);
  }

  // The party, in the west room, each token owned by its player so they can
  // move it - and carrying a torch, since the scene is unlit.
  let column = 0;
  for (const member of party) {
    await db.insert(tokens).values({
      id: newId(),
      sceneId,
      actorId: member.actorId,
      actorLinked: true,
      ownerUserId: member.ownerUserId,
      name: member.name,
      x: 2 + column,
      y: 3,
      disposition: 'friendly',
      visionRange: 60,
      darkvisionRange: 30,
      lightBright: 20,
      lightDim: 20,
    } as never);
    column += 1;
  }

  // Goblins in the east room, behind the shut door.
  if (goblinActorId) {
    const spots: [number, number][] = [[14, 2], [16, 3], [15, 4]];
    for (const [index, [x, y]] of spots.entries()) {
      await db.insert(tokens).values({
        id: newId(),
        sceneId,
        actorId: goblinActorId,
        actorLinked: false,
        name: index === 0 ? 'Goblin' : `Goblin ${index + 1}`,
        x, y,
        hp: 7, maxHp: 7, ac: 15,
        disposition: 'hostile',
        visionRange: 60,
        darkvisionRange: 60,
      } as never);
    }
  }

  await db.update(campaigns).set({ activeSceneId: sceneId }).where(eq(campaigns.id, campaignId));
  console.log(`\n  Scene: The Sunken Crypt — ${COLUMNS}x${ROWS} squares, ${segments.length} walls, vision on`);
}

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
  /** The characters that will stand on the demo map, and who may move them. */
  const onBoard: { actorId: string; ownerUserId: string; name: string }[] = [];

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
      // Caught up to where they start, for the same reason the migration
      // catches everybody else up: these four have notionally been level 5 for
      // a while, and greeting the demo with five levels of features to read is
      // not what the panel is for.
      levelAcknowledged: rest.level,
      skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken,
    });
    await db.insert(actorCampaigns).values({
      actorId,
      campaignId: campaign.id,
      assignedAt: Date.now(),
    });

    for (const srdId of spec.gear ?? []) if (await grant(actorId, 'item', srdId)) itemCount++;
    for (const srdId of spec.spells ?? []) if (await grant(actorId, 'spell', srdId)) itemCount++;

    onBoard.push({ actorId, ownerUserId: player.id, name: spec.name });
    console.log(`  ${spec.name.padEnd(22)} ${email}`);
  }

  // NPCs for the DM, through the very same path the bestiary button uses.
  //
  // This used to build them by hand and had drifted badly: no portrait, no
  // `srdMonsterId` - so their stat blocks were editable when a real stamped one
  // is not - and no actions at all, which is exactly the empty attack table the
  // stamping exists to prevent. The demo taught the opposite of how the app
  // behaves, which is worse than having no demo.
  let goblinActorId: string | null = null;
  for (const monsterId of BESTIARY) {
    const found = await db.select().from(srdMonsters).where(eq(srdMonsters.id, monsterId)).limit(1);
    const monster = found[0];
    if (!monster) continue;

    const actor = await stampMonster(monster, campaign.id, dm.id);
    if (monster.name === 'Goblin') goblinActorId = actor.id;

    console.log(`  NPC: ${monster.name.padEnd(17)} ${monster.tokenSize}x${monster.tokenSize} squares, CR ${monster.challengeRating}`);
  }

  console.log(`\n  ${itemCount} items and spells granted`);

  // A map with something on it. Without this the demo opens on "No active
  // scene", which is the correct message and a poor first impression.
  await buildScene(campaign.id, onBoard, goblinActorId);

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
