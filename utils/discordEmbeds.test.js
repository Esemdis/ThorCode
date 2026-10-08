import { describe, it, expect } from 'vitest';
import { buildDiscordEmbeds, buildRecapEmbed } from './discordEmbeds.js';

const concert = (extra = {}) => ({
  concert_date: '2026-11-02T19:00:00.000Z',
  city: 'Stockholm',
  country: 'SE',
  venue: 'Debaser',
  url: null,
  metadata: null,
  ...extra,
});

describe('buildDiscordEmbeds', () => {
  it('gives each concert a field headed by its date and place', () => {
    const [embed] = buildDiscordEmbeds({ title: 'New concerts: Opeth', concerts: [concert()] });
    expect(embed.title).toBe('New concerts: Opeth');
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields[0].name).toBe('02 Nov 2026 — Stockholm, SE');
    expect(embed.fields[0].value).toBe('Debaser');
  });

  it('links the venue when the concert has a url', () => {
    const [embed] = buildDiscordEmbeds({
      title: 'x',
      concerts: [concert({ url: 'https://tickets.example/1' })],
    });
    expect(embed.fields[0].value).toBe('[Debaser](https://tickets.example/1)');
  });

  it('links each vendor ahead of the listing, with the price and opening above them', () => {
    const [embed] = buildDiscordEmbeds({
      title: 'x',
      concerts: [concert({
        note: 'On sale now',
        details: ['€45–89', 'Spotted on sale at 10:02'],
        links: [{ label: 'Ticket*master', url: 'https://www.ticketmaster.se/1' }, { label: '', url: 'https://x.test' }],
        tickets: { label: 'Tickets on Songkick', url: 'https://www.songkick.com/concerts/1' },
      })],
    });
    expect(embed.fields[0].value).toBe([
      'Debaser',
      '**On sale now**',
      '€45–89 · Spotted on sale at 10:02',
      // A vendor's name is read as markdown, so it is escaped like a band's.
      '🎟 [Ticket\\*master](https://www.ticketmaster.se/1) · [Tickets on Songkick](https://www.songkick.com/concerts/1)',
    ].join('\n'));
  });

  it('says the date is TBA when there is none', () => {
    const [embed] = buildDiscordEmbeds({ title: 'x', concerts: [concert({ concert_date: null })] });
    expect(embed.fields[0].name).toBe('TBA — Stockholm, SE');
  });

  it('appends the rest of the lineup under the venue', () => {
    const [embed] = buildDiscordEmbeds({
      title: 'x',
      concerts: [concert({ metadata: JSON.stringify(['Opeth', 'Katatonia']) })],
    });
    expect(embed.fields[0].value).toBe('Debaser\nOpeth, Katatonia');
  });

  it('names the acts that joined a show already announced, ahead of its lineup', () => {
    const [embed] = buildDiscordEmbeds({
      title: 'x',
      concerts: [concert({ venue: 'Copenhell', new_acts: ['Gojira', 'Bad_Omens'], metadata: JSON.stringify(['Opeth', 'Gojira']) })],
    });
    expect(embed.fields[0].value).toBe('Copenhell\n**New on the bill:** Gojira, Bad\\_Omens\nOpeth, Gojira');
  });

  it('keeps a field within its limit with added acts and a long lineup', () => {
    const [embed] = buildDiscordEmbeds({
      title: 'x',
      concerts: [concert({ new_acts: ['z'.repeat(500)], metadata: JSON.stringify(['y'.repeat(2000)]) })],
    });
    expect(embed.fields[0].value.length).toBeLessThanOrEqual(1024);
  });

  it('survives metadata that is not valid json', () => {
    // Scraped from several sources, so the column holds whatever they wrote.
    // A parse error here used to take the whole notification down.
    const [embed] = buildDiscordEmbeds({ title: 'x', concerts: [concert({ metadata: '{not json' })] });
    expect(embed.fields[0].value).toBe('Debaser');
  });

  it('counts the concerts in the footer', () => {
    const [embed] = buildDiscordEmbeds({ title: 'x', concerts: [concert(), concert()] });
    expect(embed.footer.text).toBe('2 new concerts');
  });

  it('says "concert" rather than "concerts" for a single one', () => {
    const [embed] = buildDiscordEmbeds({ title: 'x', concerts: [concert()] });
    expect(embed.footer.text).toBe('1 new concert');
  });

  it('starts a second embed past 25 fields, which is Discord\'s cap', () => {
    const embeds = buildDiscordEmbeds({
      title: 'x',
      concerts: Array.from({ length: 26 }, () => concert()),
    });
    expect(embeds).toHaveLength(2);
    expect(embeds[0].fields).toHaveLength(25);
    expect(embeds[1].fields).toHaveLength(1);
  });

  it('starts a second embed before the 6000-character body limit', () => {
    // Discord rejects the whole POST over 6000 characters across an embed, so
    // the split is what keeps a busy festival announcement from vanishing.
    const long = concert({ metadata: JSON.stringify(['x'.repeat(900)]) });
    const embeds = buildDiscordEmbeds({ title: 'x', concerts: [long, long, long, long, long, long, long] });
    expect(embeds.length).toBeGreaterThan(1);
    for (const embed of embeds) {
      const chars = embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
      expect(chars).toBeLessThanOrEqual(5800);
    }
  });

  it('truncates a field name past the 256-character limit', () => {
    const [embed] = buildDiscordEmbeds({ title: 'x', concerts: [concert({ city: 'C'.repeat(400) })] });
    expect(embed.fields[0].name).toHaveLength(256);
    expect(embed.fields[0].name.endsWith('…')).toBe(true);
  });

  it('truncates the lineup so venue and lineup together fit a field value', () => {
    const [embed] = buildDiscordEmbeds({
      title: 'x',
      concerts: [concert({ metadata: JSON.stringify(['y'.repeat(2000)]) })],
    });
    expect(embed.fields[0].value.length).toBeLessThanOrEqual(1024);
  });

  it('returns one empty embed rather than nothing when there are no concerts', () => {
    // The caller posts whatever comes back; an empty array would silently drop
    // the notification instead of showing an empty one.
    const embeds = buildDiscordEmbeds({ title: 'x', concerts: [] });
    expect(embeds).toHaveLength(1);
    expect(embeds[0].fields).toEqual([]);
  });
});

