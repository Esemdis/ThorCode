# Deploys: when a migration fails at boot

The container runs `npx prisma migrate deploy && exec node index.js` on every
start (the `Dockerfile` says why the `&&` is there). When a migration fails on
production rows, node never starts, the container restarts in a loop, and
concert-map and travel-bag are both down. Nothing fixes itself: Prisma records
the migration as failed and refuses every later `migrate deploy`, from any
image, until someone resolves it by hand. This is that by hand.

The names in angle brackets are yours to fill in: `<thorcode-container>` and
`<watchtower-container>` are the container names on Unraid, and
`<doppler-host-dir>` is the host path mapped to `/doppler` in the template.

## How images are tagged

Every push to `main` whose tests pass builds one image and pushes it under two
tags (`.github/workflows/deploy.yml`):

- `ghcr.io/esemdis/thorcode:latest`, which Watchtower follows and deploys.
- `ghcr.io/esemdis/thorcode:<sha>`, the full 40-character commit sha. It never
  moves, so it is the image to go back to.

To find a commit's sha, `git log --oneline main` in a checkout (then
`git rev-parse <short sha>` for the full one), or the commit list on GitHub.
The package page on GitHub lists the tags that exist.

Not every commit has a tag. Runs on `main` queue one at a time, and GitHub
keeps only one waiting: when three pushes land fast, the newest replaces the
waiting middle one, so that middle commit gets no `:<sha>` tag. The newest
commit always wins. A run whose tests fail publishes nothing and gets no tag.
Go back to the newest tagged commit before the bad one.

## 1. Spot it

The API stops answering at all (concert-map and travel-bag show network
errors, not error messages), and the container's uptime keeps resetting.
Check the log:

```sh
docker logs --tail 50 <thorcode-container>
```

What you are looking for:

- `P3018`: a migration failed to apply. The message names the migration and
  the database error (often a constraint that existing rows break).
- `P3009`: an earlier migration is recorded as failed, so Prisma refuses to
  run any. You see this on every restart after the first.

## 2. Stop Watchtower

Otherwise it may replace the container under you, or put `:latest` back after
you pin a tag.

```sh
docker stop <watchtower-container>
```

Stopping the ThorCode container too ends the restart loop while you work:
`docker stop <thorcode-container>`.

## 3. See what the database thinks

From a checkout, with the Doppler CLI logged in:

```sh
doppler run -c prd -- npx prisma migrate status
```

Or without a checkout, with a one-off container from the image (any tag) and
the same token the template uses:

```sh
docker run --rm -e DOPPLER_TOKEN=<token> -v <doppler-host-dir>:/doppler \
  ghcr.io/esemdis/thorcode:<tag> \
  doppler run --fallback /doppler/fallback.json -- npx prisma migrate status
```

It names the failed migration, a folder name under `prisma/migrations/` such
as `20261114120000_add_ticket_index`. That is the `<name>` below.

## 4. Resolve it

A migration is not one transaction you can count on: the statements before the
one that failed may already have been applied. Look at the migration's
`migration.sql` and at the database, then take one of two ways. Run the same
`resolve` either from a checkout through `doppler run -c prd --` or in the
one-off container above.

**Undo it**, when the migration has to change (it breaks on real rows). Revert
by hand whatever part of it did apply, then:

```sh
doppler run -c prd -- npx prisma migrate resolve --rolled-back <name>
```

The next `migrate deploy` runs that migration again from the start. So an
image that still contains it fails again in the same place: either fix the
data it tripped on first, or go back to an image without it (step 5) until a
fixed migration is merged.

**Finish it**, when the migration is right and only needed help (a row to fix
first, a statement to run by hand). Apply the rest of its `migration.sql` by
hand, then:

```sh
doppler run -c prd -- npx prisma migrate resolve --applied <name>
```

Prisma then treats it as done and never runs it again, so the database must
really match what the file would have made.

Until one of these is done, P3009 stops every image, the old ones included, so
going back alone does not help.

## 5. Go back to an earlier image

In the Unraid template for ThorCode, change **Repository** from
`ghcr.io/esemdis/thorcode:latest` to `ghcr.io/esemdis/thorcode:<previous sha>`
and apply. The container starts on that image.

This is safe only when the older image's migrations are all already in the
database, which is the case after an undo (step 4), since the failed one is not
in the older image at all. An image that predates a migration the database has
finished is running against a schema newer than its own: check that the
migrations in between only added things.

Watchtower leaves a pinned sha alone, since the tag never changes.

## 6. Return to normal

1. Merge the fix (a corrected migration, or the code that goes with the data
   fix) and wait for the `main` run to push the new `:latest`.
2. Set the template's **Repository** back to `ghcr.io/esemdis/thorcode:latest`
   and apply.
3. Check the log shows the migrations applied and the server listening.
4. `docker start <watchtower-container>`.

## Don't

- `prisma db push`: it forces the database to match the schema with no record
  of migrations, and has already tried to drop a table here (see the
  `Dockerfile`).
- `prisma migrate reset`: it drops the production database.
- Edit `_prisma_migrations` by hand. `migrate resolve` is the supported way to
  change what it records.
