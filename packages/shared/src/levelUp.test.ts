import { describe, expect, it } from 'vitest';
import { levelGains } from './levelUp.js';
import type {
  ClassLevelRow,
  CustomSubclassFeature,
  FeatureRow,
  TraitRow,
} from './levelUp.js';
import { ASI_LEVELS, auditAsiLevels, gainsAbilityScoreIncrease } from './rules5e.js';

/** A Barbarian's published rows, trimmed to the levels these tests cross. */
const barbarianLevels: ClassLevelRow[] = [
  { className: 'Barbarian', level: 3, spellcasting: null, classSpecific: { rage_count: 3, rage_damage_bonus: 2 } },
  { className: 'Barbarian', level: 4, spellcasting: null, classSpecific: { rage_count: 3, rage_damage_bonus: 2 } },
  { className: 'Barbarian', level: 5, spellcasting: null, classSpecific: { rage_count: 3, rage_damage_bonus: 2, extra_attacks: 1 } },
];

const barbarianFeatures: FeatureRow[] = [
  { className: 'Barbarian', subclassName: '', level: 5, name: 'Extra Attack', description: 'Attack twice.', parentName: '' },
  { className: 'Barbarian', subclassName: '', level: 5, name: 'Fast Movement', description: '+10 feet.', parentName: '' },
  { className: 'Barbarian', subclassName: 'Berserker', level: 3, name: 'Frenzy', description: 'Rage harder.', parentName: '' },
  { className: 'Barbarian', subclassName: '', level: 4, name: 'Ability Score Improvement', description: '+2.', parentName: '' },
  { className: 'Wizard', subclassName: '', level: 5, name: 'Should never appear', description: '', parentName: '' },
];

const traits: TraitRow[] = [
  {
    name: 'Infernal Legacy',
    races: ['Tiefling'],
    description: 'You know thaumaturgy. Once you reach 3rd level, hellish rebuke. At 5th level, darkness.',
  },
  { name: 'Darkvision', races: ['Tiefling'], description: 'You can see in dim light within 60 feet.' },
  { name: 'Breath Weapon', races: ['Dragonborn'], description: 'The damage increases at 6th level.' },
];

function gains(over: Partial<Parameters<typeof levelGains>[0]> = {}) {
  return levelGains({
    className: 'Barbarian',
    subclass: '',
    race: '',
    from: 4,
    to: 5,
    classLevels: barbarianLevels,
    features: barbarianFeatures,
    traits,
    ...over,
  });
}

describe('what a level grants', () => {
  it('names the features gained at exactly that level', () => {
    const result = gains();
    expect(result.features.map((f) => f.name)).toEqual(['Extra Attack', 'Fast Movement']);
  });

  it("never borrows another class's features", () => {
    expect(gains().features.map((f) => f.name)).not.toContain('Should never appear');
  });

  it('covers every level crossed, not only the last', () => {
    // A DM moving the party 3 to 5 owes them both levels. Showing only the
    // fifth quietly loses the fourth, which nobody would notice was missing.
    const result = gains({ from: 3, to: 5 });
    expect(result.features.map((f) => f.name)).toContain('Ability Score Improvement');
    expect(result.features.map((f) => f.name)).toContain('Extra Attack');
  });

  it('reports the proficiency bonus only when it moved', () => {
    expect(gains({ from: 4, to: 5 }).proficiencyBonus).toEqual({ from: 2, to: 3 });
    expect(gains({ from: 3, to: 4 }).proficiencyBonus).toBeNull();
  });

  it('refuses a class it has nothing published for, and says so', () => {
    const result = gains({ className: 'Fighter 3 / Rogue 2' });
    expect(result.unavailable).toMatch(/multiclass or homebrew/i);
    expect(result.features).toEqual([]);
  });

  it('refuses a level that was not gained', () => {
    expect(gains({ from: 5, to: 5 }).unavailable).toBeTruthy();
    expect(gains({ from: 6, to: 5 }).unavailable).toBeTruthy();
  });
});

