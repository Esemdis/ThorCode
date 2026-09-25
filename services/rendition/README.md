# Video rendition service

Turns the archive's phone originals into something a browser can actually play,
without touching the originals.

## Why

One night's clips, measured on the share:

```
PXL_20260624_204209998.mp4   1182 MB   222.9s   42.4 Mbit/s   hvc1
PXL_20260624_200428424.mp4   1048 MB   193.2s   43.4 Mbit/s   hvc1
28 videos · 9.26 GB for the gig
```

Three problems in those numbers. **HEVC**, which Firefox cannot decode at all and
Chrome only with hardware support. **43 Mbit/s sustained**, which no home
connection streams. And the phone writes the `moov` index at the *end* of the
file, so a player must range-request the tail of a gigabyte before it can begin —
which was most of what made playback feel slow to start.

This writes `.web/<name>.mp4` beside each clip: 1080p H.264, AAC, index at the
front. Roughly 6 Mbit/s, so that 1182 MB clip becomes about 170 MB and the 9.26 GB
night about 1.4 GB.

The API serves the rendition from `/media/:id/play` and the original from
`/media/:id/file`, so the archive copy remains the archive copy and a download
still gets the master.

## What it needs

`MEDIA_ROOT` and ffmpeg. That is all — deliberately.

No `DATABASE_URL`, no Doppler token, no API credentials, no network. It finds its
work by reading the sidecars, which are the record of truth, and a finished
rendition is recorded by the file existing. So it cannot corrupt the index
(it never opens it), it holds no secret to leak, and it can be killed mid-encode
at any moment: the `.part` file goes and the archive is as it was.

## Running it

```bash
# what is pending, writing nothing
MEDIA_ROOT=/media node services/rendition/index.js --dry-run

# one pass, then exit
MEDIA_ROOT=/media node services/rendition/index.js --once

# the service: pass, sleep, repeat
MEDIA_ROOT=/media node services/rendition/index.js

# clear the .failed markers and try those clips again
MEDIA_ROOT=/media node services/rendition/index.js --retry
```

As a container, from the repository root:

```bash
docker build -f services/rendition/Dockerfile -t thorcode-rendition .
docker run -d --name Thorcode-Rendition \
  -v /mnt/user/concert-media:/media \
  -e MEDIA_ROOT=/media \
  --cpus 4 \
  thorcode-rendition
```

`--cpus` is worth setting. It shares the box with the API and the array, and an
unbounded x264 run will take every core it can find.

## Settings

| Variable | Default | Notes |
|---|---|---|
| `MEDIA_ROOT` | — | Required. The share, same value the API uses. |
| `RENDITION_VCODEC` | `libx264` | `h264_nvenc`, `h264_qsv`, `h264_vaapi` if this box has a GPU. Turns hours into minutes; needs a base image with that encoder built in. |
| `RENDITION_HEIGHT` | `1080` | The short edge. The long edge is capped at 16:9 of it, so portrait clips are not left full height. |
| `RENDITION_CRF` | `21` | Lower is better and bigger. |
| `RENDITION_MAXRATE_MBPS` | `8` | A ceiling as well as a target: CRF alone lets a grainy crowd shot pass the original's own bitrate. |
| `RENDITION_PRESET` | `veryfast` | x264 only. `medium` is ~30% smaller and several times slower. |
| `RENDITION_INTERVAL_SECONDS` | `300` | Sleep between passes. |
| `FFMPEG_PATH` | `ffmpeg` | If it is somewhere unusual. |

## How it behaves

- **One clip at a time.** Two concurrent 4K transcodes would make the app this
  exists to speed up slower than it was.
- **Atomic.** Writes `<name>.mp4.part` and renames on success. The serving route
  decides on existence alone, so it must never see a partial file.
- **Refusals are marked, not retried.** A clip ffmpeg cannot read gets
  `<name>.mp4.failed` holding the error. Without that, every pass would spend
  itself failing on the same file and never reach the rest. `--retry` clears them.
- **Detached shows are skipped.** They are not served, so a rendition of one is
  CPU spent on something no request can reach.
- **`.web` is disposable.** Deleting it costs only the CPU to rebuild it. It is
  invisible to the rebuild script and to drift detection, which ignore
  dot-directories.
