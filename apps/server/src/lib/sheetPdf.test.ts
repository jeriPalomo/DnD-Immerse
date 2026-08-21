import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { readCharacterPdf } from './sheetPdf.js';

/**
 * Built here rather than checked in as a binary.
 *
 * A real fillable sheet is a copyrighted 300KB file, and the thing under test is
 * "does it read named AcroForm fields", which a document with the same field
 * names answers exactly. The names are the official sheet's, trailing spaces
 * and all - `Race ` and `PersonalityTraits ` really are spelled that way, and
 * that is precisely the sort of detail a fixture written from memory loses.
 */
async function sheetWith(fields: Record<string, string>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  let y = 760;
  for (const [name, value] of Object.entries(fields)) {
    const box = form.createTextField(name);
    box.setText(value);
    box.addToPage(page, { x: 20, y, width: 200, height: 16 });
    y -= 20;
  }

  return Buffer.from(await doc.save());
}

describe('reading a fillable character sheet', () => {
  it('takes the plain fields straight off the form', async () => {
    const pdf = await sheetWith({
      CharacterName: 'Thorin Oakenshield',
      'Race ': 'Dwarf',
      Background: 'Soldier',
      Alignment: 'Lawful Good',
    });

    const { values } = await readCharacterPdf(pdf);
    expect(values.name).toBe('Thorin Oakenshield');
    expect(values.race).toBe('Dwarf');
    expect(values.background).toBe('Soldier');
    expect(values.alignment).toBe('Lawful Good');
  });

  it('splits "Fighter 5" into a class and a level', async () => {
    const { values } = await readCharacterPdf(await sheetWith({ ClassLevel: 'Fighter 5' }));
    expect(values.className).toBe('Fighter');
    expect(values.level).toBe(5);
  });

  it('takes the first class of a multiclass rather than refusing', async () => {
    const { values } = await readCharacterPdf(await sheetWith({ ClassLevel: 'Wizard 3' }));
    expect(values.className).toBe('Wizard');
    expect(values.level).toBe(3);
  });

  it('reads ability scores', async () => {
    const pdf = await sheetWith({ STR: '16', DEX: '12', CON: '15', INT: '10', WIS: '13', CHA: '8' });
    const { values } = await readCharacterPdf(pdf);
    expect(values).toMatchObject({ str: 16, dex: 12, con: 15, int: 10, wis: 13, cha: 8 });
  });

  it('refuses a modifier where a score belongs', async () => {
    // Some sheets are filled in with "+3" in the big box. Taking that as a
    // score would quietly hand somebody Strength 3, which is the kind of
    // confidently wrong this whole import is trying not to be.
    const { values } = await readCharacterPdf(await sheetWith({ STR: '+3' }));
    expect(values.str).toBeUndefined();
  });

  it('reads a score written as "16 (+3)"', async () => {
    const { values } = await readCharacterPdf(await sheetWith({ STR: '16 (+3)' }));
    expect(values.str).toBe(16);
  });

  it('ignores a score outside what a character can have', async () => {
    expect((await readCharacterPdf(await sheetWith({ STR: '99' }))).values.str).toBeUndefined();
    expect((await readCharacterPdf(await sheetWith({ STR: '0' }))).values.str).toBeUndefined();
  });

  it('never imports current hit points above the maximum', async () => {
    // A typo on the sheet would otherwise overflow the bar on every screen.
    const { values } = await readCharacterPdf(await sheetWith({ HPMax: '47', HPCurrent: '90' }));
    expect(values.hpMax).toBe(47);
    expect(values.hpCurrent).toBe(47);
  });

  it('reads the characteristics, trailing space in the field name and all', async () => {
    const pdf = await sheetWith({
      'PersonalityTraits ': 'Speaks plainly.',
      Ideals: 'Honour.',
      Bonds: 'My axe.',
      Flaws: 'Cannot pass a locked door.',
    });
    const { values } = await readCharacterPdf(pdf);
    expect(values).toMatchObject({
      personalityTraits: 'Speaks plainly.',
      ideals: 'Honour.',
      bonds: 'My axe.',
      flaws: 'Cannot pass a locked door.',
    });
  });

  it('names the fields it made no use of', async () => {
    const pdf = await sheetWith({ CharacterName: 'Thorin', Wpn1: 'Handaxe', 'Spells 1014': 'Shield' });
    const { unread, fieldCount } = await readCharacterPdf(pdf);
    expect(fieldCount).toBe(3);
    // Weapons and spells are not imported yet, and saying so is the point: an
    // import that silently drops half a sheet teaches you to trust it about
    // the other half.
    expect(unread).toContain('Wpn1');
    expect(unread).toContain('Spells 1014');
    expect(unread).not.toContain('CharacterName');
  });

  it('leaves out anything the sheet left blank', async () => {
    const { values } = await readCharacterPdf(await sheetWith({ CharacterName: 'Thorin', Ideals: '   ' }));
    expect(values.name).toBe('Thorin');
    expect(values.ideals).toBeUndefined();
  });

  it('refuses a PDF with no form fields, and says why', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const flattened = Buffer.from(await doc.save());

    await expect(readCharacterPdf(flattened)).rejects.toMatchObject({ status: 400 });
    await expect(readCharacterPdf(flattened)).rejects.toThrow(/fillable/i);
  });

  it('refuses something that is not a PDF at all', async () => {
    await expect(readCharacterPdf(Buffer.from('Dear diary, I am not a PDF.'))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses an empty file rather than throwing something opaque', async () => {
    await expect(readCharacterPdf(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
  });
});
