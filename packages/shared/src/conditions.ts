/**
 * Compact glyphs for the conditions, so the board can be read at a glance
 * instead of clicking each token to find out who is suffering what.
 *
 * Single characters rather than icon assets: they scale with the token, need
 * no loading, and stay legible when the map is zoomed out.
 */
export const CONDITION_GLYPH: Record<string, string> = {
  blinded: '👁',
  charmed: '♥',
  deafened: '♪',
  exhaustion: '▼',
  frightened: '!',
  grappled: '✊',
  incapacitated: '✕',
  invisible: '◌',
  paralyzed: '⚡',
  petrified: '◆',
  poisoned: '☠',
  prone: '⤓',
  restrained: '⛓',
  stunned: '★',
  unconscious: '💤',
  concentrating: '◈',
};

/** How many fit around a token before the rest collapse into a count. */
export const MAX_TOKEN_GLYPHS = 5;

export interface TokenBadges {
  glyphs: { condition: string; glyph: string }[];
  /** Conditions beyond the cap, shown as "+n". */
  overflow: number;
}

/**
 * The badges to draw on a token.
 *
 * Capped, because a creature with nine conditions would otherwise be a ring of
 * unreadable symbols — and at that point the count is the useful information.
 */
export function tokenBadges(conditions: string[]): TokenBadges {
  const known = conditions.filter((condition) => CONDITION_GLYPH[condition]);

  return {
    glyphs: known.slice(0, MAX_TOKEN_GLYPHS).map((condition) => ({
      condition,
      glyph: CONDITION_GLYPH[condition],
    })),
    overflow: Math.max(0, known.length - MAX_TOKEN_GLYPHS),
  };
}

/** A creature at zero hit points reads differently on the board. */
export function isDown(hp: number | null, maxHp: number | null): boolean {
  return maxHp !== null && maxHp > 0 && (hp ?? 0) <= 0;
}