describe('buildRecapEmbed', () => {
  const band = (name, count) => ({ id: name, name, tier: 'LOVE', count });
  const show = (date, ...names) => ({
    id: names.join() + date, concert_date: date && `${date}T00:00:00.000Z`, name: null, venue: 'Arena',
    bands: names.map((name) => ({ id: name, name, tier: 'LOVE' })),
  });
  const recap = (extra = {}) => ({
    week: 40, first_day: '2026-09-28', last_day: '2026-10-04', total: 5, country_count: 2,
    bands: [band('Ghost', 3), band('Opeth', 2)],
    cities: [
      { city: 'Stockholm', country: 'SE', count: 2, concerts: [show('2027-03-12', 'Ghost'), show('2027-03-13', 'Ghost')] },
      { city: 'Berlin', country: 'DE', count: 2, concerts: [show('2027-03-20', 'Ghost'), show(null, 'Opeth')] },
      { city: 'Sölvesborg', country: 'SE', count: 1, concerts: [show('2027-06-05', 'Ghost', 'Opeth')] },
    ],
    ...extra,
  });

  it('says how many concerts, names every band, and lists each city\'s shows by date', () => {
    const embed = buildRecapEmbed(recap());

    expect(embed.title).toBe('Week 40: 5 new concerts');
    expect(embed.description).toBe('28 Sep – 4 Oct 2026 · 3 cities in 2 countries\n\n**Ghost** (3), **Opeth** (2)');
    expect(embed.fields).toEqual([
      { name: '🇸🇪 Stockholm · 2', value: '**12 Mar 2027** — Ghost\n**13 Mar 2027** — Ghost', inline: false },
      { name: '🇩🇪 Berlin · 2', value: '**20 Mar 2027** — Ghost\n**Date TBA** — Opeth', inline: false },
      { name: '🇸🇪 Sölvesborg · 1', value: '**5 Jun 2027** — Ghost, Opeth', inline: false },
    ]);
  });

  it('reads a show\'s day in UTC, as the app does', () => {
    // 23:30 in Stockholm on the 12th is the 12th; read in a zone ahead of
    // UTC it could print as the 13th.
    const embed = buildRecapEmbed(recap({
      cities: [{ city: 'Stockholm', country: 'SE', count: 1, concerts: [{ ...show(null, 'Ghost'), concert_date: new Date('2027-03-12T21:30:00Z') }] }],
    }));

    expect(embed.fields[0].value).toBe('**12 Mar 2027** — Ghost');
  });

  it('keeps a band name from being read as markdown', () => {
    const embed = buildRecapEmbed(recap({
      bands: [band('*shels', 1)],
      cities: [{ city: 'London', country: 'GB', count: 1, concerts: [show('2027-04-01', '*shels')] }],
    }));

    expect(embed.description).toContain('**\\*shels**');
    expect(embed.fields[0].value).toBe('**1 Apr 2027** — \\*shels');
  });

  it('shortens the range when both ends share a month', () => {
    const embed = buildRecapEmbed(recap({ first_day: '2026-10-05', last_day: '2026-10-11', week: 41 }));

    expect(embed.description.startsWith('5–11 Oct 2026 · ')).toBe(true);
  });

  it('spells out both years for a week that crosses into a new one', () => {
    const embed = buildRecapEmbed(recap({ first_day: '2026-12-28', last_day: '2027-01-03', week: 53 }));

    expect(embed.description.startsWith('28 Dec 2026 – 3 Jan 2027 · ')).toBe(true);
  });

  it('names a show with no city as Unknown, and counts no country for it', () => {
    const embed = buildRecapEmbed(recap({
      country_count: 0,
      cities: [{ city: null, country: null, count: 1, concerts: [show('2027-04-01', 'Ghost')] }],
    }));

    expect(embed.fields[0].name).toBe('Unknown city · 1');
    expect(embed.description.startsWith('28 Sep – 4 Oct 2026 · 1 city\n')).toBe(true);
  });

  it('counts the shows left out of a busy city', () => {
    const concerts = Array.from({ length: 20 }, (_, i) => show(`2027-03-${String(i + 1).padStart(2, '0')}`, 'Ghost', 'Opeth'));
    const embed = buildRecapEmbed(recap({ cities: [{ city: 'Stockholm', country: 'SE', count: 20, concerts }] }));

    const lines = embed.fields[0].value.split('\n');
    const shown = lines.length - 1;
    expect(lines[lines.length - 1]).toBe(`+${20 - shown} more shows`);
    expect(embed.fields[0].value.length).toBeLessThanOrEqual(300);
  });

  it('stays inside what Discord takes on a very busy week, and sums the cities left out', () => {
    // Discord refuses an embed over 6000 characters or 25 fields outright,
    // so the post would not arrive at all.
    const name = (i) => `A band with a long name number ${i}`;
    const many = Array.from({ length: 60 }, (_, i) => band(name(i), 2));
    const concerts = Array.from({ length: 10 }, (_, i) => show('2027-03-12', name(i), name(i + 1)));
    const cities = Array.from({ length: 40 }, (_, i) => ({ city: `City ${i}`, country: 'SE', count: 10, concerts }));
    const embed = buildRecapEmbed(recap({ total: 400, bands: many, cities }));

    const size = embed.title.length + embed.description.length
      + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(size).toBeLessThanOrEqual(6000);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    for (const f of embed.fields) expect(f.value.length).toBeLessThanOrEqual(1024);

    const last = embed.fields[embed.fields.length - 1];
    const shown = embed.fields.length - 1;
    expect(last.name).toBe(`+${cities.length - shown} more cities`);
    expect(last.value).toBe(`${(cities.length - shown) * 10} concerts`);
    expect(embed.description).toMatch(/ and \d+ more$/);
  });

  it('stops at 25 fields when every city is short', () => {
    const cities = Array.from({ length: 30 }, (_, i) => ({ city: `C${i}`, country: 'SE', count: 1, concerts: [show('2027-03-12', 'Ghost')] }));
    const embed = buildRecapEmbed(recap({ total: 30, cities }));

    expect(embed.fields).toHaveLength(25);
    expect(embed.fields[24]).toEqual({ name: '+6 more cities', value: '6 concerts', inline: false });
  });
});
