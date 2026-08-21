import { abilityModifier, proficiencyBonus, type AbilityKey, type AbilityScores } from './rules5e.js';
// Reused rather than redefined: the Zod schemas in documents.ts are the single
// definition of what an effect change looks like on the wire and in the table.
import type { DamageModifiers, EffectChange, EffectMode } from './documents.js';

/**
 * Active effects and damage resolution.
 *
 * Derived actor data is computed here and never stored, exactly like ability
 * modifiers: a buff that writes into the sheet can always be removed wrongly,
 * whereas one applied by a pure function cannot drift. Everything in this file
 * is deterministic and directly testable, which matters enormously once rules
 * interactions start multiplying.
 */

export interface ActiveEffect {
  id: string;
  name: string;
  changes: EffectChange[];
  disabled: boolean;
  /** Rounds remaining; null means it lasts until removed. */
  duration?: { rounds: number | null; startRound: number | null } | null;
  statusId?: string | null;
}

/**
 * Application order. Multiply before add is the important one: a +2 bonus
 * applied before doubling would be doubled too, which is not how any of these
 * effects are meant to read.
 */
const MODE_ORDER: Record<EffectMode, number> = {
  multiply: 0,
  add: 1,
  downgrade: 2,
  upgrade: 3,
  override: 4,
};

export interface DerivedActor {
  abilities: AbilityScores;
  ac: number;
  maxHp: number;
  speed: number;
  proficiencyBonus: number;
  /** Flags set by conditions, e.g. advantage on attacks against you. */
  flags: Record<string, boolean>;
  /** Names of every effect that contributed, for the UI to explain the total. */
  applied: string[];
}

function readPath(actor: DerivedActor, key: string): number | undefined {
  const [head, tail] = key.split('.');
  if (head === 'abilities' && tail) return actor.abilities[tail as AbilityKey];
  if (head === 'ac') return actor.ac;
  if (head === 'maxHp') return actor.maxHp;
  if (head === 'speed') return actor.speed;
  return undefined;
}

function writePath(actor: DerivedActor, key: string, value: number): void {
  const [head, tail] = key.split('.');
  if (head === 'abilities' && tail) actor.abilities[tail as AbilityKey] = value;
  else if (head === 'ac') actor.ac = value;
  else if (head === 'maxHp') actor.maxHp = value;
  else if (head === 'speed') actor.speed = value;
}

function applyMode(current: number, mode: EffectMode, value: number): number {
  switch (mode) {
    case 'add':
      return current + value;
    case 'multiply':
      return current * value;
    case 'override':
      return value;
    // "At least this much" / "at most this much" - a floor and a ceiling.
    case 'upgrade':
      return Math.max(current, value);
    case 'downgrade':
      return Math.min(current, value);
  }
}

export interface BaseActor {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
  armorClass: number;
  hpMax: number;
  speed: number;
  level: number;
}

/**
 * Folds every enabled effect over the actor's base numbers.
 *
 * Bless becomes a change on attack rolls; plate armour an override on AC; a
 * condition like `prone` a flag other rules read. Because it is one pure
 * function, "why is my AC 21?" is answerable by listing `applied`.
 */
export function deriveActor(base: BaseActor, effects: ActiveEffect[]): DerivedActor {
  const derived: DerivedActor = {
    abilities: { str: base.str, dex: base.dex, con: base.con, int: base.int, wis: base.wis, cha: base.cha },
    ac: base.armorClass,
    maxHp: base.hpMax,
    speed: base.speed,
    proficiencyBonus: proficiencyBonus(base.level),
    flags: {},
    applied: [],
  };

  const changes = effects
    .filter((effect) => !effect.disabled)
    .flatMap((effect) => effect.changes.map((change) => ({ change, name: effect.name })))
    .sort(
      (a, b) =>
        MODE_ORDER[a.change.mode] - MODE_ORDER[b.change.mode] ||
        a.change.priority - b.change.priority,
    );

  for (const { change, name } of changes) {
    if (typeof change.value === 'boolean') {
      derived.flags[change.key] = change.value;
      if (!derived.applied.includes(name)) derived.applied.push(name);
      continue;
    }

    const numeric = typeof change.value === 'number' ? change.value : Number(change.value);
    if (Number.isNaN(numeric)) continue;

    const current = readPath(derived, change.key);
    if (current === undefined) continue;

    writePath(derived, change.key, applyMode(current, change.mode, numeric));
    if (!derived.applied.includes(name)) derived.applied.push(name);
  }

  return derived;
}

