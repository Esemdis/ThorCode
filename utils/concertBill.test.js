import { describe, it, expect } from 'vitest';
import { billForConcert } from './concertBill.js';

const linked = (id, name, over = {}) => ({ id, name, setlist: null, recent_setlist: null, ...over });

describe('billForConcert', () => {
  it('lists the acts with a band row first, in the order the concert gives them', () => {
    const bill = billForConcert({ bands: [linked(92, 'Gojira'), linked(7, 'Alcest')], metadata: null });
    expect(bill.map((b) => [b.id, b.name])).toEqual([[92, 'Gojira'], [7, 'Alcest']]);
    expect(bill.every((b) => b.linked)).toBe(true);
  });

  it('adds the support acts that exist only as a name in the scraped lineup', () => {
    // These have no Band row anywhere, so nothing for ConcertMedia.band_id to
    // point at. They are on the bill regardless, and the gig view is the only
    // place that says who played.
    const bill = billForConcert({
      bands: [linked(92, 'Gojira')],
      metadata: JSON.stringify(['Gojira', 'Svalbard']),
    });
    expect(bill.map((b) => b.name)).toEqual(['Gojira', 'Svalbard']);
    expect(bill.find((b) => b.name === 'Svalbard')).toMatchObject({ id: null, linked: false });
  });

  it('does not list an act twice when the scraper spells it differently', () => {
    // "Architects (UK)" in the metadata and "Architects" as a band row are one
    // act. Matched on the canonical form, the same comparison enrich-lineup
    // uses — a similarity score read "Alestorm" as "Halestorm" at 0.93.
    const bill = billForConcert({
      bands: [linked(5, 'Architects')],
      metadata: JSON.stringify(['Architects (UK)']),
    });
    expect(bill).toHaveLength(1);
    expect(bill[0]).toMatchObject({ id: 5, linked: true });
  });

  it('cleans the follower count the scraper welds onto a name', () => {
    // Bandsintown concatenates the artist and their follower count with no
    // separator, so names arrive as "Counterparts266K Followers".
    const bill = billForConcert({ bands: [], metadata: JSON.stringify(['Counterparts266K Followers']) });
    expect(bill.map((b) => b.name)).toEqual(['Counterparts']);
  });

  it('lists a repeated name once', () => {
    const bill = billForConcert({ bands: [], metadata: JSON.stringify(['Svalbard', 'Svalbard']) });
    expect(bill).toHaveLength(1);
  });

  it('keeps the setlists that came with a linked act', () => {
    const bill = billForConcert({
      bands: [linked(92, 'Gojira', { setlist: { songs: [{ name: 'Stranded' }] } })],
      metadata: null,
    });
    expect(bill[0].setlist).toEqual({ songs: [{ name: 'Stranded' }] });
  });

  it('gives an unlinked act no setlist rather than someone else\'s', () => {
    const bill = billForConcert({ bands: [], metadata: JSON.stringify(['Svalbard']) });
    expect(bill[0]).toMatchObject({ setlist: null, recent_setlist: null });
  });

  it('survives metadata that is not a lineup at all', () => {
    // It is a free-form text column and older rows hold other things.
    expect(billForConcert({ bands: [], metadata: 'not json' })).toEqual([]);
    expect(billForConcert({ bands: [], metadata: '{"note":"x"}' })).toEqual([]);
    expect(billForConcert({ bands: [], metadata: undefined })).toEqual([]);
  });

  it('drops a name that cleans away to nothing', () => {
    expect(billForConcert({ bands: [], metadata: JSON.stringify(['', '   ', 'Svalbard']) }))
      .toHaveLength(1);
  });
});
