# Spotify replaces Ticketmaster as the band search

Adding a band goes through Ticketmaster today. This replaces that with Spotify
and stops writing `ticketmaster_id` for new bands.

## Why

Ticketmaster earns 1.1% of the upcoming concert list. Measured on 2026-08-30
against the live database, `Concert.source` for the 617 upcoming concerts:

| source | concerts | share |
|---|---|---|
| songkick | 258 | 41.8% |
| bandsintown | 195 | 31.6% |
| *(null, pre-dating the column)* | 157 | 25.4% |
| **ticketmaster** | **7** | **1.1%** |

115 of 120 bands have a Songkick URL and 113 have Bandsintown; five have
neither.

For that 1.1%, Ticketmaster is also:

- **The gatekeeper on adding anything.** `POST /data/concerts/bands` resolves
  every new band through the attractions API and returns `404 "No band found."`
  when it misses — even when the name was typed by hand. An act Ticketmaster
  does not carry cannot be added at all.
- **The source of the noise in the picker.** Its catalogue answers a band search
  with films (`Augustine`, segment `Film`), plays (`Die dumme Augustine`), art
  installations (`Architects of Air`), a basketball team (`Saint Augustine
  Falcons Basketball`), tribute acts (`NIN UK - Nine Inch Nails Tribute`) and
  multi-act bills (`Architects, Spiritbox, Loathe`).

And it is not load-bearing for concerts. Everything that actually produces them
keys off the **name**: MusicBrainz resolves the MBID from `bandData.name`, and
`findSourceUrls(name, mbid)` resolves the Songkick and Bandsintown URLs.
`POST /bands/:bandId/sync-concerts` already refuses to run without one of those
two URLs, while treating `ticketmaster_id` as optional.

So Ticketmaster's only irreplaceable job in this flow is handing over a
canonical artist name — which Spotify does better, because its catalogue
contains recording artists and nothing else.

## What changes

**New:** `GET /data/concerts/bands/artist-search?q=` returns Spotify artists as
`{ id, name, image, spotifyUrl, lastfm }`, with Last.fm tags and listeners on
the first three, cached per query for 6h. Same shape the dropdown already
renders, minus the Ticketmaster fields.

**Gone:** `GET /data/concerts/bands/ticketmaster-search`, and with it
`utils/spotifyArtistMatch.js` (`enrichAttractions`) and `utils/attractions.js`
(`collapseDuplicates`). Both existed only to make Ticketmaster's results usable
— matching Spotify artists onto attractions by name, and collapsing the
duplicate attraction records. Neither problem exists once the list comes from
Spotify, so they go rather than linger as dead code.

**Changed:** `POST /data/concerts/bands` takes a `name` and uses it. The
attractions lookup, the `ticketmaster_id` it resolved, and both 404 paths are
removed; MusicBrainz and `findSourceUrls` already run off the name. The two
`pythonServicePost` sync calls stop passing `ticketmaster_id`, which is what
stops Ticketmaster being polled for events.

**Unchanged:** the `Band.ticketmaster_id` column and every value already in it.
There is no migration. Nothing reads the column after this except the admin
`GET /bands` listing, so the existing ids are inert history rather than a
dependency — recoverable if this is ever reversed.

## What this costs

**Those 7 concerts, and any future Ticketmaster-only gig.** Accepted
deliberately: it is 1.1%, and the same gigs are largely carried by Songkick and
Bandsintown, which is what the other 73% comes from.

**Bands Spotify does not carry** become unaddable, the way bands Ticketmaster
did not carry are unaddable today. This is a narrower gate rather than a new
one: Spotify's catalogue of recording artists is a better fit for "a band whose
tours I want to follow" than a ticketing catalogue that also lists basketball.
The free-typed name path stays, so a name can still be added without picking a
search result.

## Testing

The pure work is gone rather than added — the two deleted modules take their
tests with them. What remains is a route returning what Spotify returned, and
the existing `artistTags` tests still cover the Last.fm shaping.

Verify live before believing it: search a band, add one, and confirm concerts
arrive from Songkick or Bandsintown. A green suite has twice now been
compatible with this feature not working.
