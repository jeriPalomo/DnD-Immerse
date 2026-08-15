import type { Disposition } from './documents.js';

/**
 * Colours that identify who did something.
 *
 * Derived from ids rather than stored, so every character has one the moment it
 * exists and client and server always agree without a round trip. If the table
 * ever wants to choose them, this becomes the fallback for an unset column.
 */

/** Fixed so a colour stays legible against a dark map at any hue. */
const SATURATION = 70;
const LIGHTNESS = 62;

/** The DM speaks as the table itself, so they get one colour, not a hashed one. */
export const DM_COLOR = '#e8853f';

/** A stable colour for a character, spread around the wheel by its id. */
export function actorColor(actorId: string): string {
  let hue = 0;
  for (let i = 0; i < actorId.length; i += 1) {
    hue = (hue * 31 + actorId.charCodeAt(i)) % 360;
  }
  return `hsl(${hue} ${SATURATION}% ${LIGHTNESS}%)`;
}

/**
 * Allegiance, the way a tactics game reads it: your units, your allies, and
 * what is trying to kill you.
 *
 * `friendly` is the party. `neutral` covers allies and temporary allies - the
 * hired mercenary, the guard captain who fights alongside you this once - and
 * is deliberately NOT a threat. `hostile` is the only thing the threat overlay
 * paints.
 *
 * Shared because the ring, the token pip and the movement overlay all have to
 * agree; three copies of a colour map is three chances to drift.
 */
export const DISPOSITION_COLOR = {
  friendly: '#8b7bf0',
  neutral: '#34d399',
  hostile: '#f87171',
} as const satisfies Record<Disposition, string>;

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  friendly: 'Ally',
  neutral: 'Neutral',
  hostile: 'Hostile',
};

export const DISPOSITION_HINT: Record<Disposition, string> = {
  friendly: 'the party',
  neutral: 'an ally, or an ally for now — never counted as a threat',
  hostile: 'an enemy — the only thing the threat range covers',
};

export const DISPOSITIONS = (['friendly', 'neutral', 'hostile'] as const).map((value) => ({
  value,
  label: DISPOSITION_LABEL[value],
  color: DISPOSITION_COLOR[value],
}));
