import { describe, it, expect } from 'vitest';
import { relevantArtists } from './artistSearch.js';

const a = (name) => ({ id: name, name });
const names = (rows) => rows.map((r) => r.name);

describe('relevantArtists', () => {
  it('drops the artists Spotify threw in because they sound similar', () => {
    // Spotify's search is a recommendation, not a name match: "architects"
    // comes back with Bad Omens, Arch Enemy and Spiritbox behind it, and
    // "nine inch nails" comes back with Johnny Cash.
    const out = relevantArtists(
      [a('Architects'), a('Bad Omens'), a('Arch Enemy'), a('Spiritbox')], 'architects',
    );

    expect(names(out)).toEqual(['Architects']);
  });

  it('keeps every artist whose name contains what you typed', () => {
    const out = relevantArtists([a('Augustine'), a('Bella Boo'), a('Augustines'), a('Augustine Mayuga Gonzales')], 'augustine');

    expect(names(out)).toEqual(['Augustine', 'Augustines', 'Augustine Mayuga Gonzales']);
  });

  it('matches part-way through a word, so it still works as you type', () => {
    const out = relevantArtists([a('Architects'), a('Arch Enemy'), a('Spiritbox')], 'arch');

    expect(names(out)).toEqual(['Architects', 'Arch Enemy']);
  });

  it('ignores punctuation, spacing and case on both sides', () => {
    const out = relevantArtists([a('Blink-182'), a('Sum 41')], 'blink 182');

    expect(names(out)).toEqual(['Blink-182']);
  });

  it('keeps Spotify\'s order', () => {
    const out = relevantArtists([a('The Architect'), a('Architect Co')], 'architect');

    expect(names(out)).toEqual(['The Architect', 'Architect Co']);
  });

  it('falls back to the full list when nothing matches by name', () => {
    // An abbreviation search — "bmth" — matches no name at all, but Spotify
    // put Bring Me The Horizon first for a reason. Returning nothing would be
    // worse than returning what it thinks you meant.
    const out = relevantArtists([a('Bring Me The Horizon'), a('Architects')], 'bmth');

    expect(names(out)).toEqual(['Bring Me The Horizon', 'Architects']);
  });

  it('is empty when Spotify returned nothing', () => {
    expect(relevantArtists([], 'anything')).toEqual([]);
    expect(relevantArtists(null, 'anything')).toEqual([]);
  });
});
