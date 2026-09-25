/**
 * What the rendition service should encode next, and with what.
 *
 * Kept out of the service's loop so it can be tested without ffmpeg, a share or
 * a container. The loop's own job is small on purpose: ask this what to do, run
 * ffprobe, ask this again, run ffmpeg, rename the result into place.
 *
 * The plan is built from the sidecar rather than from Postgres, and that is the
 * design rather than a convenience. `concert-media.json` is the record of truth
 * and the index is disposable, so a service that reads the sidecar needs no
 * DATABASE_URL, no migrations and no secret of any kind — it reads files and
 * writes files beside them. Nothing it does can corrupt the index, because it
 * never touches it, and nothing it writes has to be kept in step with a column,
 * because a rendition's existence is the whole record of it.
 *
 * What each clip actually IS comes from ffprobe rather than from the sidecar.
 * The sidecar's width and height are nullable and the colour fields are not in
 * it at all, and colour is what decides the whole filter chain — see
 * filterChain.
 */

const path = require('node:path');

// A marker rather than a retry. A clip ffmpeg cannot read will not become
// readable on the next pass, and a service that retried it every interval would
// spend every interval failing on the same file and never reach the rest.
const FAILED_SUFFIX = '.failed';

// Written under a temp name and renamed, for the same reason the sidecar and
// the posters are: the serving route decides on existence alone, so a
// half-written file at the final path would be streamed to a browser as though
// it were finished, forever.
const PART_SUFFIX = '.part';

// The two transfer functions that mean HDR. A phone records HLG (arib-std-b67);
// smpte2084 is PQ, which is what an HDR10 camera writes.
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

/** The ffprobe argv for one file. JSON because the field list keeps growing. */
function probeArgs(input) {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt,color_transfer,color_primaries',
    '-of', 'json',
    input,
  ];
}

/**
 * What ffprobe said, or null if it said nothing usable.
 *
 * Tolerant on purpose: a missing colour field is the ordinary case for an older
 * clip and means SDR, while a missing width is a file this cannot plan for at
 * all and has to be refused rather than guessed at.
 */
function parseProbe(stdout) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const stream = json?.streams?.[0];
  if (!stream) return null;
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  return {
    width,
    height,
    pixFmt: stream.pix_fmt ?? null,
    transfer: stream.color_transfer ?? null,
    primaries: stream.color_primaries ?? null,
    hdr: HDR_TRANSFERS.has(stream.color_transfer),
    // H.264 has no 10-bit profile that browsers decode, and h264_nvenc refuses
    // 10-bit input outright, so the depth decides part of the chain.
    tenBit: /10|12/.test(stream.pix_fmt ?? ''),
  };
}

/**
 * The rendition's dimensions: the long edge capped, the other kept in ratio and
 * even.
 *
 * Literal numbers rather than an ffmpeg expression, because scale_cuda's
 * expression support is not the same as scale's and a filter that silently
 * resolves differently on the GPU path would be a bug nobody sees until they
 * look at a portrait clip. The size is known — ffprobe just said so.
 *
 * Even because H.264 requires it for 4:2:0 chroma, and never smaller than 2.
 */
function targetSize({ width, height }, shortEdge = 1080) {
  const cap = Math.round(Number(shortEdge) * (16 / 9));
  const longest = Math.max(width, height);
  // Never upscale. A 720p clip stays 720p: the point is bitrate and codec, and
  // enlarging only spends bits inventing detail.
  const factor = longest > cap ? cap / longest : 1;
  const even = (n) => Math.max(2, 2 * Math.round((n * factor) / 2));
  return { width: even(width), height: even(height) };
}

/**
 * The tone-mapping chain, for HLG or PQ down to ordinary BT.709.
 *
 * Not optional and not cosmetic. A phone records HLG in BT.2020 — the clips
 * measured here report primaries 9, transfer 18 — and handing those bytes
 * straight to an SDR H.264 encoder produces washed-out, grey, desaturated
 * video: a rendition that looks worse than the original in a way that has
 * nothing to do with resolution.
 *
 * It is also what makes the GPU path possible at all. h264_nvenc refuses 10-bit
 * input with "Provided device doesn't support required NVENC features", and this
 * is the chain that ends in 8-bit yuv420p.
 *
 * gbrpf32le in the middle is the part that is easy to get wrong: tonemap works
 * in linear light and floating point, and without that conversion the result
 * bands badly in the shadows.
 */
const toneMapChain = () => [
  'zscale=t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=hable:desat=0',
  'zscale=t=bt709:m=bt709:r=tv',
  'format=yuv420p',
].join(',');

const isNvenc = (vcodec) => /_nvenc$/.test(vcodec);

/**
 * The -vf chain for one clip.
 *
 * Scaling comes first in both paths, and on the GPU it happens before the frames
 * are ever copied to system memory. Tone mapping is the expensive filter here
 * and it costs by the pixel, so doing it at 1080p instead of 4K is most of the
 * difference between minutes and an hour per clip.
 */
