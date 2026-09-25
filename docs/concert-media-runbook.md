# Concert media: the share, the proxy, and the offsite copy

The point of this feature is the backup. The gallery is what makes the backup
pleasant to keep feeding. If you ever have to choose, the archive wins.

This document is the operational half: where the files live, what has to be
configured outside the repo for them to get there, and how the second copy
reaches Google Drive. Everything here is done by hand once and then left alone,
which is exactly why it is written down.

## What lives where

`MEDIA_ROOT` is one directory with three children, and only one of them matters:

```
$MEDIA_ROOT/
    archive/          the record of truth. Back this up.
        <user_id>/<date city - headliner>/
            IMG_4821.jpg
            VID_0031.mp4
            concert-media.json      what the database is a copy of
            .posters/VID_0031.mp4.webp
            .web/VID_0031.mp4.mp4   1080p H.264 viewing copy. Delete at any time.
    cache/            derived photo thumbnails. Delete at any time.
    incoming/         multer's scratch space during an upload.
```

`archive/` is the only one that gets copied offsite. `cache/` is regenerated on
demand from the originals, and `incoming/` holds bytes that are mid-flight.

The thing to understand before touching any of this: **`concert-media.json` is
the record of truth and Postgres is a disposable index of it.** Every sidecar
names its concert, its owner, and for each file the band, the caption, the
checksum and the dimensions. `scripts/rebuild-media-index.js` reconstructs the
database from those files alone. That is what lets you treat the share as the
thing being protected and the application as replaceable.

`.web/` holds viewing copies and is disposable, despite living inside
`archive/`. It is in there rather than in `cache/` because it is keyed by the
clip's filename and has to travel with the show folder — a show moved to
`_detached` and restored later keeps its renditions, and a rebuild does not have
to know they exist. Both dot-directories are invisible to the rebuild and to
drift detection, which ignore anything starting with a dot. Excluding `.web`
from the offsite copy is reasonable and saves the most space of anything here;
excluding `.posters` is not, for the reason below.

Video posters are the exception to "derived data is disposable". There is no
ffmpeg in this image — deliberately, it would add roughly 250 MB to an image
that also serves the travel app, paid on every Watchtower pull — so a poster
frame is extracted by the browser at upload time and can never be regenerated
here. That is why posters sit in `.posters/` inside the archive and get backed
up, while photo thumbnails sit in `cache/` and do not.

## Environment

Two new variables, both required:

| Variable | Value | Notes |
|---|---|---|
| `MEDIA_ROOT` | `/media` in `prd`, a local writable path in `dev` | The container path maps to the share; `dev` runs nodemon on a workstation where `/media` does not exist. Nothing works without it — `mediaRoot()` throws rather than guessing. |
| `MEDIA_URL_SECRET` | 32 random bytes | Signs the URLs that serve bytes. |

Set them in both Doppler configs, with **different** secrets:

```bash
doppler secrets set MEDIA_ROOT=/path/to/a/local/dir --config dev
doppler secrets set MEDIA_URL_SECRET="$(openssl rand -base64 32)" --config dev
doppler secrets set MEDIA_ROOT=/media --config prd
doppler secrets set MEDIA_URL_SECRET="$(openssl rand -base64 32)" --config prd
```

Two separate `openssl` calls, not one value used twice: a shared secret would
mean a token minted in development opens production files.

`MEDIA_ROOT` differs because `prd` runs in the container, where `/media` is the
share, while `dev` is `npm run dev` — nodemon on a workstation, where `/media`
does not exist.

**The two configs share one database.** `DATABASE_URL` is byte-identical in
`dev` and `prd`: there is one Postgres, not two. That has a consequence specific
to this feature. A photo uploaded while running locally writes a `ConcertMedia`
row that production reads too, pointing at a `rel_path` that exists only under
the development `MEDIA_ROOT` — so it renders in the deployed gallery as a
permanently broken tile, and the rebuild cannot repair it because the file
genuinely is not in the archive. Separate `MEDIA_ROOT` values do not buy
isolation while the index is shared. Either avoid uploading locally, or point
`dev` at the real share, or delete those rows afterwards.

`MEDIA_URL_SECRET` exists because `<img src>` and `<video src>` issue their own
requests and cannot carry an `Authorization` header. The byte routes therefore
authenticate on a signed token in the query string instead. A token is bound to
one media id and expires after **six hours**
(`MEDIA_TOKEN_TTL_SECONDS` in `utils/mediaTokens.js`), so one leaked URL opens
one file for one afternoon, not the archive.

