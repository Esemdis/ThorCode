# Spotify Artist Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Spotify genres, follower counts and press photos on the Ticketmaster results in concert-map's Add Band dropdown, so a band can be judged before it is added.

**Architecture:** Ticketmaster stays the source of band identity — `Band.ticketmaster_id` is the join key the ingest pipeline runs on. One Spotify artist search per query is matched onto the whole Ticketmaster result set by exact canonical name, and the result is decoration that is never persisted. All judgement lives in a pure util; only the HTTP calls live in `utils/spotify.js` and the route.

**Tech Stack:** Node/Express + Prisma (ThorCode), React + Vite (concert-map), Vitest both sides, Redis via `utils/cache.js`, Spotify Web API `client_credentials` grant.

**Spec:** `docs/superpowers/specs/2026-08-29-spotify-artist-enrichment-design.md`

## Global Constraints

- **Two repos.** Tasks 1–3 are in `/home/esemdis/Documents/ThorCode`. Task 4 is in `/home/esemdis/Documents/concert-map`. Commit in the repo you are working in.
- **ThorCode source is CommonJS** (`require` / `module.exports`); ThorCode *tests* are ESM (`import ... from './x.js'`). Vitest handles the interop. Match that split exactly.
- **Never mock axios in ThorCode.** Vitest externalises `node_modules`, so a CommonJS `require('axios')` never sees the mock and the assertion passes for the wrong reason. This is documented at the top of `utils/externalSetlists.test.js`. Anything worth testing must be pure or take injected data.
- **No schema migration.** Do not add a `spotify_id` column. Nothing from Spotify is persisted.
- **Comments explain why, never what.** This codebase opens non-obvious blocks with the problem they solve. Match that register.
- **Test names are sentences about behaviour**, e.g. `'matches a name that differs only by a leading The'`, not `'test matchKey'`.
- Spotify dev-mode search returns at most **10** results; `SEARCH_LIMIT = 10` already exists in `utils/spotify.js`.
- Cache TTL for the merged search response: **21600** (6h), matching the sibling cache at `routes/data/bands.js:1545`.

---

### Task 1: The pure matcher

All the judgement in this feature lives here, so this is the task with real tests.

**Files:**
- Create: `utils/spotifyArtistMatch.js`
- Test: `utils/spotifyArtistMatch.test.js`

**Interfaces:**
- Consumes: `canonicalBandName` from `utils/lineupNames.js` (strips a trailing parenthetical, diacritics, and every non-alphanumeric, then lowercases).
- Produces: `enrichAttractions(attractions, artists) -> attraction[]`. Each returned element is the input attraction with an added `spotify` key: `null`, or `{ genres: string[], followers: number|null, image: string|null, spotifyUrl: string|null, matchedName: string }`. `artists` may be `null`, meaning Spotify did not answer; every row then comes back with `spotify: null`. Task 3 calls this.

- [ ] **Step 1: Write the failing test**

Create `utils/spotifyArtistMatch.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- utils/spotifyArtistMatch.test.js`
Expected: FAIL — `Failed to resolve import "./spotifyArtistMatch.js"`.

- [ ] **Step 3: Write the implementation**

Create `utils/spotifyArtistMatch.js`:

```js
// Attaching Spotify artist data to Ticketmaster search results.
//
// The two APIs share no identifier, so the join is by name, and it is exact on
// a canonical key rather than fuzzy. A stringSimilarity fallback was measured
// first and abandoned: Architects/Architect scores 0.941 while The
// Anthrax/Anthrax scores 0.800, so no threshold admits the right bands without
// admitting wrong ones. Bigram overlap rewards character similarity, but the
// same band spelled two ways differs by whole words while two different bands
// differ by one character. See the design doc for the full measurement.
//
// Nothing here is persisted, which is what makes a wrong match cheap: it is one
// render of the wrong genres, never a bad row.

const { canonicalBandName } = require('./lineupNames');

// Ticketmaster and Spotify disagree about the article often enough to matter,
// and it is a rule rather than a guess, so it belongs in the key.
const LEADING_ARTICLE = /^\s*(?:the|a|an)\s+/i;

function matchKey(name) {
  if (typeof name !== 'string') return '';
  return canonicalBandName(name.replace(LEADING_ARTICLE, ''));
}

function enrichmentFrom(artist) {
  return {
    genres: Array.isArray(artist.genres) ? artist.genres : [],
    followers: artist.followers?.total ?? null,
    image: artist.images?.[0]?.url ?? null,
    spotifyUrl: artist.external_urls?.spotify ?? null,
    matchedName: artist.name ?? '',
  };
}

/**
 * Merge a Spotify artist search into a Ticketmaster attraction list.
 *
 * @param {object[]} attractions - Ticketmaster rows, in relevance order.
 * @param {object[]|null} artists - Spotify artists, or null when Spotify did
 *   not answer. Null is a supported input, not a bug: enrichment is decoration
 *   and the search must survive Spotify being down or unconfigured.
 * @returns {object[]} The attractions, each with a `spotify` key.
 */
function enrichAttractions(attractions, artists) {
  const byKey = new Map();
  for (const artist of artists ?? []) {
    const key = matchKey(artist?.name);
    // First Spotify result wins a key: they arrive in relevance order, so the
    // first is the one a person searching that name meant.
    if (key && !byKey.has(key)) byKey.set(key, artist);
  }

  return (attractions ?? []).map((attraction) => {
    const key = matchKey(attraction?.name);
    const artist = key ? byKey.get(key) : undefined;
    if (!artist) return { ...attraction, spotify: null };
    // Consumed, so a duplicate Ticketmaster row does not show the same
    // follower count twice as though it were a second band.
    byKey.delete(key);
    return { ...attraction, spotify: enrichmentFrom(artist) };
  });
}

module.exports = { enrichAttractions };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- utils/spotifyArtistMatch.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole suite to check nothing else broke**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add utils/spotifyArtistMatch.js utils/spotifyArtistMatch.test.js
git commit -m "feat: match Spotify artists onto Ticketmaster attractions by canonical name"
```

---

### Task 2: The Spotify calls

**Files:**
- Modify: `utils/spotify.js` (add two functions and extend `module.exports`)

**Interfaces:**
- Consumes: the module's existing `ACCOUNTS_URL`, `API_URL`, `SEARCH_LIMIT`, `basicAuthHeader()`, `expiryFrom()`, `getWithBackoff()`, `SpotifyAuthError`, `clientId()`, `clientSecret()`.
- Produces: `searchArtists(query) -> Promise<object[]>`, returning raw Spotify artist objects (the shape Task 1's `enrichAttractions` consumes). Throws on any failure; Task 3 catches. Also exports `getAppToken()`.

**No test.** This is the network half, and the house rule in `utils/externalSetlists.test.js` is that axios cannot be mocked here. `utils/spotify.js` has no test file today for the same reason; the judgement it feeds is tested in Task 1.

- [ ] **Step 1: Add the two functions**

In `utils/spotify.js`, insert after `getValidToken` (before `const sleep = ...`):

```js
// An app-level token, for reads that are about an artist rather than about a
// user. Artist search needs no scope, and most users have never connected
// Spotify, so getValidToken is the wrong door entirely.
//
// Held in a module-level memo rather than Redis: it is one token per process,
// and re-fetching it on a cold start is cheaper than a cache round trip.
let appToken = null;

/**
 * A client-credentials token for the app itself.
 *
 * @throws {SpotifyAuthError} When the server has no Spotify credentials.
 */
async function getAppToken() {
  if (appToken && appToken.expiresAt > Date.now()) return appToken.value;

  if (!clientId() || !clientSecret()) {
    throw new SpotifyAuthError('Spotify is not configured on this server');
  }

  const { data } = await axios.post(
    `${ACCOUNTS_URL}/api/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  appToken = { value: data.access_token, expiresAt: expiryFrom(data.expires_in).getTime() };
  return appToken.value;
}
```

Then insert after `findTrack`:

```js
/**
 * Artists matching a free-text query, in Spotify's relevance order.
 *
 * Capped at SEARCH_LIMIT like every other search here — dev-mode apps error on
 * a larger limit rather than truncating.
 *
 * @returns {Promise<object[]>} Raw artist objects; the caller decides what of
 *   them to use.
 */