/* ---------------------------------------------------------------- damage */

export interface DamageResult {
  applied: number;
  /** How the raw number was changed, for the chat card to explain itself. */
  reason: 'normal' | 'resistant' | 'vulnerable' | 'immune';
  hpBefore: number;
  hpAfter: number;
  tempAbsorbed: number;
  tempAfter: number;
}

function matches(list: string[], type: string): boolean {
  const needle = type.trim().toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === needle);
}

/**
 * Applies damage of a type to a creature.
 *
 * 5e order: immunity wins outright, then resistance halves (rounding down),
 * then vulnerability doubles. Temporary hit points absorb what is left before
 * real hit points are touched.
 */
export function applyDamage(
  target: { hp: number; maxHp: number; tempHp?: number },
  amount: number,
  damageType: string,
  modifiers: Partial<DamageModifiers> = {},
): DamageResult {
  const resistances = modifiers.resistances ?? [];
  const vulnerabilities = modifiers.vulnerabilities ?? [];
  const immunities = modifiers.immunities ?? [];

  const temp = target.tempHp ?? 0;
  const raw = Math.max(0, Math.floor(amount));

  let reason: DamageResult['reason'] = 'normal';
  let total = raw;

  if (matches(immunities, damageType)) {
    total = 0;
    reason = 'immune';
  } else if (matches(resistances, damageType)) {
    // Halved and rounded down, per the PHB.
    total = Math.floor(raw / 2);
    reason = 'resistant';
  } else if (matches(vulnerabilities, damageType)) {
    total = raw * 2;
    reason = 'vulnerable';
  }

  const tempAbsorbed = Math.min(temp, total);
  const toHp = total - tempAbsorbed;
  const hpAfter = Math.max(0, target.hp - toHp);

  return {
    applied: total,
    reason,
    hpBefore: target.hp,
    hpAfter,
    tempAbsorbed,
    tempAfter: temp - tempAbsorbed,
  };
}

export function applyHealing(
  target: { hp: number; maxHp: number },
  amount: number,
): { hpBefore: number; hpAfter: number; healed: number } {
  const healed = Math.max(0, Math.floor(amount));
  // Healing never exceeds the maximum, and never revives from a negative.
  const hpAfter = Math.min(target.maxHp, target.hp + healed);
  return { hpBefore: target.hp, hpAfter, healed: hpAfter - target.hp };
}

/* -------------------------------------------------------- concentration */

/**
 * The DC to hold concentration after taking damage: 10, or half the damage
 * taken, whichever is higher.
 */
export function concentrationDC(damage: number): number {
  return Math.max(10, Math.floor(damage / 2));
}

export function concentrationSave(
  scores: AbilityScores,
  level: number,
  proficient: boolean,
): { expression: string; modifier: number } {
  const modifier = abilityModifier(scores.con) + (proficient ? proficiencyBonus(level) : 0);
  return {
    expression: modifier >= 0 ? `1d20+${modifier}` : `1d20${modifier}`,
    modifier,
  };
}

/* ------------------------------------------------------------ conditions */

/**
 * The 5e conditions expressed as effects, so applying "prone" changes the
 * derived actor rather than being a label the DM has to remember to enforce.
 */