Rotating the secret invalidates every outstanding URL at once. The only visible
effect is that images already on someone's screen stop loading until they
reload, so rotate freely if you ever need to.

## The Unraid container template

Add one volume to the ThorCode container:

- **Host path:** `/mnt/user/concert-media`
- **Container path:** `/media`
- **Access mode:** Read/Write

Leave the existing `/doppler` mapping alone — it is how the container gets its
secrets, and removing it stops the app rather than this feature.

Make the share itself visible over SMB. Being able to open the folder from a
desktop and see readable names is half the value of the on-disk layout, and it
is how you will check the first upload actually landed.

## The reverse proxy body limit

**This is the step that gets missed, and it presents as a broken feature rather
than as a proxy error.** nginx defaults `client_max_body_size` to 1 MB, which
rejects essentially every upload with a 413 the UI can only report as a failure.

```nginx
location / {
    client_max_body_size 2g;
    proxy_request_buffering off;
    ...
}
```

Two things worth knowing about that number:

- `client_max_body_size` applies to the **whole request**, not to each file.
  The application caps a single file at 500 MB (`MAX_FILE_BYTES`) but puts no
  cap on how many files one request may carry, and the whole design of the
  tagging flow is "drop all thirty files from the gig at once". Thirty phone
  photos is a couple of hundred megabytes; thirty clips is not. 2 GB leaves room
  for a realistic batch without inviting an unbounded one.
- `proxy_request_buffering off` keeps nginx from spooling the entire batch to
  its own disk before ThorCode sees any of it. Without it a large upload is
  written twice and the client waits through both.

If uploads fail only for videos, or only for large batches, check this before
anything else.

## rclone to Google Drive

Drive was chosen because the 15 GB free tier is attached to an account that
already exists, with no payment method anywhere in the setup. rclone abstracts
the target, so if it ever stops being the right answer, only this section
changes.

### Setting up the remote

```bash
rclone config          # new remote, name: gdrive, type: drive
```

When it offers to use rclone's built-in OAuth client, **decline and register
your own** in the Google Cloud console. The shared client is rate-limited hard
enough to matter on the first upload of an archive this size — it turns an
overnight job into a multi-day one.

### Nightly — copy, which only ever adds

```bash
rclone copy /mnt/user/concert-media/archive gdrive:concert-media \
  --fast-list --transfers 4 \
  --log-file /var/log/rclone-concert-media.log
```

`copy` never deletes at the destination. A file removed on the server stays in
Drive, which is the behaviour you want from the job that runs unattended every
night.

### Weekly — sync, which can remove, so it keeps a net

```bash
rclone sync /mnt/user/concert-media/archive gdrive:concert-media \
  --fast-list --checksum \
  --backup-dir "gdrive:concert-media-trash/$(date +%F)"
```

This is the job that makes Drive match the server, including deletions. Anything
it would remove goes to a dated folder under `concert-media-trash` instead of
disappearing, so a bad week is recoverable for as long as you leave those
folders alone. Empty them deliberately, not on a schedule.

`--checksum` rather than the default size-and-modtime comparison: the sidecar
records a sha256 for every file, so the archive is checksum-addressed anyway,
and an SMB round trip is exactly the kind of thing that perturbs a mtime without
changing a byte.

### Monthly — verify

```bash
rclone check /mnt/user/concert-media/archive gdrive:concert-media --checksum
```

A backup nobody has ever read is a hypothesis. This is the line that turns it
into a fact.

### A file in two show folders in Drive

Tagging a photograph with an act from another stage of the same festival day
moves it into that act's show folder, with its poster and web rendition (see
`utils/mediaRehome.js`). The nightly `copy` adds it at the new path and never
removes the old one, so between that night and the next weekly `sync` Drive
holds it in both folders. That is expected, not drift: the weekly `sync` moves
the stale copy to `concert-media-trash`.

### Confirm the posters actually go

`.posters/` is a dotted directory, and the poster frames inside it are the one
piece of derived data that cannot be regenerated. rclone does not skip dotted
names by default, so they should be copied — **confirm it rather than assume
it**, once, on the first real run:

```bash
rclone lsf --dirs-only -R gdrive:concert-media | grep '\.posters'
```

If that comes back empty while `.posters/` exists on the server, every video in
the archive has lost its only thumbnail and nothing in the application will say
so.