describe('the cumulative trap', () => {
  it('owes an increase at 4, and not at 5', () => {
    // The 2014 data publishes ability score bonuses as a running total, so a
    // Barbarian reads 1 at level 5 because of the increase at 4. Reading that
    // as "you get one here" hands out an increase at every level from 4 up.
    expect(gains({ from: 3, to: 4 }).abilityScoreIncreases).toBe(1);
    expect(gains({ from: 4, to: 5 }).abilityScoreIncreases).toBe(0);
  });

  it('owes two when two were crossed', () => {
    expect(gains({ from: 3, to: 8 }).abilityScoreIncreases).toBe(2);
  });

  it('knows the two classes that break the pattern', () => {
    expect(gainsAbilityScoreIncrease('Fighter', 6)).toBe(true);
    expect(gainsAbilityScoreIncrease('Barbarian', 6)).toBe(false);
    expect(gainsAbilityScoreIncrease('Rogue', 10)).toBe(true);
    expect(gainsAbilityScoreIncrease('Wizard', 10)).toBe(false);
  });

  it('says nothing for a class it does not know', () => {
    expect(gainsAbilityScoreIncrease('Artificer', 4)).toBe(false);
  });
});

describe('the audit against published counts', () => {
  it('matches a class whose published totals imply our levels', () => {
    // A cumulative count for every level 1..20, the shape the data arrives in.
    const barbarian = Array.from({ length: 20 }, (_, i) => ({
      className: 'Barbarian',
      level: i + 1,
      cumulative: [4, 8, 12, 16, 19].filter((asi) => asi <= i + 1).length,
    }));
    const audit = auditAsiLevels(barbarian);
    expect(audit.matched).toContain('Barbarian');
    expect(audit.disagreed).toEqual([]);
  });

  it('catches a class whose published totals do not', () => {
    const wrong = Array.from({ length: 20 }, (_, i) => ({
      className: 'Barbarian',
      level: i + 1,
      cumulative: [4, 9].filter((asi) => asi <= i + 1).length,
    }));
    const audit = auditAsiLevels(wrong);
    expect(audit.disagreed[0]).toMatchObject({
      className: 'Barbarian',
      ours: [4, 8, 12, 16, 19],
      published: [4, 9],
    });
  });

  it('reports a class with nothing published as unchecked, not as passing', () => {
    const audit = auditAsiLevels([]);
    expect(audit.unchecked).toHaveLength(Object.keys(ASI_LEVELS).length);
    expect(audit.matched).toEqual([]);
  });
});

describe('spell slots and counters', () => {
  const wizard: ClassLevelRow[] = [
    {
      className: 'Wizard',
      level: 4,
      spellcasting: { cantrips_known: 4, spell_slots_level_1: 4, spell_slots_level_2: 3, spell_slots_level_3: 0 },
      classSpecific: { arcane_recovery_levels: 2 },
    },
    {
      className: 'Wizard',
      level: 5,
      spellcasting: { cantrips_known: 4, spell_slots_level_1: 4, spell_slots_level_2: 3, spell_slots_level_3: 2 },
      classSpecific: { arcane_recovery_levels: 3 },
    },
  ];

  it('reports only the slot levels that changed', () => {
    const result = levelGains({
      className: 'Wizard', subclass: '', race: '', from: 4, to: 5,
      classLevels: wizard, features: [], traits: [],
    });
    expect(result.spellSlots).toEqual([{ spellLevel: 3, from: 0, to: 2 }]);
  });

  it('says nothing about cantrips that did not move', () => {
    const result = levelGains({
      className: 'Wizard', subclass: '', race: '', from: 4, to: 5,
      classLevels: wizard, features: [], traits: [],
    });
    expect(result.cantrips).toBeNull();
  });

  it('reports a counter that went up, and stays quiet about one that did not', () => {
    const result = levelGains({
      className: 'Wizard', subclass: '', race: '', from: 4, to: 5,
      classLevels: wizard, features: [], traits: [],
    });
    expect(result.counters).toEqual([{ label: 'Arcane recovery levels', from: '2', to: '3' }]);
  });

  it('writes a dice pair as dice', () => {
    const rogue: ClassLevelRow[] = [
      { className: 'Rogue', level: 4, spellcasting: null, classSpecific: { sneak_attack: { dice_count: 2, dice_value: 6 } } },
      { className: 'Rogue', level: 5, spellcasting: null, classSpecific: { sneak_attack: { dice_count: 3, dice_value: 6 } } },
    ];
    const result = levelGains({
      className: 'Rogue', subclass: '', race: '', from: 4, to: 5,
      classLevels: rogue, features: [], traits: [],
    });
    expect(result.counters).toEqual([{ label: 'Sneak attack', from: '2d6', to: '3d6' }]);
  });

  it('leaves out a counter it cannot write as a number', () => {
    // The sorcerer's table of slot costs is a list, not a count that went up.
    const sorcerer: ClassLevelRow[] = [
      { className: 'Sorcerer', level: 4, spellcasting: null, classSpecific: {} },
      { className: 'Sorcerer', level: 5, spellcasting: null, classSpecific: { creating_spell_slots: [{ a: 1 }] } },
    ];
    const result = levelGains({
      className: 'Sorcerer', subclass: '', race: '', from: 4, to: 5,
      classLevels: sorcerer, features: [], traits: [],
    });
    expect(result.counters).toEqual([]);
  });
});