export const CONDITION_EFFECTS: Record<string, EffectChange[]> = {
  prone: [
    { key: 'flags.disadvantageOnAttacks', mode: 'override', value: true, priority: 20 },
    { key: 'speed', mode: 'multiply', value: 0.5, priority: 20 },
  ],
  restrained: [
    { key: 'speed', mode: 'override', value: 0, priority: 20 },
    { key: 'flags.disadvantageOnAttacks', mode: 'override', value: true, priority: 20 },
    { key: 'flags.disadvantageOnDexSaves', mode: 'override', value: true, priority: 20 },
  ],
  grappled: [{ key: 'speed', mode: 'override', value: 0, priority: 20 }],
  paralyzed: [
    { key: 'speed', mode: 'override', value: 0, priority: 20 },
    { key: 'flags.incapacitated', mode: 'override', value: true, priority: 20 },
    { key: 'flags.autoFailStrDexSaves', mode: 'override', value: true, priority: 20 },
  ],
  stunned: [
    { key: 'speed', mode: 'override', value: 0, priority: 20 },
    { key: 'flags.incapacitated', mode: 'override', value: true, priority: 20 },
  ],
  unconscious: [
    { key: 'speed', mode: 'override', value: 0, priority: 20 },
    { key: 'flags.incapacitated', mode: 'override', value: true, priority: 20 },
    { key: 'flags.blinded', mode: 'override', value: true, priority: 20 },
  ],
  poisoned: [{ key: 'flags.disadvantageOnAttacks', mode: 'override', value: true, priority: 20 }],
  frightened: [{ key: 'flags.disadvantageOnAttacks', mode: 'override', value: true, priority: 20 }],
  // Blinded means blinded. `flags.blinded` collapses the token's sight radius
  // to nothing, so the player learns nothing new and opens no fog - rather
  // than the condition being a label the DM has to remember to enforce.
  blinded: [
    { key: 'flags.disadvantageOnAttacks', mode: 'override', value: true, priority: 20 },
    { key: 'flags.blinded', mode: 'override', value: true, priority: 20 },
  ],
  invisible: [{ key: 'flags.advantageOnAttacks', mode: 'override', value: true, priority: 20 }],
  // Petrified and unconscious creatures are unaware of their surroundings,
  // which is the handbook's way of saying they cannot see either.
  petrified: [
    { key: 'speed', mode: 'override', value: 0, priority: 20 },
    { key: 'flags.incapacitated', mode: 'override', value: true, priority: 20 },
    { key: 'flags.blinded', mode: 'override', value: true, priority: 20 },
  ],
};

/**
 * What each condition does, in one line, from the SRD.
 *
 * Prose, not mechanics: `CONDITION_EFFECTS` above is what the engine applies,
 * and this is what a person needs to read at the table. Kept beside it so the
 * two are edited together, and deliberately not merged into it - a condition
 * the app does not automate still has to be explainable, which is most of the
 * point.
 */
export const CONDITION_SUMMARY: Record<string, string> = {
  blinded: 'Cannot see, and automatically fails any check needing sight. Attacks against it have advantage; its own attacks have disadvantage.',
  charmed: 'Cannot attack the charmer or target them with harmful effects. The charmer has advantage on social checks against it.',
  deafened: 'Cannot hear, and automatically fails any check needing hearing.',
  exhaustion: 'Six levels, each worse than the last: disadvantage on checks, then half speed, then disadvantage on attacks and saves, then half hit points, then speed 0, then death.',
  frightened: 'Disadvantage on attacks and checks while the source is in sight, and it cannot willingly move closer to it.',
  grappled: 'Speed 0. Ends if the grappler is incapacitated, or if it is moved out of reach.',
  incapacitated: 'No actions, no bonus actions, no reactions.',
  invisible: 'Cannot be seen without magic or a special sense. Attacks against it have disadvantage; its own attacks have advantage.',
  paralyzed: 'Incapacitated, cannot move or speak, and fails STR and DEX saves automatically. Attacks against it have advantage, and any hit from within 5 ft is a critical.',
  petrified: 'Turned to stone: incapacitated, unaware, and resistant to all damage. Attacks against it have advantage.',
  poisoned: 'Disadvantage on attack rolls and ability checks.',
  prone: 'Movement costs double to crawl. Its attacks have disadvantage; attacks against it have advantage within 5 ft and disadvantage beyond.',
  restrained: 'Speed 0, disadvantage on its attacks and DEX saves. Attacks against it have advantage.',
  stunned: 'Incapacitated, cannot move, speaks only falteringly, and fails STR and DEX saves. Attacks against it have advantage.',
  unconscious: 'Incapacitated, prone, unaware, and drops what it holds. Fails STR and DEX saves; attacks against it have advantage and any hit from within 5 ft is a critical.',
  concentrating: 'Holding a spell. Taking damage forces a Constitution save, DC 10 or half the damage, whichever is higher.',
};