## Quota

Drive's 15 GB free tier is shared with Gmail and Google Photos, so the archive
does not get all of it. Check what is actually free before assuming headroom:

```bash
rclone about gdrive:
du -sh /mnt/user/concert-media/archive
```

Record today's archive size when you first set this up, and when the job starts
failing on quota, let it fail loudly. A backup that silently copies most of the
archive is worse than one that stops, because it reports success.

## When a show disappears from the app but not from the share

`detachAttendances` moves a show folder to `_detached` and drops its index rows.
That is how the bytes survive a concert going away, and it is deliberate — but
it leaves the gallery empty with nothing on screen to say why, and the rebuild
cannot help: it skips `_detached` by design, because the sidecar in there names a
`concert_id` that no longer exists.

Three routes can trigger it. An admin deleting a concert is an instruction and
detaching is the answer to it. The other two are **orphan sweeps** after a band
is deleted or reconciled, and those now refuse to touch a concert anybody
attended — `sweepableConcertIds` in `utils/mediaDetach.js` requires
`attendances: { none: {} }` as well as `bands: { none: {} }`.

That rule was missing, and its absence cost a gig: deleting a band unlinked it
from every concert and swept whatever was left band-less, with no date filter and
no thought for attendance, so a night someone had been to and uploaded
photographs to was swept as debris. A band-less attended concert is a slightly
poorer record — its lineup falls back to the scraped metadata — and that is a far
smaller loss than the night itself.

To put back anything already in `_detached`:

```bash
doppler run -- node scripts/restore-detached-media.js --dry-run
doppler run -- node scripts/restore-detached-media.js
doppler run -- node scripts/restore-detached-media.js --only "2026-06-12 Oslo - Gojira"
```

It reads each detached sidecar, recreates the concert and attendance it names,
moves the folder back, and rewrites the sidecar to point at the new concert id —
the old id is gone and ids are not reusable. It does not write `ConcertMedia`
rows: that is `rebuild-media-index.js`'s job and the tested path for it, so
finish with a `--dry-run` of the rebuild, check it reports the files, then run it
for real.

A restored concert keeps only what the sidecar knew: date, venue, city, country.
`event_id`, the source urls and the coordinates went with the old row and are not
inventable — the enrich passes fill those in again.

## Video renditions, and why playback was slow

The archive holds phone originals and they are not viewing copies. Measured on
the share, one night:

```
PXL_20260624_204209998.mp4   1182 MB   222.9s   42.4 Mbit/s   hvc1
PXL_20260624_200428424.mp4   1048 MB   193.2s   43.4 Mbit/s   hvc1
28 videos  ·  9.26 GB for the gig
```

Four separate problems in those numbers:

- **HEVC** (`hvc1`). Firefox decodes none of it; Chrome only with hardware
  support. This is what the lightbox's "most likely HEVC" message is about.
- **43 Mbit/s sustained**, which no home connection streams.
- The phone writes the `moov` index at the **end** of the file, so a player has
  to range-request the tail of a gigabyte before it can start. That was most of
  what made playback feel slow to *begin*.
- **HDR.** The `colr` box reports primaries 9, transfer 18 — HLG in BT.2020. A
  plain re-encode to SDR H.264 without tone mapping comes out washed-out and
  grey, which would look like a worse rendition for reasons nothing to do with
  resolution. It is also what makes the GPU path work at all: `h264_nvenc`
  refuses 10-bit input, and the tone-map chain is what ends in 8-bit.

None of that is fixable in the API. `services/rendition/` is a separate
container — ffmpeg plus a walker over the share — that writes
`.web/<name>.mp4` beside each clip: 1080p H.264, AAC, index at the front, about
6 Mbit/s. That 1182 MB clip becomes roughly 170 MB.

It needs `MEDIA_ROOT` and ffmpeg and nothing else: no `DATABASE_URL`, no
Doppler token, no network. It finds its work by reading the sidecars and records
a finished rendition by the file existing, so it cannot corrupt the index and
holds no secret to leak. Kill it mid-encode and the `.part` file goes with it.

`services/rendition/README.md` has the settings and the `docker run`. Measured
on an RTX 3080 against a 4K60 HLG source:

| Pipeline | Speed |
|---|---|
| `h264_nvenc`, scaling on the card then tone-mapping at 1080p | **0.872x** |
| `libx264`, everything on the CPU | 0.225x |
| `h264_nvenc`, but tone-mapping at 4K before scaling | 0.201x |