function filterChain(source, { height = 1080, vcodec = 'libx264' } = {}) {
  const size = targetSize(source, height);
  const parts = [];

  if (isNvenc(vcodec)) {
    parts.push(`scale_cuda=${size.width}:${size.height}`);
    // Back to system memory for the tone map, which has no CUDA implementation
    // in an ordinary ffmpeg build. The format has to be named: hwdownload cannot
    // pick one on its own, and naming the wrong one fails the whole encode.
    parts.push('hwdownload', `format=${source.tenBit ? 'p010le' : 'nv12'}`);
  } else {
    parts.push(`scale=${size.width}:${size.height}`);
  }

  if (source.hdr) parts.push(toneMapChain());
  // 10-bit SDR needs no tone mapping and still cannot be fed to an H.264
  // encoder, so it only needs the depth taken off.
  else if (source.tenBit || isNvenc(vcodec)) parts.push('format=yuv420p');

  return parts.join(',');
}

/** Input-side arguments. NVENC implies decoding on the same card. */
function hwaccelArgs(vcodec) {
  // NVDEC does the HEVC decode and the frames stay in VRAM for the scale, which
  // is the whole reason to ask for cuda output as well as cuda decoding.
  return isNvenc(vcodec) ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : [];
}

/**
 * Encoder and rate control.
 *
 * NVENC and x264 do not share their vocabulary, and the first version of this
 * pretended they did: it passed `-crf` and `-preset veryfast` to both, neither
 * of which h264_nvenc accepts — the preset is not one of its names and would
 * have failed every GPU encode outright.
 */
function encoderArgs({ vcodec, crf, maxrateMbps, preset }) {
  const ceiling = [
    '-maxrate', `${maxrateMbps}M`,
    // Two seconds of headroom, the conventional pairing with maxrate: smaller
    // makes the encoder fight the ceiling on every hard cut, larger lets a
    // burst through that the ceiling exists to stop.
    '-bufsize', `${maxrateMbps * 2}M`,
  ];

  if (isNvenc(vcodec)) {
    return [
      '-c:v', vcodec,
      // p1 fastest to p7 slowest; p5 is the usual "good enough and still fast".
      '-preset', preset ?? 'p5',
      '-tune', 'hq',
      // NVENC has no CRF. Constant quality is -cq, and it only takes effect in
      // vbr mode with the target bitrate left at zero.
      '-rc', 'vbr',
      '-cq', String(crf),
      '-b:v', '0',
      ...ceiling,
    ];
  }

  return [
    '-c:v', vcodec,
    '-preset', preset ?? 'veryfast',
    '-crf', String(crf),
    ...ceiling,
  ];
}

/**
 * The full ffmpeg argv for one clip.
 *
 * H.264 because it is the only codec every browser decodes, which is the entire
 * point — the originals are HEVC and Firefox plays none of them.
 *
 * +faststart moves the index to the front. A phone writes it at the end, so
 * without this a browser must range-request the tail of a gigabyte before it can
 * start, which is most of what made playback feel slow to begin with.
 */
function ffmpegArgs({
  input, output, source, height = 1080, crf = 21, maxrateMbps = 8,
  vcodec = 'libx264', preset = null,
}) {
  return [
    // Never read stdin: under a service manager there is none, and ffmpeg
    // treating a closed stdin as a keypress has ended runs early before.
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    ...hwaccelArgs(vcodec),
    '-i', input,
    '-vf', filterChain(source, { height, vcodec }),
    ...encoderArgs({ vcodec, crf, maxrateMbps, preset }),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    // Stated rather than inferred, because it cannot be inferred here: the
    // output is written to `<name>.mp4.part` so a half-finished file is never
    // served, and ffmpeg guesses the container from the extension it is given.
    // Without this every encode died at "Error initializing the muxer ...
    // Invalid argument" — a message about the output format that says nothing
    // about the filename that caused it.
    '-f', 'mp4',
    '-y', output,
  ];
}

/**
 * Every clip in one show that still needs a rendition.
 *
 * @param {object|null} sidecar - the show's parsed concert-media.json
 * @param {string[]} webDirEntries - what `.web` already holds
 */
function pendingInShow(sidecar, webDirEntries) {
  if (!sidecar?.files?.length) return [];
  const have = new Set(webDirEntries);
  return sidecar.files
    .filter((f) => f.kind === 'VIDEO' && typeof f.name === 'string' && f.name)
    .filter((f) => !have.has(`${f.name}.mp4`) && !have.has(`${f.name}.mp4${FAILED_SUFFIX}`))
    .map((f) => ({
      name: f.name,
      output: `${f.name}.mp4`,
      marker: `${f.name}.mp4${FAILED_SUFFIX}`,
      // Only ever used for logging, so a missing one costs nothing. It is the
      // difference between "encoding 1 of 28" and knowing it is the 20-minute
      // one.
      bytes: f.bytes ?? null,
      durationMs: f.duration_ms ?? null,
    }));
}

/**
 * A `.part` left behind by a killed run.
 *
 * Deleted rather than resumed: ffmpeg cannot continue into a truncated file, and
 * a half-written mp4 whose name lost its suffix would be served as finished.
 */
const isAbandonedPart = (name) => name.endsWith(PART_SUFFIX);

const partNameFor = (output) => `${output}${PART_SUFFIX}`;

const showDirOf = (relPath) => path.posix.dirname(relPath);

module.exports = {
  FAILED_SUFFIX,
  PART_SUFFIX,
  probeArgs,
  parseProbe,
  targetSize,
  filterChain,
  hwaccelArgs,
  encoderArgs,
  ffmpegArgs,
  pendingInShow,
  isAbandonedPart,
  partNameFor,
  showDirOf,
};
