import { describe, it, expect } from 'vitest';
import { cleanLineupName, cleanLineupNames, cleanLineupJson, canonicalBandName, lineupGrew } from './lineupNames.js';

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

  it('keeps names that are not written in Latin letters', () => {
    // Everything outside a-z used to be stripped, so these were all '' — no
    // band written in Cyrillic or Japanese could be matched or put on a bill.
    expect(canonicalBandName('Кино')).toBe('кино');
    expect(sameBand('КИНО', 'Кино')).toBe(true);
    expect(canonicalBandName('陰陽座')).toBe('陰陽座');
    expect(sameBand('ガ', 'カ')).toBe(false);
  });

  it('keeps letters that have no accent to strip', () => {
    expect(canonicalBandName('Møl')).toBe('møl');
    expect(sameBand('Møl', 'Ml')).toBe(false);
    expect(sameBand('Æther Realm', 'ÆTHER REALM')).toBe(true);
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

describe('lineupGrew', () => {
  const bill = (...names) => JSON.stringify(names);

  it('is true when the scrape names an act the row has never heard of', () => {
    expect(lineupGrew(bill('Ghost', 'Opeth'), bill('Ghost', 'Opeth', 'Gojira'))).toBe(true);
  });

  it('lets a festival scrape that saw three of forty acts keep its hands off', () => {
    // Which is every Bandsintown scrape of a festival: it files the acts stage
    // by stage, and the row is the only record of the ones with no Band row.
    const forty = bill(...Array.from({ length: 40 }, (_, i) => `Act ${i}`));
    expect(lineupGrew(forty, bill('Act 0', 'Act 1', 'Act 2'))).toBe(false);
  });

  it('is false for the same bill, however the sources spell it', () => {
    expect(lineupGrew(bill('Ghost', 'Opeth'), bill('Ghost', 'Opeth'))).toBe(false);
    expect(lineupGrew(bill('Architects'), bill('Architects (UK)'))).toBe(false);
    expect(lineupGrew(bill('Counterparts'), bill('Counterparts266K Followers'))).toBe(false);
  });

  it('counts an act listed twice once', () => {
    expect(lineupGrew(bill('Ghost'), bill('Ghost', 'Ghost'))).toBe(false);
  });

  it('is true for a first bill on a row that has none', () => {
    expect(lineupGrew(null, bill('Ghost'))).toBe(true);
    expect(lineupGrew(bill(), bill('Ghost'))).toBe(true);
  });

  it('is false when the scrape saw no bill at all', () => {
    expect(lineupGrew(bill('Ghost'), null)).toBe(false);
    expect(lineupGrew(null, null)).toBe(false);
  });

  it('reads a column holding something other than a lineup as no bill', () => {
    expect(lineupGrew('not json', bill('Ghost'))).toBe(true);
    expect(lineupGrew(bill('Ghost'), 'not json')).toBe(false);
  });
});

// THO-971: the suffix patterns used to be regexes with a leading \s* (or a
// [\d.,]* run) that the engine retried from every start position, so a long
// run of spaces, digits or "(" took time proportional to its length squared.
// 100,000 spaces took 31.6 s on one thread, and a name that long could be
// stored and then matched against on every band add.
describe('matching a hostile name (THO-971)', () => {
  const tho971Long = 100_000;
  const tho971Inputs = {
    'spaces between a and x': `a${' '.repeat(tho971Long)}x`,
    'digits then x': `${'1'.repeat(tho971Long)}x`,
    'a 1.1.1 mix then x': `${'1.'.repeat(tho971Long / 2)}x`,
    '"(" repeated': '('.repeat(tho971Long),
    '1, spaces, then x': `1${' '.repeat(tho971Long)}x`,
  };

  for (const [label, input] of Object.entries(tho971Inputs)) {
    it(`finishes in well under a second on 100,000 characters of ${label}`, () => {
      // 250 ms is a generous ceiling for a linear scan of 100k characters
      // (it takes a few ms); the old patterns took seconds on every one of
      // these inputs, so the test cannot pass by luck on a slow machine.
      for (const fn of [cleanLineupName, canonicalBandName]) {
        const started = performance.now();
        fn(input);
        expect(performance.now() - started).toBeLessThan(250);
      }
    });
  }
});

describe('the linear suffix strippers keep the old patterns\' answers (THO-971)', () => {
  // The three regexes the strippers replaced, kept here as the reference they
  // are checked against. Safe on the short strings below; never in the app.
  const tho971OldFollower = /\s*\d[\d.,]*\s*[KMB]?\s*followers?\s*$/i;
  const tho971OldProfile = /\s+official\s*$/i;
  const tho971OldCountry = /\s*\([^)]*\)\s*$/;
  const tho971OldClean = (name) => {
    if (typeof name !== 'string') return '';
    const cleaned = name.replace(tho971OldFollower, '').replace(tho971OldProfile, '').trim();
    return cleaned || name.trim();
  };
  const tho971OldCountryStrip = (name) => {
    const cleaned = tho971OldClean(name);
    if (!cleaned) return '';
    return cleaned.replace(tho971OldCountry, '').trim() || cleaned;
  };
  // The rest of canonicalBandName as it stands, so the comparison is of the
  // suffix handling alone.
  const tho971OldCanonical = (name) => tho971OldCountryStrip(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  it('cuts the edge cases where the old patterns did', () => {
    const cases = [
      ['Someone.5K followers', 'Someone.'],
      ['Someone 5K\nFollowers', 'Someone'],
      ['Someone\n5K followers\n', 'Someone'],
      ['Someone5 k  follower ', 'Someone'],
      ['Someone5KK followers', 'Someone5KK followers'],
      ['Someone K followers', 'Someone K followers'],
      ['x..5K Followers', 'x..'],
      ['x5.,K Followers', 'x'],
      ['thrown\tOFFICIAL ', 'thrown'],
      ['thrownofficial', 'thrownofficial'],
      ['official', 'official'],
      ['Followers', 'Followers'],
    ];
    for (const [input, expected] of cases) {
      expect(cleanLineupName(input)).toBe(expected);
      expect(cleanLineupName(input)).toBe(tho971OldClean(input));
    }
    for (const input of ['Architects (UK', 'A (b (c))', 'A (b) (c)', 'A ((b)', '(UK)', 'Polaris\n(AUS) \n', 'A (b) c']) {
      expect(canonicalBandName(input)).toBe(tho971OldCanonical(input));
    }
    expect(canonicalBandName('A (b) (c)')).toBe('ab');
    expect(canonicalBandName('A ((b)')).toBe('a');
  });

  it('agrees with the old patterns on thousands of generated names', () => {
    // A seeded generator over the pieces the patterns care about, so every
    // run checks the same names and a failure can be reproduced.
    const pieces = ['a', 'Z', ' ', '\n', '\t', '1', '0', '.', ',', 'K', 'm', 'b', '(', ')',
      'followers', 'Follower', 'FOLLOWERS', 'official', 'Official', 'ö', 'ſ', 'K'];
    let seed = 971;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let n = 0; n < 20_000; n++) {
      const length = next() % 9;
      let name = '';
      for (let i = 0; i < length; i++) name += pieces[next() % pieces.length];
      expect([name, cleanLineupName(name)]).toEqual([name, tho971OldClean(name)]);
      expect([name, canonicalBandName(name)]).toEqual([name, tho971OldCanonical(name)]);
    }
  });
});
