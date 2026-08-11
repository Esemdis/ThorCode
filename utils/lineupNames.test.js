import { describe, it, expect } from 'vitest';
import { cleanLineupName, cleanLineupNames, cleanLineupJson, canonicalBandName } from './lineupNames.js';

describe('cleanLineupName', () => {
  it('strips a follower count welded onto the end of a name', () => {
    expect(cleanLineupName('Counterparts266K Followers')).toBe('Counterparts');
  });

  it('strips counts written with a decimal, a comma or a bigger unit', () => {
    expect(cleanLineupName('Heavensgate5.31K Followers')).toBe('Heavensgate');
    expect(cleanLineupName('No Cure1,204 followers')).toBe('No Cure');
    expect(cleanLineupName('Metallica12M Followers')).toBe('Metallica');
  });

  it('strips the Bandsintown "official" profile suffix', () => {
    expect(cleanLineupName('thrown official53.5K Followers')).toBe('thrown');
  });

  it('leaves a name alone when cleaning would empty it', () => {
    // A band called "Official" is likelier than a lineup entry that was nothing
    // but suffix, so the guard keeps whatever was there.
    expect(cleanLineupName('Official')).toBe('Official');
    expect(cleanLineupName('266K Followers')).toBe('266K Followers');
  });

  it('leaves an ordinary name untouched', () => {
    expect(cleanLineupName('Bad Omens')).toBe('Bad Omens');
    expect(cleanLineupName('  Spiritbox  ')).toBe('Spiritbox');
  });

  it('returns an empty string for anything that is not a string', () => {
    expect(cleanLineupName(null)).toBe('');
    expect(cleanLineupName(42)).toBe('');
  });
});

describe('cleanLineupNames', () => {
  it('cleans the Fållan bill that only ever linked its headliner', () => {
    expect(cleanLineupNames([
      'Counterparts266K Followers',
      'thrown official53.5K Followers',
      'No Cure11.6K Followers',
      'Heavensgate5.31K Followers',
    ])).toEqual(['Counterparts', 'thrown', 'No Cure', 'Heavensgate']);
  });

  it('de-duplicates entries that clean to the same name, keeping the first spelling', () => {
    expect(cleanLineupNames(['Counterparts', 'Counterparts266K Followers'])).toEqual(['Counterparts']);
    expect(cleanLineupNames(['THROWN', 'thrown official'])).toEqual(['THROWN']);
  });

  it('drops blanks and non-strings', () => {
    expect(cleanLineupNames(['Opeth', '', null, 42, '   '])).toEqual(['Opeth']);
  });

  it('returns [] when handed something that is not an array', () => {
    expect(cleanLineupNames(null)).toEqual([]);
    expect(cleanLineupNames('Opeth')).toEqual([]);
  });

  it('makes a support act match the band row it belongs to', () => {
    // What is stored goes through cleanLineupNames, but linking does not depend
    // on that having happened: canonicalBandName cleans first, so a raw name
    // that reaches the matcher by another route still finds its band.
    expect(canonicalBandName('Counterparts266K Followers')).toBe(canonicalBandName('Counterparts'));
    expect(cleanLineupNames(['Counterparts266K Followers'])).toEqual(['Counterparts']);
  });
});

describe('canonicalBandName', () => {
  const sameBand = (a, b) => {
    const key = canonicalBandName(a);
    return key !== '' && key === canonicalBandName(b);
  };

  it('matches the spellings that are one band written two ways', () => {
    expect(sameBand('Architects', 'Architects (UK)')).toBe(true);
    expect(sameBand('WARGASM (UK)', 'WARGASM')).toBe(true);
    expect(sameBand('Invent, Animate', 'Invent Animate')).toBe(true);
    expect(sameBand('Motörhead', 'Motorhead')).toBe(true);
    expect(sameBand('thrown official53.5K Followers', 'THROWN')).toBe(true);
  });

  it('refuses the near-misses that the old similarity score accepted', () => {
    // Every one of these scored >= 0.75 and would have been linked.
    expect(sameBand('Alestorm', 'Halestorm')).toBe(false);
    expect(sameBand('Nothing', 'Nothing More')).toBe(false);
    expect(sameBand('Silence', '156/Silence')).toBe(false);
    expect(sameBand('Caskets Open', 'Caskets')).toBe(false);
  });

  it('is empty for names with nothing comparable left', () => {
    expect(canonicalBandName('')).toBe('');
    expect(canonicalBandName(null)).toBe('');
    expect(canonicalBandName('!!!')).toBe('');
  });

  it('keeps a name that is nothing but a parenthesised phrase', () => {
    // Stripping the suffix would leave nothing, so the whole name stands.
    expect(canonicalBandName('(hed) p.e.')).toBe('hedpe');
  });
});

describe('cleanLineupJson', () => {
  it('cleans a stored lineup in place', () => {
    expect(cleanLineupJson('["Counterparts266K Followers","No Cure11.6K Followers"]'))
      .toBe('["Counterparts","No Cure"]');
  });

  it('returns null for missing or empty lineups', () => {
    expect(cleanLineupJson(null)).toBe(null);
    expect(cleanLineupJson('')).toBe(null);
    expect(cleanLineupJson('[]')).toBe(null);
  });

  it('hands back anything that is not a JSON array untouched', () => {
    // metadata is a free-form text column; older rows may hold something else,
    // and keeping it beats discarding it.
    expect(cleanLineupJson('not json')).toBe('not json');
    expect(cleanLineupJson('{"a":1}')).toBe('{"a":1}');
  });
});
