import type { Actor } from '../db/schema.js';

/**
 * What a token inherits from the sheet behind it.
 *
 * `token:create` has always done this and `npm run seed` has always written its
 * party tokens straight into the table instead - so the seeded characters
 * carried **no armour class, no hit points and no maximum** at all. The DM's
 * goblins could not land a single blow on the party: `attackVerdict` reads a
 * creature with no AC on record as `unresolved` and claims nothing, which is
 * correct and which meant every swing at the demo party was a no-op forever.
 *
 * That is the same drift CLAUDE.md already records about the seed's NPCs, which
 * were built by hand until `stampMonster` was extracted for both callers to
 * share. This is the other half of it, and the fix is the same shape: one
 * function, called by the route and by the seed, so a field cannot be filled in
 * one place and forgotten in the other.
 *
 * Every field is `??`-guarded, so an explicit value on the wire wins and only
 * what was left unsaid is taken from the sheet.
 */
export interface TokenActorDefaults {
  name: string;
  imageUrl: string | null;
  w: number;
  h: number;
  hp: number | null;
  maxHp: number | null;
  ac: number | null;
  actorLinked: boolean;
  disposition: string;
  ownerUserId: string | null;
}

export interface TokenActorInput {
  name?: string | null;
  imageUrl?: string | null;
  /** 1 reads as "not asked for": it is the schema default, not a choice. */
  w?: number;
  h?: number;
  hp?: number | null;
  maxHp?: number | null;
  ac?: number | null;
  disposition?: string | null;
  ownerUserId?: string | null;
}

export function tokenDefaultsFromActor(
  actor: Actor,
  input: TokenActorInput = {},
): TokenActorDefaults {
  const proto = actor.prototypeToken;

  return {
    name: input.name || actor.name,
    imageUrl: input.imageUrl ?? actor.portraitUrl,
    // A size of 1 is the schema's default rather than a deliberate choice, so
    // the prototype wins there and an explicit 2 does not get overwritten.
    w: input.w !== undefined && input.w !== 1 ? input.w : (proto.w ?? 1),
    h: input.h !== undefined && input.h !== 1 ? input.h : (proto.h ?? 1),
    // An unlinked token copies hit points so each goblin tracks its own.
    hp: input.hp ?? actor.hpCurrent,
    maxHp: input.maxHp ?? actor.hpMax,
    ac: input.ac ?? actor.armorClass,
    actorLinked: proto.actorLinked ?? false,
    disposition: input.disposition ?? proto.disposition ?? 'hostile',
    // Only a character carries an owner. The server files an NPC with a null
    // one, which is what `isFairGame` and the DM's turn-order writer both read.
    ownerUserId: input.ownerUserId ?? (actor.type === 'character' ? actor.ownerUserId : null),
  };
}