describe('choices, which are features with options', () => {
  const fighter: FeatureRow[] = [
    { className: 'Fighter', subclassName: '', level: 1, name: 'Fighting Style', description: 'Choose one.', parentName: '' },
    { className: 'Fighter', subclassName: '', level: 1, name: 'Fighting Style: Archery', description: '+2 to ranged.', parentName: 'Fighting Style' },
    { className: 'Fighter', subclassName: '', level: 1, name: 'Fighting Style: Defense', description: '+1 AC.', parentName: 'Fighting Style' },
    { className: 'Fighter', subclassName: '', level: 1, name: 'Second Wind', description: 'Regain hit points.', parentName: '' },
  ];

  it('nests the options under the choice rather than listing them flat', () => {
    const result = levelGains({
      className: 'Fighter', subclass: '', race: '', from: 0, to: 1,
      classLevels: [], features: fighter, traits: [],
    });
    expect(result.features.map((f) => f.name)).toEqual(['Fighting Style', 'Second Wind']);
    expect(result.features[0]!.options.map((o) => o.name)).toEqual([
      'Fighting Style: Archery',
      'Fighting Style: Defense',
    ]);
  });

  it('keeps an option whose parent is not in the batch, rather than dropping it', () => {
    // A lost feature is worse than an ungrouped one.
    const result = levelGains({
      className: 'Fighter', subclass: '', race: '', from: 0, to: 1,
      classLevels: [],
      features: [fighter[1]!],
      traits: [],
    });
    expect(result.features.map((f) => f.name)).toEqual(['Fighting Style: Archery']);
  });
});

