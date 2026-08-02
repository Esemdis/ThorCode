# Day planning

Places you want to visit on a trip, and the day-by-day route through them.

ThorCode owns the places and the saved plan. The solving happens in
[route-planner](https://github.com/esemdis/route-planner), which knows nothing
about trips or users — places in, day plans out. The wire format between them is
`travel-bag/docs/route-planner.md`, which is the contract all three repos are
written against; this file only covers ThorCode's half.

## Endpoints

All of them sit under `/travel/trips/:tripId` and go through `ownsTrip`, so a
trip that is not yours is a 404 before any handler runs.

| Method | Path | |
|---|---|---|
| `GET` | `/places` | The trip's places |
| `POST` | `/places` | Add one, geocoding it if no coordinates were sent |
| `PATCH` | `/places/reorder` | Bulk `sort_order` |
| `PATCH` | `/places/:placeId` | Edit one |
| `POST` | `/places/:placeId/locate` | Retry geocoding a place that has no coordinates |
| `DELETE` | `/places/:placeId` | |
| `GET` | `/plan` | The last plan, with `meta.stale` |
| `POST` | `/plan` | Solve and store |
| `DELETE` | `/plan` | Throw the plan away, keep the places |

`POST /plan` takes solver options in the body — `mode`, `transit`, `max_per_day`,
`time_limit_s`, `balance`, `day_start`, `day_end`, `meals` — all optional.

## Where the decisions live

Two pure modules, both tested, because everything with a rule in it belongs
outside a route handler:

- `utils/travel/planRequest.js` — trip and place rows to a solve request. Owns
  the day expansion, which hotel anchors which day, and which days count as wet.
- `utils/travel/placeInput.js` — validating a place on the way in. Mostly about
  `hours`, the one field where a malformed value survives the write and only
  fails later, inside the solver, as a trip that mysteriously plans nothing.

`utils/travel/routePlanner.js` is the client. A 422 from the solver is the
user's trip being unplannable and keeps its message; anything else becomes a
503, because the trip is fine and the service is not.

## Things worth knowing

**Coordinates are written once and then left alone.** A museum does not move, so
`lat`/`lon` are a column and not a cache. They are also nullable on purpose: a
place nothing could geocode is still kept, and the solver reports it in
`dropped` rather than refusing to plan the trip. `POST /places/:id/locate` is
the retry, and pasting a map link is the method that always works — Nominatim
can only find what OpenStreetMap has mapped.

**`plan_data` is stored whole, not normalised.** It is one immutable answer to
one question, always read in full and always replaced in full, and its shape
belongs to route-planner. Null means never planned, which is a different thing
from an empty plan.

**Staleness is computed, never stored.** `GET /plan` compares `plan_updated_at`
against the places' `updated_at`. A flag would have to be maintained by every
write that touches a place, which is exactly the bookkeeping the next route
someone adds will forget.

**A hotel with `pinned_day` takes over from that date onwards.** That is how a
trip that changes hotel mid-week is expressed, with no second trip and no extra
column.

## Configuration

`ROUTE_PLANNER_URL` — where the solver is. Required; there is no default,
because a default would turn a misconfigured deploy into a connection refused
ten minutes later rather than a sentence saying what is missing.
`ROUTE_PLANNER_TOKEN` is optional and only needed if the solver has one set.

Locally that lives in `.env`, which is gitignored. It works alongside Doppler
rather than instead of it: dotenv does not override variables that are already
set, so Doppler still supplies everything else.

```bash
echo 'ROUTE_PLANNER_URL=http://localhost:8000' >> .env
```

A deployed container never reads that file, so the real environment needs the
secret:

```bash
doppler secrets set ROUTE_PLANNER_URL=http://route-planner:8000
```

## Trying it

Without a database — builds the request from real Paris places, solves it,
prints the itinerary:

```bash
cd ../route-planner && .venv/bin/uvicorn main:app --port 8000 &

cd ../ThorCode
node scripts/plan-demo.js
node scripts/plan-demo.js --transit
```

With one — creates a real trip and prints the curl commands to plan it:

```bash
doppler run -- npx prisma migrate deploy
doppler run -- node scripts/seed-trip-places.js you@example.com --replace
```

The demo fixture keeps Versailles in deliberately. Transit brings it from 289
minutes away to 82, and the planner still declines it, because four hours inside
it displaces about five other sights. "Didn't fit" is an economic verdict, not a
distance one — worth wording carefully wherever the UI surfaces `dropped`.
