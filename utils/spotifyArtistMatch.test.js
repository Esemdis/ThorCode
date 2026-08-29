import { describe, it, expect } from 'vitest';
import { enrichAttractions } from './spotifyArtistMatch.js';

const attraction = (name, over = {}) => ({ id: `tm-${name}`, name, image: null, classifications: [], ...over });

const artist = (name, over = {}) => ({
  name,
  genres: ['melodic death metal'],
  followers: { total: 1234 },
  images: [{ url: `https://i.scdn.co/${name}` }],
  external_urls: { spotify: `https://open.spotify.com/artist/${name}` },
  ...over,
});

describe('enrichAttractions', () => {
  it('attaches the artist whose name matches exactly', () => {
    const [row] = enrichAttractions([attraction('Thrown')], [artist('Thrown')]);

    expect(row.spotify).toEqual({
      genres: ['melodic death metal'],
      followers: 1234,
      image: 'https://i.scdn.co/Thrown',
      spotifyUrl: 'https://open.spotify.com/artist/Thrown',
      matchedName: 'Thrown',
    });
  });

  it('keeps every field the Ticketmaster row already had', () => {
    // The route returns this array straight to the client, so dropping a key
    // here silently removes it from the dropdown.
    const [row] = enrichAttractions([attraction('Thrown', { url: 'https://tm/thrown' })], [artist('Thrown')]);

    expect(row.id).toBe('tm-Thrown');
    expect(row.url).toBe('https://tm/thrown');
  });

  it('matches across diacritics, spacing and punctuation', () => {
    // The two APIs disagree about all three constantly. canonicalBandName
    // already normalises them; these are the cases it buys us.
    const rows = enrichAttractions(
      [attraction('Motorhead'), attraction('Spirit Box'), attraction('blink-182')],
      [artist('Motörhead'), artist('Spiritbox'), artist('Blink 182')],
    );

    expect(rows.map((r) => r.spotify?.matchedName)).toEqual(['Motörhead', 'Spiritbox', 'Blink 182']);
  });

  it('matches a name that differs only by a leading article', () => {
    const rows = enrichAttractions(
      [attraction('The Hu'), attraction('Ghost Inside')],
      [artist('Hu'), artist('The Ghost Inside')],
    );

    expect(rows.map((r) => r.spotify?.matchedName)).toEqual(['Hu', 'The Ghost Inside']);
  });

  it('does not match a near-namesake', () => {
    // The reason there is no fuzzy fallback. Architects/Architect scores 0.941
    // on stringSimilarity — higher than The Anthrax/Anthrax, which is the same
    // band. Character overlap cannot tell these apart, so we do not try.
    const [row] = enrichAttractions([attraction('Architects')], [artist('Architect')]);

    expect(row.spotify).toBeNull();
  });

  it('gives one artist to only the first attraction that claims it', () => {
    // Ticketmaster returns tribute acts and re-registrations under the same
    // name. Both rows showing the same follower count reads as a bug.
    const rows = enrichAttractions([attraction('Nova'), attraction('NOVA')], [artist('Nova')]);

    expect(rows[0].spotify?.matchedName).toBe('Nova');
    expect(rows[1].spotify).toBeNull();
  });

  it('leaves every row unenriched when Spotify did not answer', () => {
    // The invariant that matters: enrichment is decoration, and the search has
    // to keep working when Spotify 429s or is not configured at all.
    const rows = enrichAttractions([attraction('Thrown'), attraction('Loathe')], null);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.spotify === null)).toBe(true);
  });

  it('leaves rows unenriched when Spotify answered with nothing', () => {
    const rows = enrichAttractions([attraction('Thrown')], []);

    expect(rows[0].spotify).toBeNull();
  });

  it('survives an artist with no genres, image or follower count', () => {
    // Spotify returns genres: [] for a large share of artists, and smaller ones
    // often have no image. This is the normal path, not an error path.
    const [row] = enrichAttractions(
      [attraction('Thrown')],
      [{ name: 'Thrown', genres: [], followers: null, images: [], external_urls: {} }],
    );

    expect(row.spotify).toEqual({
      genres: [], followers: null, image: null, spotifyUrl: null, matchedName: 'Thrown',
    });
  });

  it('is empty for no attractions at all', () => {
    expect(enrichAttractions([], [artist('Thrown')])).toEqual([]);
    expect(enrichAttractions(null, null)).toEqual([]);
  });
});