describe('subclass features', () => {
  /** A Battle Master, written by hand because the SRD never published one. */
  const battleMaster: CustomSubclassFeature[] = [
    { subclassName: 'Battle Master', level: 3, name: 'Combat Superiority', description: 'Four dice.' },
    { subclassName: 'Battle Master', level: 7, name: 'Know Your Enemy', description: 'Study them.' },
  ];

  it("keeps them apart from the class's own", () => {
    const result = gains({ from: 2, to: 3, subclass: 'Berserker' });
    expect(result.features.map((f) => f.name)).not.toContain('Frenzy');
    expect(result.subclassFeatures.map((f) => f.name)).toEqual(['Frenzy']);
    expect(result.subclassSource).toBe('published');
  });

  it('shows nothing at all when the sheet names no subclass', () => {
    // The regression this exists for. It used to fall back to "whatever the SRD
    // publishes", and since no UI ever set the field, every Battle Master was
    // quietly handed Champion's features.
    const result = gains({ from: 2, to: 3, subclass: '' });
    expect(result.subclassFeatures).toEqual([]);
    expect(result.subclassSource).toBeNull();
    // Still reported, so the panel can say which one the SRD does carry.
    expect(result.publishedSubclassName).toBe('Berserker');
  });

  it('shows nothing for a subclass the SRD never published', () => {
    const result = gains({ from: 2, to: 3, subclass: 'Totem Warrior' });
    expect(result.subclassFeatures).toEqual([]);
    expect(result.subclassSource).toBeNull();
    expect(result.publishedSubclassName).toBe('Berserker');
  });

  it('uses a definition written for that subclass', () => {
    const result = gains({
      className: 'Fighter', subclass: 'Battle Master', from: 6, to: 7,
      features: [], customFeatures: battleMaster,
    });
    expect(result.subclassFeatures.map((f) => f.name)).toEqual(['Know Your Enemy']);
    expect(result.subclassSource).toBe('custom');
  });

  it('refuses a definition written for a different subclass', () => {
    // Retyping the sheet's subclass must not serve the old list. The name rides
    // on every row for exactly this.
    const result = gains({
      className: 'Fighter', subclass: 'Champion', from: 6, to: 7,
      features: [], customFeatures: battleMaster,
    });
    expect(result.subclassFeatures).toEqual([]);
    expect(result.subclassSource).toBeNull();
  });

  it('ignores a definition when no subclass is named', () => {
    const result = gains({
      className: 'Fighter', subclass: '', from: 6, to: 7,
      features: [], customFeatures: battleMaster,
    });
    expect(result.subclassFeatures).toEqual([]);
  });

  it('only takes the levels crossed from a definition', () => {
    const result = gains({
      className: 'Fighter', subclass: 'Battle Master', from: 2, to: 3,
      features: [], customFeatures: battleMaster,
    });
    expect(result.subclassFeatures.map((f) => f.name)).toEqual(['Combat Superiority']);
  });

  it('matches the subclass however it was capitalised', () => {
    const result = gains({
      className: 'Fighter', subclass: 'battle master', from: 6, to: 7,
      features: [], customFeatures: battleMaster,
    });
    expect(result.subclassFeatures.map((f) => f.name)).toEqual(['Know Your Enemy']);
  });

  it('knows a published subclass even at a level it grants nothing', () => {
    // The panel told a Champion "nothing published for Champion - the SRD only
    // carries Champion", which is nonsense on its face. Granting nothing *here*
    // and being unknown are two different sentences.
    const result = gains({ from: 4, to: 5, subclass: 'Berserker' });
    expect(result.subclassFeatures).toEqual([]);
    expect(result.subclassKnown).toBe(true);
  });

  it('knows a written subclass at a level it grants nothing', () => {
    const result = gains({
      className: 'Fighter', subclass: 'Battle Master', from: 4, to: 5,
      features: [],
      customFeatures: [
        { subclassName: 'Battle Master', level: 3, name: 'Combat Superiority', description: '' },
      ],
    });
    expect(result.subclassFeatures).toEqual([]);
    expect(result.subclassKnown).toBe(true);
  });

  it('does not know a subclass nobody has published or written', () => {
    const result = gains({ from: 2, to: 3, subclass: 'Totem Warrior' });
    expect(result.subclassKnown).toBe(false);
  });

  it('prefers the published subclass over a definition of the same name', () => {
    // Somebody who writes their own Berserker gets the compendium's, which is
    // the one the rest of the app already agrees about.
    const result = gains({
      from: 2, to: 3, subclass: 'Berserker',
      customFeatures: [
        { subclassName: 'Berserker', level: 3, name: 'Something else', description: '' },
      ],
    });
    expect(result.subclassFeatures.map((f) => f.name)).toEqual(['Frenzy']);
    expect(result.subclassSource).toBe('published');
  });
});

describe('racial pointers', () => {
  it('surfaces a trait whose text names the level reached', () => {
    const result = gains({ race: 'Tiefling', from: 4, to: 5 });
    expect(result.raceHints.map((h) => h.name)).toEqual(['Infernal Legacy']);
  });

  it('stays quiet at a level the trait says nothing about', () => {
    expect(gains({ race: 'Tiefling', from: 5, to: 6 }).raceHints).toEqual([]);
  });

  it("never offers another race's traits", () => {
    expect(gains({ race: 'Tiefling', from: 5, to: 6 }).raceHints.map((h) => h.name)).not.toContain(
      'Breath Weapon',
    );
  });

  it('says nothing when no race is set', () => {
    expect(gains({ race: '', from: 4, to: 5 }).raceHints).toEqual([]);
  });

  it('is not fooled by a trait that merely mentions a number', () => {
    // "within 60 feet" must not read as a level.
    const result = gains({ race: 'Tiefling', from: 59, to: 60 });
    expect(result.raceHints).toEqual([]);
  });
});