So `RENDITION_VCODEC=h264_nvenc` plus `--gpus all` is worth about four times the
throughput — that 30-minute night in roughly 34 minutes rather than a little over
two hours. The third row is the warning: the tone map costs by the pixel, and
doing it before the scale throws the GPU's advantage away entirely.

Two routes serve a video, and the difference matters:

| Route | Serves | Cache-Control |
|---|---|---|
| `/media/:id/play` | the rendition if there is one, else the original | 5 minutes while it is still the original, `immutable` once it is the rendition |
| `/media/:id/file` | always the archive master | `immutable` |

The five minutes is not an oversight. `/play` answers from the same URL before
and after the service reaches a clip, so telling the browser to keep the
original for a year would hide the rendition behind a cache entry nothing can
invalidate.

To find out whether a clip has one: look for `.web/<name>.mp4` in its show
folder. To force a re-encode: delete it. To see what is pending without writing
anything, `--dry-run`. A clip ffmpeg refuses gets a `.failed` file holding the
error and is not retried until `--retry`, because otherwise every pass would
spend itself on the same broken file and never reach the rest.

## Capture times, and the order a night is shown in

The gallery shows a night in the order it happened, not the order it was
uploaded: `GET /attendances/:id/media` sorts on `taken_at`, nulls last, with the
row id as the tiebreak. An unknown time is not the same as a late one, so files
without one keep upload order among themselves and sit after everything that can
be placed.

The two kinds get their time by different roads, and neither is
`File.lastModified` — that was measured on a gig pulled out of Google Photos and
turned out to be the download time, reordered by the parallel download, so it
fails as an absolute time and as a relative one.

| Kind | Read by | From |
|---|---|---|
| Video | the uploading browser | the MP4 `mvhd` box (`concert-map/src/utils/videoCapturedAt.js`) |
| Photo | this server, at upload | EXIF `DateTimeOriginal` + `OffsetTimeOriginal` (`utils/exifCapturedAt.js`) |

Both pass `capturedAtFor`, which refuses anything more than 48 hours from the
show — a camera whose clock was never set writes a plausible-looking date years
away, and believed it would drag that file to one end of every gallery.

`DateTimeOriginal` is local wall-clock with no zone in it, so
`OffsetTimeOriginal` is applied when the camera wrote one. When it did not, the
stamp is read as UTC and may be out by the venue's offset. That is a constant
shift per device per night, so it never reorders that camera's own photographs —
it can only misplace them against another device's.

Photographs stored before any of this have no time and sort last. Their EXIF is
still inside the files, so it can be read back:

```bash
doppler run -- node scripts/backfill-media-taken-at.js --dry-run   # reports, writes nothing
doppler run -- node scripts/backfill-media-taken-at.js             # writes
```

It writes the sidecar as well as the row, and that is the point rather than a
courtesy: a time written only to Postgres is one the next rebuild discards.
Videos are not covered — there is no decoder in this image, the same reason
posters cannot be regenerated here.

## Finding rows whose file is gone

The rebuild above walks the archive and asks what the index is missing. This asks
the opposite question — which indexed rows have no file behind them — which is
the one to ask when tiles are blank:

```bash
doppler run -- node scripts/find-missing-media.js          # grouped by show
doppler run -- node scripts/find-missing-media.js --json    # same, machine-readable
```

It reports only, and it exits non-zero when it finds any. It refuses to run at
all when the archive is unreadable or empty, because with the share unmounted
every row in the index is "missing" and a report of four thousand orphans is the
wrong answer to the question you actually have.

Each show is labelled with the one thing that decides what to do about it:

- **show folder is not in this archive** — those files were never here. This is
  the shared-database case below: uploaded under the other `MEDIA_ROOT`, so the
  bytes have to be copied across, sidecar and `.posters/` included. A rebuild
  cannot invent them.
- **folder is here, these files are not** — drift inside an archive this
  deployment owns. That is what the rebuild reconciles, because the sidecar
  beside them still says what should be there.

## Rebuilding the index

```bash
doppler run -- node scripts/rebuild-media-index.js --dry-run   # reports, writes nothing
doppler run -- node scripts/rebuild-media-index.js             # writes
```

It walks `archive/`, reads every sidecar, and upserts a `ConcertMedia` row per
listed file. It exits non-zero when it finds drift, so it is safe to put on a
cron that is meant to complain. The drift it reports:

- **sidecar entry with no file** — the index would point at a broken tile.
- **file no sidecar mentions** — the case that matters most: a photo that is
  safely backed up and completely invisible in the app.
- **show with files but no sidecar** — the same, for a whole gig.
- **sidecar whose concert has no attendance** — a restore onto a database that
  predates the show, or a deleted concert. It will not invent an attendance,
  because that would assert you went somewhere.
- **folder owner disagrees with its own sidecar** — the archive contradicts
  itself and neither value is safe to act on.

It only ever adds and updates. It will not delete a row whose file is gone from
both disk and sidecar, so on a drift-repair run against a populated database
those rows survive unreported. Restoring onto an empty database — the case this
exists for — is unaffected.

`_detached/` folders are skipped entirely. They hold media whose concert was
deleted out from under them; there is nothing left to re-anchor them to, and
they stay on disk and in the backup rather than being thrown away.

## Smoke test, once, on the real deployment

The suite cannot reach any of this. It has no SMB mount, no proxy, no Drive, and
no video decoder — jsdom does not decode video, so the poster path in particular
has never been exercised anywhere but a real browser. Do these in order the
first time, and after any change to the share or the proxy.

- [ ] Upload one JPEG through concert-map. Open the share over SMB and confirm
      the show folder has a readable name and the file is in it.
- [ ] Open `concert-media.json` in a text editor. Confirm it names the concert,
      the venue, the band and a sha256.
- [ ] Upload one MP4 from a real browser. Confirm a poster frame renders on the
      tile, and that `.posters/` has appeared inside the show folder.
- [ ] Delete the whole `cache/` directory. Confirm photo thumbnails come back on
      the next request and that the video poster was never affected — that
      asymmetry is the entire reason posters live in the archive.
- [ ] Request a file URL with a `Range` header and confirm a 206. This is what
      seeking in a video depends on.
- [ ] Scrub a video, or close the tab mid-download, and confirm the API is still
      up. An abort mid-body used to take the process down with it.
- [ ] Take a media URL from one account and request it while signed in as
      another. Expect 403. Wait out the six hours, or hand-edit the expiry, and
      expect 401.
- [ ] Run `rebuild-media-index.js --dry-run` and confirm it reports no drift.
- [ ] Run the rclone copy. Confirm the files, `concert-media.json` and
      `.posters/` all arrive.
- [ ] Delete one `ConcertMedia` row by hand, run the rebuild for real, and
      confirm the row comes back pointing at the same file.
- [ ] Try to remove an attended show that has photos. Expect a refusal naming
      the count, not a cascade.
- [ ] As an admin, delete a concert that has media. Confirm the files moved to
      `_detached/` rather than being destroyed.

## When something is wrong

| Symptom | Look here first |
|---|---|
| Every upload fails, videos especially | `client_max_body_size` on the proxy |
| App will not start | `MEDIA_ROOT` unset at boot — `mediaRoot()` throws rather than guessing |
| App starts, lists load, but **every** photo and video is blank | Check `archive` in `GET /data/concerts/health` first — it says whether the share is readable and how many owner folders are in it. `MEDIA_ROOT` unset or wrong gives 500s (`mediaRoot()` throws on *use*, not at boot, so listings keep working); a share that **dropped** leaves an empty directory and gives 404s instead. The startup log warns about both. |
| Tiles 404 while the share is mounted and populated | The row and the file disagree. Both configs share one Postgres with different `MEDIA_ROOT`s, so a file uploaded under one is a permanently broken tile under the other — check the row's `rel_path` against each archive before reaching for the rebuild |
| Every image 404s or 401s | `MEDIA_URL_SECRET` differs from the one that signed the URLs. The route logs `[media] refused <id>: <reason>`, and the reason names it: `unconfigured`, `signature`, `expired` |
| Images blank with nothing in the API log at all | The browser never sent the request. `CALLBACK_URL` points somewhere unreachable, or it is `http://` on an `https://` page and is dropped as mixed content |
| Video tiles are permanent placeholders | `.posters/` missing — check it reached Drive, and that the browser extracted a frame at upload |
| Photos visible on the share, absent in the app | Run the rebuild with `--dry-run`; expect them under "file no sidecar mentions" |
| `incoming/` is growing | Temp files from aborted uploads. Safe to delete anything in there older than a day. |
