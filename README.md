# ThorCode

The Express API behind two personal apps:

- **[concert-map](https://github.com/esemdis/concert-map)** tracks bands, their upcoming shows, the shows you went to, and the photos and videos from them.
- **travel-bag** plans trips: places, day routes, packing, gear and reviews.

The API runs as one Node process against Postgres through Prisma. Two other services do work for it:

- **[python-crohn](https://github.com/esemdis/python-crohn)** scrapes concerts from Songkick and Bandsintown, and fetches setlists and weather. It posts the results back here.
- **[route-planner](https://github.com/esemdis/route-planner)** solves a trip's day-by-day route.

## What is in it

| Area | Mounted at | Code |
| --- | --- | --- |
| Accounts | `/users` | `routes/users.js`. Covers register, login, settings and email change. Email verification goes through Resend. |
| Bands and concerts | `/data/concerts` | `routes/data/bands/`. Covers ingest from the scraper, search, band pages, setlists and admin. |
| Wishlists and attendance | `/data/concerts` | `routes/data/wishlists/`. Covers wishlists, the shows you went to and the ones you missed, and the ICS calendar feed. |
| Notifications | `/data/concerts` | `routes/data/notifications.js` handles subscriptions to a band, a city or a festival. New shows go to the wishlist's Discord webhook as the scraper reports them, and a daily email digest goes out by cron. |
| Photo and video archive | `/data/concerts` | `routes/data/media/`. Covers upload, tagging, 12-hour share links and byte serving. See [docs/concert-media-runbook.md](docs/concert-media-runbook.md). |
| Setlist playlists | `/data/concerts`, `/oauth/spotify`, `/oauth/tidal` | `routes/data/playlists.js` builds a Spotify or Tidal playlist from a night's setlists, on whichever the user chose in Settings. |
| Cities | `/data/cities` | City list, and weather written in bulk by the sync service. |
| Health | `/data/concerts/health` | How much work each nightly job has waiting, for the admin panel. |
| Travel | `/travel/*` | `routes/travel/`. Covers trips, places and day plans ([docs/day-planning.md](docs/day-planning.md)), todos, estimates, ECB exchange rates, gear, loadouts, reviews, a wishlist and a Gemini weather verdict. |

Auth is a JWT in `Authorization: Bearer`. Roles are `USER`, `ADMIN` and `SYSTEM`. `SYSTEM` is the role of the machine user the sync service signs in as. `scripts/generate-service-token.js` mints its token.

`utils/cron.js` runs these jobs in-process:

| Job | When |
| --- | --- |
| Notification digest | 08:00 |
| Spotify artist matching and photo warming | 04:00 |
| Songkick/Bandsintown source URL backfill | 05:00 |
| Setlist backfill for attended shows | 06:00 |
| Expired email codes cleanup | hourly |

Each schedule except the hourly cleanup can be overridden with a `*_CRON` variable.

Video renditions are made by a separate container in `services/rendition/`, which has its own [README](services/rendition/README.md).

## Running it

Secrets live in Doppler. With the Doppler CLI logged in:

```bash
npm install          # also runs prisma generate
npm run dev          # doppler run -c dev -- nodemon index.js, on port 4000
```

`npm run dev` connects to the dev database in Doppler, which holds real data.

To run without Doppler, copy `.env_example` to `.env`, fill it in, and run `npm start`. The variables you need:

- **Always:** `DATABASE_URL` and `JWT_SECRET`.
- **For anything that builds a link back to the API**, such as media, calendar feeds or OAuth: `CALLBACK_URL`.
- **For the archive:** `MEDIA_ROOT` and `MEDIA_URL_SECRET`.

Every other variable switches on one integration. When one is missing, that integration fails and the rest keep working. Redis is optional too: without `REDIS_URL` (or the Upstash REST pair) caching is off, and the server says so at boot.

### Database

The schema is `prisma/schema.prisma`. Changes go in as migrations under `prisma/migrations/`:

```bash
npx prisma migrate deploy   # build an empty database, or apply what is new
```

`npm run db:migrate` and `npm run db:migrate:prd` run the same command through Doppler's dev and prd configs. The container runs `migrate deploy` on every boot before it starts the server. Never use `db push`; the Dockerfile explains why.

## Tests

```bash
npm test                    # every route and util test, with Prisma faked (test/routeApp.js)
npm run test:integration    # against a real Postgres at INTEGRATION_DATABASE_URL
```

Point the integration tests at a throwaway database, because they write to it.

## Deploying

A push to `main` triggers `.github/workflows/deploy.yml`. The workflow runs three jobs:

1. It runs the unit suite.
2. It builds a Postgres 16 database from the migrations and checks that it matches `schema.prisma` exactly. Then it runs the integration tests against that database.
3. It builds `ghcr.io/esemdis/thorcode:latest`. This job runs only if both earlier jobs passed.

The container gets one secret, `DOPPLER_TOKEN`, and fetches the rest from Doppler at boot. The [media runbook](docs/concert-media-runbook.md) covers the Unraid template, the reverse proxy and the offsite backup.