/**
 * Whether the app enforces a condition's mechanics, or leaves them to the DM.
 *
 * Derived from `CONDITION_EFFECTS` rather than written down a second time, so
 * it cannot claim automation that does not exist. Five conditions have no
 * entry - charmed, deafened, exhaustion, incapacitated and concentrating -
 * because what they do is about intent and fiction rather than a number the
 * server can fold in, and saying so is better than pretending.
 */
export function conditionIsAutomated(condition: string): boolean {
  return Boolean(CONDITION_EFFECTS[condition]);
}

export function conditionEffect(condition: string): ActiveEffect | null {
  const changes = CONDITION_EFFECTS[condition];
  if (!changes) return null;

  return {
    id: `condition:${condition}`,
    name: condition.charAt(0).toUpperCase() + condition.slice(1),
    changes,
    disabled: false,
    statusId: condition,
  };
}

/* -------------------------------------------------------------- initiative */

export interface InitiativeRow {
  id: string;
  name: string;
  initiative: number;
  /** Higher DEX wins ties, per the PHB tiebreaker. */
  dexterity?: number;
  /** Still waiting on whoever runs this creature to roll it. */
  pending?: boolean;
}

/**
 * Descending initiative, breaking ties on DEX and then stably by name.
 *
 * Anything still waiting to be rolled sorts last, and explicitly rather than by
 * leaning on its stored `0`: a Dexterity of 1 is a -5 modifier, so that
 * character rolling a 1 scores -4 and would otherwise be placed below somebody
 * who has not rolled at all.
 */
