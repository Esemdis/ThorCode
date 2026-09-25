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

Four problems in those numbers. **HEVC**, which Firefox cannot decode at all and
Chrome only with hardware support. **43 Mbit/s sustained**, which no home
connection streams. The phone writes the `moov` index at the *end* of the file,
so a player must range-request the tail of a gigabyte before it can begin —
which was most of what made playback feel slow to start. And the clips are
**HDR**: `colr` reports primaries 9, transfer 18, which is HLG in BT.2020.

That last one is why this does tone mapping rather than a plain re-encode.
Handing HLG BT.2020 to an SDR H.264 encoder produces washed-out, grey,
desaturated video — a rendition that looks worse than the original in a way that
has nothing to do with resolution. It is also what makes the GPU path possible
at all: `h264_nvenc` refuses 10-bit input outright with "Provided device doesn't
support required NVENC features", and the tone-map chain is what ends in 8-bit.

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

## Speed, and the GPU

Measured on an RTX 3080 against a 4K60 HLG source, as ffmpeg's own `speed=`:

| Pipeline | Speed |
|---|---|
| NVENC, scaling on the card then tone-mapping at 1080p | **0.872x** |
| libx264, everything on the CPU | 0.225x |
| NVENC, but tone-mapping at 4K before scaling | 0.201x |

Two things worth taking from that. The GPU is about **four times faster** — 30
minutes of footage in roughly 34 minutes instead of a little over two hours. And
the *order* matters as much as the encoder: tone mapping costs by the pixel, so
doing it after the scale rather than before is the difference between 0.872x and
0.201x. `filterChain` always scales first, and on NVENC it scales before the
frames are ever copied out of VRAM.

To use the card:

```bash
docker run -d --name Thorcode-Rendition --gpus all \
  -v /mnt/user/concert-media:/media \
  -e MEDIA_ROOT=/media \
  -e RENDITION_VCODEC=h264_nvenc \
  thorcode-rendition
```

Needs the Unraid Nvidia driver plugin, and `--gpus all` (Unraid's template calls
it `--runtime=nvidia` with `NVIDIA_VISIBLE_DEVICES=all`). Confirm the encoder is
really there before starting a batch — see the note at the top of the Dockerfile.

`-cq` is not `-crf`: NVENC is less efficient per bit than x264 at the same
number, so renditions come out somewhat larger for the same nominal quality.
Lower `RENDITION_CRF` if that matters more than size, or leave it — the `maxrate`
ceiling bounds the worst case either way.

The NVENC concurrent-session limit on GeForce cards does not apply here: this
encodes one clip at a time.

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
| `RENDITION_VCODEC` | `libx264` | `h264_nvenc` for an Nvidia card — about 4x faster, and the only hardware encoder wired up here. QSV and VAAPI would need their own hwaccel and filter flags, which this does not build. |
| `RENDITION_HEIGHT` | `1080` | The short edge. The long edge is capped at 16:9 of it, so portrait clips are not left full height. |
| `RENDITION_CRF` | `21` | Lower is better and bigger. |
| `RENDITION_MAXRATE_MBPS` | `8` | A ceiling as well as a target: CRF alone lets a grainy crowd shot pass the original's own bitrate. |
| `RENDITION_PRESET` | per encoder | `veryfast` for x264, `p5` for NVENC. Left unset by default because the two do not share preset names — `veryfast` would be rejected by NVENC outright. |
| `RENDITION_INTERVAL_SECONDS` | `300` | Sleep between passes. |
| `RENDITION_CLIP_POLL_SECONDS` | `5` | How often the shared-moment queue is checked between passes. Someone is usually waiting on a moment with the share panel open. |
| `FFMPEG_PATH` | `ffmpeg` | If it is somewhere unusual. |
| `FFPROBE_PATH` | `ffprobe` | Same. |

## How it behaves

- **Each clip is asked what it is first.** ffprobe reports size, bit depth and
  colour, and the filter chain is built from that: the sidecar's dimensions are
  nullable and it records no colour at all. A clip ffprobe cannot read is refused
  rather than encoded at a guessed size.
- **Never upscales.** A 720p clip stays 720p; the point is bitrate and codec.
- **Caps the long edge, not the width.** Half a phone's footage is portrait, and
  capping width would leave a portrait 4K clip at 2160 tall.
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

## Shared moments

A share link can point at part of a video instead of all of it. The API writes
`$MEDIA_ROOT/cache/clips/<link id>.json` (which file, which stretch, when the
link expires). This service cuts that stretch to `<link id>.mp4` beside it, with
the same encoder and settings as a rendition, from the `.web` rendition when
there is one, which makes a short moment a few seconds' work rather than a 4K
decode. See `utils/mediaClips.js`.

- **Checked often, and first.** The queue is read every
  `RENDITION_CLIP_POLL_SECONDS` between passes and again before each rendition,
  so a backlog after a big upload delays a share by one encode at most.
- **In `cache/`, not the archive.** A moment lives twelve hours and belongs to a
  link rather than a show. It is never copied offsite, and deleting `cache/`
  is still safe: the API writes the request again the next time the link is
  asked about.
- **Named by link id, never by token.** The token is the credential.
- **Cleaned up here.** Expired links, requests the API revoked, and cuts that
  finished after their link was revoked are all deleted on the next check.
- **Refusals are not retried**, since the queue is polled every few seconds.
  Stopping the share and sharing again gives the moment a new link and a new
  attempt.
