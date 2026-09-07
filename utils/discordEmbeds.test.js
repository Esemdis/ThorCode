import { describe, it, expect } from 'vitest';
import { buildDiscordEmbeds } from './discordEmbeds.js';

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
