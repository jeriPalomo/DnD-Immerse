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