async function searchArtists(query) {
  const token = await getAppToken();
  const { data } = await getWithBackoff(`${API_URL}/search`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type: 'artist', limit: SEARCH_LIMIT },
  });
  return data?.artists?.items ?? [];
}
```

- [ ] **Step 2: Export them**

In the `module.exports` block at the bottom of `utils/spotify.js`, add `getAppToken,` and `searchArtists,` after `getValidToken,`.

- [ ] **Step 3: Verify the module still loads**

Run: `node -e "const s=require('./utils/spotify'); console.log(typeof s.searchArtists, typeof s.getAppToken)"`
Expected: `function function`

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS — unchanged from Task 1.

- [ ] **Step 5: Commit**

```bash
git add utils/spotify.js
git commit -m "feat: add app-level Spotify token and artist search"
```

---

### Task 3: Wire the search route

**Files:**
- Modify: `routes/data/bands.js` — imports at the top, and the `GET /bands/ticketmaster-search` handler at lines 1203–1263.

**Interfaces:**
- Consumes: `searchArtists` (Task 2), `enrichAttractions` (Task 1), and the already-imported `setCache` / `getCache` from `utils/cache.js` (line 16).
- Produces: the route response gains a `spotify` key per row — `null`, or `{ genres, followers, image, spotifyUrl, matchedName }`. Task 4 renders it.

- [ ] **Step 1: Add the imports**

At the top of `routes/data/bands.js`, after the `lineupNames` require (line 8):

```js
const { searchArtists } = require('../../utils/spotify');
const { enrichAttractions } = require('../../utils/spotifyArtistMatch');
```

- [ ] **Step 2: Add the cache read**

In the `/bands/ticketmaster-search` handler, immediately after `const searchTerm = q.trim();`:

```js
    const cacheKey = `tm:search:${searchTerm.toLowerCase()}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);
```

- [ ] **Step 3: Enrich and cache before responding**

Replace the handler's `res.json(bands);` with:

```js
      // Spotify is decoration. A 429, a bad credential, no credential at all —
      // none of it may take the search down with it, so a failure becomes a
      // null artist list and every row comes back exactly as it does today.
      let artists = null;
      try {
        artists = await searchArtists(searchTerm);
      } catch (error) {
        console.warn('[spotify] Artist enrichment failed:', error.response?.data ?? error.message);
      }

      const payload = enrichAttractions(bands, artists);
      await setCache(cacheKey, payload, 21600); // 6h — an artist's genres and follower count barely move
      res.json(payload);
```

Note there is no `if (SPOTIFY_CLIENT_ID && ...)` guard: `getAppToken` already throws `SpotifyAuthError` when the credentials are missing, and the `catch` handles it. One path for every failure is easier to keep correct than two.

- [ ] **Step 4: Verify the route file parses and the suite still passes**

Run: `node --check routes/data/bands.js && npm test`
Expected: no output from `node --check`, then PASS.

- [ ] **Step 5: Verify the shape by hand**

Run: `npm run dev` in one shell, then in another:

```bash
curl -s 'http://localhost:3000/data/concerts/bands/ticketmaster-search?q=spiritbox' | head -c 600
```

Expected: JSON rows that each carry a `spotify` key. If Spotify credentials are not configured locally, expect `"spotify":null` on every row **and a 200** — that is the invariant working, not a failure.

- [ ] **Step 6: Commit**

```bash
git add routes/data/bands.js
git commit -m "feat: enrich Ticketmaster band search with Spotify artist data"
```

---

### Task 4: Show it in the dropdown

**Repo: `/home/esemdis/Documents/concert-map`.**

**Files:**
- Modify: `src/components/AddBandModal.jsx` — the `From Ticketmaster` block only
- Test: `src/components/AddBandModal.test.jsx` (create)

**Interfaces:**
- Consumes: each Ticketmaster result now carries `band.spotify` — `null`, or `{ genres, followers, image, spotifyUrl, matchedName }` (Task 3).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `src/components/AddBandModal.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AddBandModal from './AddBandModal';

vi.mock('../utils/api', () => ({ apiGet: vi.fn() }));
import { apiGet } from '../utils/api';

const tmRow = (over = {}) => ({
  id: 'K8vZ', name: 'Spiritbox', image: 'https://tm/banner.jpg',
  classifications: [{ genre: 'Rock', subGenre: 'Alternative' }],
  spotify: null, ...over,
});

const spotify = (over = {}) => ({
  genres: ['progressive metalcore'], followers: 812345,
  image: 'https://i.scdn.co/press.jpg',
  spotifyUrl: 'https://open.spotify.com/artist/x', matchedName: 'Spiritbox', ...over,
});

const show = (rows) => {
  apiGet.mockImplementation((path) => Promise.resolve(
    path.includes('ticketmaster-search') ? rows : [],
  ));
  return render(
    <AddBandModal
      showModal onClose={vi.fn()} newBandName="spirit" setNewBandName={vi.fn()}
      isAddingBand={false} addBandError="" setAddBandError={vi.fn()} addBandSuccess=""
      onAddBand={vi.fn()} darkMode selectedTier="LIKE" setSelectedTier={vi.fn()}
    />,
  );
};

beforeEach(() => { vi.clearAllMocks(); });

describe('AddBandModal Ticketmaster results', () => {
  it('shows the Spotify genres instead of the Ticketmaster classification', async () => {
    show([tmRow({ spotify: spotify() })]);

    expect(await screen.findByText('progressive metalcore')).toBeInTheDocument();
    expect(screen.queryByText('Rock')).not.toBeInTheDocument();
  });

  it('falls back to the Ticketmaster classification when Spotify has no genres', async () => {
    // Spotify returns genres: [] for a large share of artists. Showing nothing
    // there would be a regression on what the dropdown displays today.
    show([tmRow({ spotify: spotify({ genres: [] }) })]);

    expect(await screen.findByText('Rock')).toBeInTheDocument();
  });

  it('prefers the Spotify press photo over the Ticketmaster event banner', async () => {
    show([tmRow({ spotify: spotify() })]);

    const img = await screen.findByAltText('Spiritbox');
    expect(img).toHaveAttribute('src', 'https://i.scdn.co/press.jpg');
  });

  it('shows the follower count as a sense of scale', async () => {
    show([tmRow({ spotify: spotify() })]);

    expect(await screen.findByText(/812,345 followers/)).toBeInTheDocument();
  });

  it('renders a row Spotify could not match exactly as it does today', async () => {
    show([tmRow()]);

    expect(await screen.findByText('Rock')).toBeInTheDocument();
    expect(screen.getByAltText('Spiritbox')).toHaveAttribute('src', 'https://tm/banner.jpg');
    expect(screen.queryByText(/followers/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/AddBandModal.test.jsx`
