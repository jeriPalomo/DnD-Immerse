import { PDFDocument } from 'pdf-lib';
import { HttpError } from '../auth/guards.js';

/**
 * Reads a filled-in character sheet PDF.
 *
 * The official sheet is an AcroForm: every box is a named form field, so this
 * reads values rather than guessing at text positions. That is the whole reason
 * only fillable sheets are supported - a flattened export has the same words on
 * the page with nothing to say which box they were in, and inferring it from
 * coordinates produces a sheet that is wrong in ways nobody checks.
 *
 * Nothing here writes to an actor. It reports what it found and what it could
 * not read, and the player confirms - the same rule the ability roller follows,
 * where seeing the numbers before keeping them is the point.
 */

/** What we understand, and the field names the official sheet uses for it. */
const FIELDS: Record<string, string[]> = {
  name: ['CharacterName', 'CharacterName 2'],
  classLevel: ['ClassLevel'],
  race: ['Race '],
  background: ['Background'],
  alignment: ['Alignment'],
  str: ['STR'],
  dex: ['DEX'],
  con: ['CON'],
  int: ['INT'],
  wis: ['WIS'],
  cha: ['CHA'],
  armorClass: ['AC'],
  speed: ['Speed'],
  hpMax: ['HPMax'],
  hpCurrent: ['HPCurrent'],
  hitDice: ['HDTotal', 'HD'],
  personalityTraits: ['PersonalityTraits ', 'PersonalityTraits'],
  ideals: ['Ideals'],
  bonds: ['Bonds'],
  flaws: ['Flaws'],
  backstory: ['Backstory'],
  appearance: ['CharacterAppearance'],
  otherProficiencies: ['ProficienciesLang'],
};

export interface SheetImport {
  /** Fields understood and ready to apply, keyed as `actorInputSchema` names. */
  values: Record<string, string | number>;
  /** Field names in the file we made no use of, so nothing looks silently lost. */
  unread: string[];
  /** How many form fields the document had at all. */
  fieldCount: number;
}

/** "Fighter 5" or "Wizard 3 / Rogue 2" - take the first class and the first level. */
function splitClassLevel(text: string): { className?: string; level?: number } {
  const match = text.trim().match(/^([A-Za-z ]+?)\s*(\d+)?$/);
  if (!match) return {};

  const out: { className?: string; level?: number } = {};
  const name = match[1]?.trim();
  if (name) out.className = name;

  const level = Number(match[2]);
  if (Number.isFinite(level) && level >= 1 && level <= 20) out.level = level;
  return out;
}

/**
 * An ability box, which people fill in inconsistently.
 *
 * Some sheets carry the score, some the modifier, and a few carry "16 (+3)".
 * A number in 1..30 is a score; anything written with a sign is a modifier and
 * is *not* usable as a score, so it is ignored rather than guessed at - a
 * character silently given Strength 3 because the box said "+3" is exactly the
 * confidently-wrong import this refuses to be.
 */
function abilityScore(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;

  const first = text.match(/\d+/);
  if (!first) return null;
  if (/^[+-]/.test(text)) return null;

  const value = Number(first[0]);
  return value >= 1 && value <= 30 ? value : null;
}

function wholeNumber(raw: string, min: number, max: number): number | null {
  const found = raw.trim().match(/\d+/);
  if (!found) return null;
  const value = Number(found[0]);
  return value >= min && value <= max ? value : null;
}

export async function readCharacterPdf(bytes: Buffer): Promise<SheetImport> {
  let form;
  let fieldNames: string[];
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    form = doc.getForm();
    fieldNames = form.getFields().map((field) => field.getName());
  } catch {
    throw new HttpError(400, 'That file is not a PDF this can read');
  }

  if (fieldNames.length === 0) {
    throw new HttpError(
      400,
      'That PDF has no form fields. Import needs the fillable character sheet, not a flattened or printed one.',
    );
  }

  /** The first of these names that exists and has something in it. */
  const read = (names: string[]): string => {
    for (const name of names) {
      if (!fieldNames.includes(name)) continue;
      try {
        const value = form.getTextField(name).getText() ?? '';
        if (value.trim()) return value.trim();
      } catch {
        // A checkbox or dropdown under a name we expected to be text. Not worth
        // failing an import over.
      }
    }
    return '';
  };

  const values: Record<string, string | number> = {};
  const used = new Set<string>();
  const take = (key: string) => {
    const names = FIELDS[key] ?? [];
    for (const name of names) if (fieldNames.includes(name)) used.add(name);
    return read(names);
  };

  const name = take('name');
  if (name) values.name = name;

  const classLevel = take('classLevel');
  if (classLevel) {
    const { className, level } = splitClassLevel(classLevel);
    if (className) values.className = className;
    if (level) values.level = level;
  }

  for (const key of ['race', 'background', 'alignment'] as const) {
    const text = take(key);
    if (text) values[key] = text;
  }

  for (const ability of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
    const score = abilityScore(take(ability));
    if (score !== null) values[ability] = score;
  }

  const ac = wholeNumber(take('armorClass'), 1, 40);
  if (ac !== null) values.armorClass = ac;

  const speed = wholeNumber(take('speed'), 0, 200);
  if (speed !== null) values.speed = speed;

  const hpMax = wholeNumber(take('hpMax'), 1, 999);
  if (hpMax !== null) values.hpMax = hpMax;

  // Only ever up to the maximum: a sheet carrying current hit points above its
  // own max is a typo, and importing it would make the bar overflow.
  const hpCurrent = wholeNumber(take('hpCurrent'), 0, 999);
  if (hpCurrent !== null) values.hpCurrent = hpMax !== null ? Math.min(hpCurrent, hpMax) : hpCurrent;

  const hitDice = take('hitDice');
  if (hitDice) values.hitDiceTotal = hitDice;

  for (const key of [
    'personalityTraits',
    'ideals',
    'bonds',
    'flaws',
    'backstory',
    'appearance',
    'otherProficiencies',
  ] as const) {
    const text = take(key);
    if (text) values[key] = text;
  }

  return {
    values,
    // Named rather than dropped: an import that quietly ignores half a sheet
    // teaches you to trust it about the other half.
    unread: fieldNames.filter((field) => !used.has(field)).sort(),
    fieldCount: fieldNames.length,
  };
}
