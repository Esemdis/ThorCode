# Spotify artist enrichment on band search

Adding a band starts with a search you cannot judge. The Ticketmaster
autocomplete in `AddBandModal` gives a name, sometimes an event banner, and a
classification like `Rock / Alternative` — not enough to tell the band you meant
from the covers act with the same name. This puts Spotify's artist data behind
that dropdown: genres, follower count, a press photo.

## What this is not

Spotify does not become the source of band identity.

`Band.ticketmaster_id` is `@unique` and is the join key the whole ingest
pipeline runs on: `services/music_api.py` fetches events by `attractionId`, and
`main.py` only pulls tours for a band that has one. Picking a Spotify artist
instead of a Ticketmaster attraction would create a band that never gets
concerts. So the Ticketmaster result stays the thing you select, and Spotify
data is attached to it for display only.

Nothing here is persisted. No migration, no `spotify_id` column. The enrichment
is computed onto a search response and thrown away, which is what makes a wrong
name match harmless — it can put the wrong genres under a name for one render,
and it can never write a bad row.

## The matching problem

Ticketmaster and Spotify share no identifier, so the join is by name, and one
Spotify search per query is matched onto the whole Ticketmaster result set
rather than one lookup per row. Ten attractions would otherwise mean ten Spotify
searches per debounced keystroke.

Matching by name is a hint, not a claim, and the UI says so.

## Where the decisions live

Two halves, following `setlistPlaylist.js` / `spotify.js`: the judgement is pure
and tested without a token, the network is not.

**`utils/spotify.js`** gains the two functions that talk to Spotify:

- `getAppToken()` — a `client_credentials` grant. Artist search needs no user
  scope, and most users have not connected Spotify, so this cannot use
  `getValidToken`. Reuses the existing `basicAuthHeader()` and
  `EXPIRY_MARGIN_MS`. Held in a module-level memo rather than Redis: it is one
  token per process, and re-fetching it on a cold start is cheaper than a cache
  round trip.
- `searchArtists(token, query)` — `GET /v1/search?type=artist`, at the same
  `SEARCH_LIMIT = 10` the file already documents for dev-mode apps.

**`utils/spotifyArtistMatch.js`** is new and pure:

```
enrichAttractions(attractions, artists) -> attraction[]
```

Each returned attraction is the Ticketmaster one with a `spotify` key added,
either `null` or `{ genres, followers, image, spotifyUrl, matchedName }`.

`artists` is nullable, and `null` means *Spotify did not answer*. That is
deliberate: it puts the "enrichment must never break the search" invariant
inside the pure function, where it can be tested. ThorCode has no route tests —
all twenty test files are pure unit tests, and `externalSetlists.test.js`
records why (vitest externalises `node_modules`, so a CommonJS `require('axios')`
never sees a mock and assertions against one pass for the wrong reason). Putting
the fallback in the route would have made the one invariant that matters
untestable.

Matching is **exact on a canonical key**, and there is no fuzzy fallback. The
key is `canonicalBandName` from `utils/lineupNames.js` — which strips diacritics
and punctuation, so *Motörhead* meets *Motorhead* and *Spirit Box* meets
*Spiritbox* — applied after removing a leading `The`, `A` or `An`.

### Why there is no fuzzy pass

The obvious design was a `stringSimilarity` fallback above some threshold. It
was measured against real band names before being written, and the two score
distributions overlap, so no threshold exists:

| | pair | score |
|---|---|---|
| Different bands | Architects / Architect | 0.941 |
| | Loathe / Loath | 0.889 |
| | The Used / The Uses | 0.833 |
| Same band | The Anthrax / Anthrax | 0.800 |
| | The Hu / Hu | 0.400 |

Any cutoff admits at least one wrong band or rejects at least one right one.
The reason is structural rather than a matter of tuning: `stringSimilarity` is a
bigram score, so it rewards character overlap — but the same band spelled two
ways differs by whole *words* (an article, an abbreviation), while two different
bands routinely differ by one character (a plural, a near-namesake). The metric
scores the wrong axis.

Exact matching on the canonical key, over the same sixteen pairs, produced seven
correct matches, zero wrong matches, eight correct rejections and one miss
(*Nine Inch Nails* / *NIN*, which no string metric resolves). The variation that
actually occurs between these two APIs — punctuation, spacing, diacritics,
articles — is a set of rules, and rules belong in the key, not in a threshold.

Each Spotify artist is consumed at most once, so two attractions sharing a
canonical key cannot both claim it; the first wins, which is the higher-ranked
Ticketmaster result.

`matchedName` carries Spotify's spelling so the UI can show it when it differs
from the Ticketmaster name. A match that had to go through the similarity
fallback is a guess, and hiding that makes it look like a lookup.

## The route

`GET /data/concerts/bands/ticketmaster-search` keeps its contract and gains a
`spotify` key on each result, `null` where nothing matched.

The Spotify call runs alongside the Ticketmaster one. **Enrichment is never
allowed to break the search**, which is the only invariant in this document that
matters at runtime:

- Spotify 429s, errors, or times out → return the Ticketmaster results
  unenriched.
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` unset → skip Spotify entirely,
  no error. Unlike `routes/oauth/spotify.js`, which 503s on missing config
  because connecting is the whole point of that route, here the feature is
  optional decoration.

The merged response is cached per normalised query with `setCache` from
`utils/cache.js`, TTL 6h, matching the existing per-query caches in this file.
Backspacing a character then retyping it costs nothing.

## The UI

`AddBandModal`, in the `From Ticketmaster` block only:

| | Today | With enrichment |
|---|---|---|
| Image | `attraction.images[0]` — often an event banner | Spotify's press photo, falling back to the banner |
| Genres | `Rock / Alternative` | Spotify's tags, falling back to the classifications |
| Scale | — | Follower count |

The section header becomes `From Ticketmaster · info from Spotify`. The rows are
still Ticketmaster attractions; only the decoration is Spotify's, and the header
should not imply the list came from there.

## Testing

Vitest, as everywhere else here.

`spotifyArtistMatch` gets the unit tests, because it holds all the judgement:
exact match, diacritics, spacing (*Spirit Box* / *Spiritbox*), a leading `The`,
two attractions sharing a canonical key against one Spotify artist, a
near-namesake that must **not** match (*Architects* / *Architect*), no match at
all, and an empty Spotify response.

At the route level, one test that matters: Spotify failing still returns the
Ticketmaster results. Everything else about this feature can be broken and the
band still gets added.

## Known limits

**The 10-result cap.** Spotify's dev-mode search returns at most 10 artists, so
an obscure band may not be in the response at all even though it exists. Those
rows stay exactly as they look today. This is the expected case for small local
acts, not a bug.

**Empty genres.** Spotify returns `genres: []` for a large share of artists,
particularly smaller ones. The fallback to Ticketmaster classifications is the
normal path for those, not an error path.

**Names that differ by more than punctuation stay unenriched.** Abbreviations
(*NIN*) and genuine spelling disagreements between the two APIs will not match,
by design. If this turns out to be common in real use, the next step is a better
key — token-set overlap, or seeding Spotify ids from the `Band.MBID` column via
MusicBrainz — not a lowered threshold. The measurements above are why.

**One external call in the typing path.** The query cache absorbs repeats, but a
first-time query now depends on two APIs instead of one. This is why the failure
behaviour above is specified before the happy path.