Expected: FAIL — the genre assertion finds `Rock`, not `progressive metalcore`.

- [ ] **Step 3: Add the formatter**

At the top of `src/components/AddBandModal.jsx`, below the existing `TIERS` const:

```jsx
// Spotify follower counts run to eight figures; the raw number is unreadable at
// 11px in a dropdown row.
const followerLabel = (n) => (typeof n === 'number' ? `${n.toLocaleString('en-US')} followers` : null);
```

- [ ] **Step 4: Render the Spotify data**

In the `tmResults.map(...)` block, replace the row body — from `<div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>` through its closing `</div>` — with:

```jsx
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {(band.spotify?.image || band.image) && (
                          <img
                            src={band.spotify?.image || band.image}
                            alt={band.name}
                            style={{ width: '34px', height: '34px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
                          />
                        )}
                        <div>
                          <div style={{ fontWeight: '500', fontSize: '14px' }}>{band.name}</div>
                          {/* Spotify's tags are far more specific than Ticketmaster's
                              Rock / Alternative, but it returns none at all for a lot
                              of smaller artists — so the classification stays as the
                              fallback rather than being replaced outright. */}
                          {band.spotify?.genres?.length > 0 ? (
                            <div style={{ display: 'flex', gap: '4px', marginTop: '2px', flexWrap: 'wrap' }}>
                              {band.spotify.genres.slice(0, 2).map((g) => (
                                <span key={g} style={{ fontSize: '11px', backgroundColor: dm ? '#121722' : '#f0f0f0', color: dm ? '#e5e7eb' : '#666', padding: '1px 6px', borderRadius: '10px' }}>
                                  {g}
                                </span>
                              ))}
                            </div>
                          ) : band.classifications?.length > 0 && (
                            <div style={{ display: 'flex', gap: '4px', marginTop: '2px', flexWrap: 'wrap' }}>
                              {band.classifications.slice(0, 2).map((c, idx) => (
                                <span key={idx} style={{ fontSize: '11px', backgroundColor: dm ? '#121722' : '#f0f0f0', color: dm ? '#e5e7eb' : '#666', padding: '1px 6px', borderRadius: '10px' }}>
                                  {c.genre || c.subGenre}
                                </span>
                              ))}
                            </div>
                          )}
                          {followerLabel(band.spotify?.followers) && (
                            <div style={{ fontSize: '11px', color: dm ? '#6b7280' : '#888', marginTop: '2px' }}>
                              {followerLabel(band.spotify.followers)}
                            </div>
                          )}
                        </div>
                      </div>
```

- [ ] **Step 5: Relabel the section header**

In the same block, change the header text `From Ticketmaster` to:

```jsx
                    From Ticketmaster · info from Spotify
```

The rows are Ticketmaster attractions; only the decoration is Spotify's, matched by name. The header should not imply the list came from Spotify.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/components/AddBandModal.test.jsx`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the suite and the linter**

Run: `npm test && npx eslint src/components/AddBandModal.jsx`
Expected: PASS, no lint errors. (JSX comments in expression position are a known build-breaker in this codebase — the comment added in Step 4 sits inside a `? :` branch, which is safe, but lint after editing JSX regardless.)

- [ ] **Step 8: Commit**

```bash
git add src/components/AddBandModal.jsx src/components/AddBandModal.test.jsx
git commit -m "feat: show Spotify genres, photo and followers on band search results"
```
