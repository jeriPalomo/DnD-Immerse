import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Ambiguous glyphs removed so codes can be read aloud over voice chat.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function fromAlphabet(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Primary keys. 21 chars of base62 is comfortably collision-free here. */
export function newId(): string {
  return fromAlphabet(ALPHABET, 21);
}

/** Campaign invite codes, shaped to be dictated out loud. */
export function newInviteCode(): string {
  return fromAlphabet(CODE_ALPHABET, 8);
}