export function sortInitiative<T extends InitiativeRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.pending ?? false) - Number(b.pending ?? false) ||
      b.initiative - a.initiative ||
      (b.dexterity ?? 0) - (a.dexterity ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

/** Advances the turn, rolling over into the next round at the end of the order. */
export function advanceTurn(
  activeIndex: number,
  round: number,
  count: number,
): { activeIndex: number; round: number } {
  if (count <= 0) return { activeIndex: 0, round };
  const next = activeIndex + 1;
  return next >= count ? { activeIndex: 0, round: round + 1 } : { activeIndex: next, round };
}

export function rewindTurn(
  activeIndex: number,
  round: number,
  count: number,
): { activeIndex: number; round: number } {
  if (count <= 0) return { activeIndex: 0, round };
  if (activeIndex > 0) return { activeIndex: activeIndex - 1, round };
  // Stepping back past the top of the order returns to the previous round.
  return { activeIndex: count - 1, round: Math.max(1, round - 1) };
}

/** Effects whose duration has run out by the given round. */
export function expiredEffects(effects: ActiveEffect[], round: number): ActiveEffect[] {
  return effects.filter((effect) => {
    const duration = effect.duration;
    if (!duration || duration.rounds === null || duration.startRound === null) return false;
    return round >= duration.startRound + duration.rounds;
  });
}


/* ------------------------------------------------- conditions on a token */

/**
 * Anything carrying conditions and the two numbers they can change.
 *
 * Structural rather than `Pick<WireToken, ...>` so the server's database row
 * and the client's wire token both satisfy it without this module having to
 * know about either.
 */
export interface ConditionHolder {
  conditions: string[];
  ac?: number | null;
  maxHp?: number | null;
}

export interface TokenDerived extends DerivedActor {
  /** Conditions that produced a change, for the "why" line in the UI. */
  reasons: string[];
  hasDisadvantage: boolean;
  hasAdvantage: boolean;
  incapacitated: boolean;
  /** Cannot see at all: sight radius collapses to nothing. */
  blinded: boolean;
}

export function effectsForToken(token: ConditionHolder): ActiveEffect[] {
  return token.conditions
    .map((condition) => conditionEffect(condition))
    .filter((effect): effect is ActiveEffect => effect !== null);
}

/**
 * Derived stats for a token, given a base speed and AC.
 *
 * Tokens carry AC but not the full ability spread, so the missing pieces are
 * filled with neutral values - the conditions we model only touch speed, AC
 * and flags, so nothing downstream depends on them.
 *
 * This lives in the shared package rather than on either side because the
 * server is the authority for vision, movement and every roll, while the
 * client draws the HUD that has to agree with it. Two copies drifted once
 * already: the HUD showed a paralyzed token Speed 0 while the server offered
 * it the full 30 ft of movement range.
 */
export function deriveToken(token: ConditionHolder, baseSpeed = 30, level = 1): TokenDerived {
  const effects = effectsForToken(token);

  const derived = deriveActor(
    {
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
      armorClass: token.ac ?? 10,
      hpMax: token.maxHp ?? 0,
      speed: baseSpeed,
      level,
    },
    effects,
  );

  return {
    ...derived,
    reasons: derived.applied,
    hasDisadvantage: Boolean(derived.flags['flags.disadvantageOnAttacks']),
    hasAdvantage: Boolean(derived.flags['flags.advantageOnAttacks']),
    incapacitated: Boolean(derived.flags['flags.incapacitated']),
    blinded: Boolean(derived.flags['flags.blinded']),
  };
}

/**
 * How an attack from `attacker` against `target` should be rolled.
 *
 * 5e cancels advantage and disadvantage against each other rather than
 * stacking them, so a prone attacker striking an invisible target rolls
 * straight - which is exactly the sort of interaction a table gets wrong.
 */
export function attackModeAgainst(
  attacker: ConditionHolder,
  target: ConditionHolder,
): { mode: 'normal' | 'advantage' | 'disadvantage'; reasons: string[] } {
  const self = deriveToken(attacker);
  const other = deriveToken(target);

  const reasons: string[] = [];
  let advantage = false;
  let disadvantage = false;

  if (self.hasDisadvantage) {
    disadvantage = true;
    reasons.push(`you are ${attacker.conditions.join(', ')}`);
  }
  // An invisible target is harder to hit.
  if (other.hasAdvantage) {
    disadvantage = true;
    reasons.push('target is invisible');
  }
  // A prone target is easier to hit in melee.
  if (target.conditions.includes('prone')) {
    advantage = true;
    reasons.push('target is prone');
  }
  if (target.conditions.includes('paralyzed') || target.conditions.includes('unconscious')) {
    advantage = true;
    reasons.push('target is helpless');
  }

  if (advantage && disadvantage) return { mode: 'normal', reasons: [...reasons, 'they cancel out'] };
  if (advantage) return { mode: 'advantage', reasons };
  if (disadvantage) return { mode: 'disadvantage', reasons };
  return { mode: 'normal', reasons: [] };
}

/**
 * Folds several sources of advantage and disadvantage into one roll.
 *
 * 5e does not stack them: any number of advantages is still one advantage, and
 * a single disadvantage cancels the lot. So a prone target (advantage) shot at
 * long range (disadvantage) is rolled straight.
 *
 * This exists because the two halves arrive from different places - conditions
 * are recomputed on the server, while range and any circumstantial call the
 * player makes come from the client - and combining them anywhere else would
 * mean whichever arrived second silently won.
 */
export function combineRollModes(
  ...modes: ('normal' | 'advantage' | 'disadvantage')[]
): 'normal' | 'advantage' | 'disadvantage' {
  const advantage = modes.includes('advantage');
  const disadvantage = modes.includes('disadvantage');

  if (advantage && disadvantage) return 'normal';
  if (advantage) return 'advantage';
  if (disadvantage) return 'disadvantage';
  return 'normal';
}

/* --------------------------------------------------------- combat clock */

/** A round of combat is six seconds of the world, by the handbook. */
export const SECONDS_PER_ROUND = 6;

/**
 * How long a fight has taken, in the world rather than at the table.
 *
 * Derived from the round and stored nowhere, like every other computed value
 * here - rounds only advance in a fight, so there is nothing to tick and
 * nothing to keep in sync.
 *
 * Round 1 is the *first* six seconds, not six seconds already spent, so a fight
 * that has just started reads zero. Two full rounds is twelve.
 */
export function combatSeconds(round: number): number {
  return Math.max(0, round - 1) * SECONDS_PER_ROUND;
}

/**
 * That number as somebody would say it out loud.
 *
 * Seconds while a fight is short, because "18 seconds" is the answer a player
 * wants when they ask whether the door held. Minutes once it is long enough
 * that counting seconds stops meaning anything.
 */
export function formatCombatTime(round: number): string {
  const total = combatSeconds(round);
  if (total < 60) return `${total} seconds in`;

  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s in`;
}
