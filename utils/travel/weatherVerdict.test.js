import { describe, it, expect } from 'vitest';
import {
  buildVerdictInput, normaliseVerdict, VerdictInputError,
  describeCode, forecastLines, packingLines, groupPacking,
  dateOnly, tripLength, MAX_DAYS, MAX_ITEMS,
} from './weatherVerdict';

const day = (over = {}) => ({
  date: '2026-08-10', weather_code: 0, temp_min_avg: 14, temp_max_avg: 21,
  precip_avg: 0, wind_avg: 8, ...over,
});
const item = (over = {}) => ({ name: 'Rain shell', category: 'Clothing', status: 'PACKED', ...over });
const trip = (over = {}) => ({
  name: 'Bergen', destination: 'Norway',
  start_date: '2026-08-10', end_date: '2026-08-14',
  weather_data: { days: [day()] }, ...over,
});

describe('dateOnly', () => {
  it('formats the Date objects Prisma returns for a date column', () => {
    // String(new Date()) is "Mon Aug 10 2026 …", so slicing it yields
    // "Mon Aug 10" — a date the model cannot read as a date.
    expect(dateOnly(new Date('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10');
  });

  it('passes an ISO string through untouched', () => {
    expect(dateOnly('2026-08-10')).toBe('2026-08-10');
    expect(dateOnly('2026-08-10T12:30:00.000Z')).toBe('2026-08-10');
  });

  it('returns null for a missing date rather than the string "null"', () => {
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(undefined)).toBeNull();
  });
});

describe('tripLength', () => {
  it('counts both end days, the way a traveller counts a trip', () => {
    // The 10th to the 14th is five days away, not four.
    expect(tripLength({ start_date: '2026-08-10', end_date: '2026-08-14' })).toBe(5);
  });

  it('counts a same-day trip as one day', () => {
    expect(tripLength({ start_date: '2026-08-10', end_date: '2026-08-10' })).toBe(1);
  });

  it('is unaffected by the server timezone', () => {
    // Both ends are anchored to UTC before subtracting; a local-time parse
    // makes this 4 or 6 depending on where the server runs.
    expect(tripLength({
      start_date: new Date('2026-08-10T00:00:00.000Z'),
      end_date: new Date('2026-08-14T00:00:00.000Z'),
    })).toBe(5);
  });

  it('gives nothing for a trip with no dates set', () => {
    expect(tripLength({})).toBeNull();
    expect(tripLength({ start_date: '2026-08-10' })).toBeNull();
  });

  it('gives nothing rather than a negative length when the dates are backwards', () => {
    expect(tripLength({ start_date: '2026-08-14', end_date: '2026-08-10' })).toBeNull();
  });
});

describe('describeCode', () => {
  it('collapses a run of related codes onto one word', () => {
    // 61 and 65 are light and heavy rain; the verdict only needs "rain".
    expect(describeCode(61)).toBe('rain');
    expect(describeCode(65)).toBe('rain');
  });

  it('separates showers from steady rain, which pack differently', () => {
    expect(describeCode(80)).toBe('rain showers');
    expect(describeCode(63)).toBe('rain');
  });

  it('says nothing for a missing or unrecognised code rather than guessing', () => {
    expect(describeCode(null)).toBeNull();
    expect(describeCode(undefined)).toBeNull();
    expect(describeCode(4)).toBeNull(); // falls between the cloudy and fog bands
  });
});

describe('forecastLines', () => {
  it('puts the calendar date first without parsing it', () => {
    // Parsing would slide the day backwards for anyone west of UTC.
    const [line] = forecastLines([day({ date: '2026-08-10T00:00:00.000Z' })]);
    expect(line.startsWith('2026-08-10:')).toBe(true);
  });

  it('reads a full day as a temperature range plus its conditions', () => {
    const [line] = forecastLines([day({ weather_code: 63, precip_avg: 4.25, wind_avg: 30 })]);
    expect(line).toBe('2026-08-10: 14 to 21C, rain, 4.3mm precipitation, wind 30km/h');
  });

  it('leaves out readings the forecast does not have', () => {
    const [line] = forecastLines([day({ precip_avg: 0, wind_avg: 0, weather_code: null })]);
    expect(line).toBe('2026-08-10: 14 to 21C');
  });

  it('falls back to the maximum when only one temperature is known', () => {
    const [line] = forecastLines([day({ temp_min_avg: null, precip_avg: 0, wind_avg: 0, weather_code: null })]);
    expect(line).toBe('2026-08-10: max 21C');
  });

  it('says so rather than emitting a bare date when a day has no readings at all', () => {
    const [line] = forecastLines([{ date: '2026-08-10' }]);
    expect(line).toBe('2026-08-10: no reading');
  });

  it('caps how many days one request can carry', () => {
    const days = Array.from({ length: MAX_DAYS + 5 }, () => day());
    expect(forecastLines(days)).toHaveLength(MAX_DAYS);
  });
});

describe('packingLines', () => {
  it('carries the gear behind an item, since that is what makes it judgeable', () => {
    // "Jacket" says nothing; "Arc'teryx Beta AR, tags: waterproof" does.
    const [line] = packingLines([item({
      name: 'Jacket',
      gear_item_rel: { brand: "Arc'teryx", model: 'Beta AR', tags: ['waterproof', 'shell'] },
    })]);
    expect(line).toContain("gear: Arc'teryx Beta AR");
    expect(line).toContain('tags: waterproof, shell');
  });

  it('flags an item that is not actually in the bag yet', () => {
    const [line] = packingLines([item({ status: 'NEED_TO_BUY' })]);
    expect(line).toContain('status: need to buy');
  });

  it('says nothing about status for something already packed', () => {
    // The default case is the common one — repeating it on every line would be
    // most of the prompt.
    expect(packingLines([item({ status: 'PACKED' })])[0]).not.toContain('status');
  });

  it('marks worn items, which are brought but not carried', () => {
    expect(packingLines([item({ worn: true })])[0]).toContain('worn, not packed');
  });

  it('falls back to the gear category when the trip item has none', () => {
    // Anything added from the closet carries its category on the gear row.
    const [line] = packingLines([item({
      category: null,
      gear_item_rel: { category: 'Footwear', tags: [] },
    })]);
    expect(line).toContain('category: Footwear');
  });

  it('collapses identical items into one line with a count', () => {
    // "Is four shirts enough for six days" is the question; four separate
    // lines make the model derive the count before it can answer.
    const lines = packingLines([item({ name: 'Merino tee' }), item({ name: 'Merino tee' }), item({ name: 'Merino tee' })]);
    expect(lines).toEqual(['- 3x Merino tee; category: Clothing']);
  });

  it('puts the count in front, where it cannot be read as part of a tag', () => {
    // Trailing, "tags: wool, base layer x3" reads as a tag "base layer x3".
    const [line] = packingLines([
      item({ name: 'Tee', gear_item_rel: { tags: ['wool', 'base layer'] } }),
      item({ name: 'Tee', gear_item_rel: { tags: ['wool', 'base layer'] } }),
    ]);
    expect(line.startsWith('- 2x Tee')).toBe(true);
    expect(line.endsWith('base layer')).toBe(true);
  });

  it('leaves a lone item without a count', () => {
    expect(packingLines([item({ name: 'Rain shell' })])[0]).not.toContain('1x');
  });

  it('keeps items apart when a detail differs', () => {
    // Two shirts where one is still unbought are not interchangeable.
    const lines = packingLines([item({ name: 'Merino tee' }), item({ name: 'Merino tee', status: 'NEED_TO_BUY' })]);
    expect(lines).toHaveLength(2);
  });

  it('caps how many distinct kinds of item one request can carry', () => {
    const items = Array.from({ length: MAX_ITEMS + 10 }, (_, n) => item({ name: `Item ${n}` }));
    expect(packingLines(items)).toHaveLength(MAX_ITEMS);
  });

  it('does not let duplicates eat the cap', () => {
    // 300 copies of one thing is one line, not 120 wasted ones.
    const items = Array.from({ length: 300 }, () => item({ name: 'Sock' }));
    expect(groupPacking(items)).toHaveLength(1);
    expect(packingLines(items)).toEqual(['- 300x Sock; category: Clothing']);
  });
});

describe('buildVerdictInput', () => {
  it('refuses a trip with no forecast rather than asking for a verdict on nothing', () => {
    expect(() => buildVerdictInput(trip({ weather_data: null }), [item()]))
      .toThrow(VerdictInputError);
  });

  it('refuses a trip with an empty packing list', () => {
    expect(() => buildVerdictInput(trip(), [])).toThrow(VerdictInputError);
  });

  it('includes the destination and dates so the model can place the trip', () => {
    const text = buildVerdictInput(trip(), [item()]);
    expect(text).toContain('Destination: Norway');
    expect(text).toContain('Dates: 2026-08-10 to 2026-08-14');
  });

  it('states the real totals even when the lists are truncated', () => {
    // Otherwise the model judges 120 kinds of item believing that is everything.
    const items = Array.from({ length: MAX_ITEMS + 3 }, (_, n) => item({ name: `Item ${n}` }));
    const days = Array.from({ length: MAX_DAYS + 2 }, () => day());
    const text = buildVerdictInput(trip({ weather_data: { days } }), items);
    expect(text).toContain(`Packing list (${MAX_ITEMS + 3} items)`);
    expect(text).toContain('(3 further kinds of item not shown)');
    expect(text).toContain('(2 further days not shown)');
  });

  it('states the trip length rather than leaving it as date arithmetic', () => {
    expect(buildVerdictInput(trip(), [item()])).toContain('Trip length: 5 days');
  });

  it('formats Prisma date columns as dates', () => {
    // Regression: these arrive as Date objects, and String() on one gives
    // "Mon Aug 10 2026 …".
    const text = buildVerdictInput(trip({
      start_date: new Date('2026-08-10T00:00:00.000Z'),
      end_date: new Date('2026-08-14T00:00:00.000Z'),
    }), [item()]);
    expect(text).toContain('Dates: 2026-08-10 to 2026-08-14');
    expect(text).not.toContain('Mon Aug');
  });

  it('says when the forecast runs out before the trip does', () => {
    // Otherwise a 3-day forecast on a 5-day trip gets judged as a 3-day trip.
    const text = buildVerdictInput(trip({
      end_date: '2026-08-14',
      weather_data: { days: [day(), day(), day()] },
    }), [item()]);
    expect(text).toContain('Forecast covers the first 3 of 5 days.');
  });

  it('says nothing about coverage when the forecast spans the whole trip', () => {
    const days = Array.from({ length: 5 }, () => day());
    const text = buildVerdictInput(trip({ weather_data: { days } }), [item()]);
    expect(text).not.toContain('Forecast covers');
  });

  it('leaves the truncation note out when nothing was truncated', () => {
    expect(buildVerdictInput(trip(), [item()])).not.toContain('not shown');
  });
});

describe('normaliseVerdict', () => {
  const good = {
    verdict: 'serious_gaps',
    summary: '  Three wet days and no shell.  ',
    concerns: [{ issue: ' No waterproof layer ', why: 'Rain on 3 of 5 days', severity: 'high', suggestion: 'Add a shell' }],
  };

  it('trims the text it passes through to the UI', () => {
    const out = normaliseVerdict(good);
    expect(out.summary).toBe('Three wet days and no shell.');
    expect(out.concerns[0].issue).toBe('No waterproof layer');
  });

  it('throws when the model returned nothing usable', () => {
    expect(() => normaliseVerdict(null)).toThrow(VerdictInputError);
    expect(() => normaliseVerdict('sorry')).toThrow(VerdictInputError);
  });

  it('falls back to minor_gaps on a verdict outside the schema', () => {
    // Neither reassuring nor alarming — the safe middle when the model
    // ignored the enum.
    expect(normaliseVerdict({ ...good, verdict: 'catastrophe' }).verdict).toBe('minor_gaps');
  });

  it('treats any severity that is not high as low', () => {
    // A wrong "high" shouts at the user; a wrong "low" under-sells one line.
    const out = normaliseVerdict({ ...good, concerns: [{ issue: 'x', severity: 'CRITICAL' }] });
    expect(out.concerns[0].severity).toBe('low');
  });

  it('drops concerns with no issue text, which would render as empty rows', () => {
    const out = normaliseVerdict({
      ...good,
      concerns: [{ issue: '', severity: 'high' }, { issue: '   ', severity: 'low' }, { issue: 'Real', severity: 'low' }],
    });
    expect(out.concerns.map((c) => c.issue)).toEqual(['Real']);
  });

  it('survives a response missing concerns entirely', () => {
    const out = normaliseVerdict({ verdict: 'ready', summary: 'Looks fine.' });
    expect(out.concerns).toEqual([]);
  });

  it('nulls an absent suggestion rather than leaving undefined for the UI to test', () => {
    const out = normaliseVerdict({ ...good, concerns: [{ issue: 'x', severity: 'low' }] });
    expect(out.concerns[0].suggestion).toBeNull();
  });
});
