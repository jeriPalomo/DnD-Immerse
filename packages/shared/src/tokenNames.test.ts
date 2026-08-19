import { describe, expect, it } from 'vitest';
import { nextTokenName } from './schemas.js';

describe('numbering repeated creatures', () => {
  it('leaves the first of a kind unnumbered', () => {
    expect(nextTokenName('Goblin', [])).toBe('Goblin');
    expect(nextTokenName('Goblin', ['Owlbear', 'Thorin'])).toBe('Goblin');
  });

  it('numbers the second and counts on from there', () => {
    expect(nextTokenName('Goblin', ['Goblin'])).toBe('Goblin 2');
    expect(nextTokenName('Goblin', ['Goblin', 'Goblin 2'])).toBe('Goblin 3');
  });

  it('continues from the highest, not the count - killing one must not reuse its name', () => {
    // "Goblin 2" died and was removed; the next must be 4, or the initiative
    // order gains a second "Goblin 3".
    expect(nextTokenName('Goblin', ['Goblin', 'Goblin 3'])).toBe('Goblin 4');
  });

  it('does not confuse one creature for another that merely starts the same', () => {
    expect(nextTokenName('Goblin', ['Goblin Boss', 'Goblin Boss 2'])).toBe('Goblin');
    expect(nextTokenName('Goblin Boss', ['Goblin', 'Goblin 2'])).toBe('Goblin Boss');
  });

  it('survives a name with regex metacharacters in it', () => {
    // Free text: a DM types whatever they like, and an unescaped "(" would
    // throw while "." would match any character.
    expect(nextTokenName('Kobold (scout)', ['Kobold (scout)'])).toBe('Kobold (scout) 2');
    expect(nextTokenName('A.B', ['AxB'])).toBe('A.B');
  });

  it('ignores case and stray whitespace, the way a DM retyping a name would', () => {
    expect(nextTokenName('goblin', ['Goblin'])).toBe('goblin 2');
    expect(nextTokenName('Goblin', ['  Goblin  '])).toBe('Goblin 2');
  });

  it('falls back rather than producing a nameless token', () => {
    expect(nextTokenName('   ', [])).toBe('Token');
  });
});
