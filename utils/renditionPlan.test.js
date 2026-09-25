import { describe, it, expect } from 'vitest';
import {
  ffmpegArgs, probeArgs, parseProbe, targetSize, filterChain, hwaccelArgs, encoderArgs,
  pendingInShow, isAbandonedPart, partNameFor, FAILED_SUFFIX,
} from './renditionPlan.js';

const arg = (args, flag) => args[args.indexOf(flag) + 1];
const has = (args, flag) => args.includes(flag);

const probed = (over = {}) => parseProbe(JSON.stringify({
  streams: [{
    width: 3840, height: 2160, pix_fmt: 'yuv420p10le',
    color_transfer: 'arib-std-b67', color_primaries: 'bt2020', ...over,
  }],
}));

const sdr = () => probed({ pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709' });

describe('parseProbe', () => {
  it('recognises HLG as HDR', () => {
    // What a phone actually writes. The clips measured on the share report
    // primaries 9, transfer 18 — BT.2020 and ARIB STD-B67.
    expect(probed().hdr).toBe(true);
  });

  it('recognises PQ as HDR too', () => {
    expect(probed({ color_transfer: 'smpte2084' }).hdr).toBe(true);
  });

  it('treats an ordinary BT.709 clip as SDR', () => {
    expect(sdr().hdr).toBe(false);
  });

  it('treats a missing colour field as SDR, which is what an older clip is', () => {
    expect(probed({ color_transfer: undefined }).hdr).toBe(false);
  });

  it('notices the bit depth, which decides whether H.264 can take it at all', () => {
    expect(probed().tenBit).toBe(true);
    expect(sdr().tenBit).toBe(false);
  });

  it('refuses a stream with no usable dimensions rather than guessing one', () => {
    // Guessing means a rendition at the wrong size, or an encode that fails
    // several minutes in.
    expect(parseProbe(JSON.stringify({ streams: [{ pix_fmt: 'yuv420p' }] }))).toBeNull();
    expect(parseProbe(JSON.stringify({ streams: [] }))).toBeNull();
    expect(parseProbe('not json')).toBeNull();
  });

  it('asks ffprobe for exactly the fields it reads', () => {
    const spec = arg(probeArgs('/a/VID_1.mp4'), '-show_entries');
    for (const field of ['width', 'height', 'pix_fmt', 'color_transfer', 'color_primaries']) {
      expect(spec).toContain(field);
    }
  });
});

describe('targetSize', () => {
  it('brings a 4K landscape clip to 1080p', () => {
    expect(targetSize({ width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 });
  });

  it('caps the long edge of a portrait clip, not its width', () => {
    // Half a phone's footage is held portrait. Capping the width would leave a
    // portrait 4K clip at 2160 tall while bringing a landscape one to 1080.
    expect(targetSize({ width: 2160, height: 3840 })).toEqual({ width: 1080, height: 1920 });
  });

  it('never upscales', () => {
    // The point is bitrate and codec. Enlarging only spends bits inventing
    // detail that is not in the original.
    expect(targetSize({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it('keeps both dimensions even, as 4:2:0 chroma requires', () => {
    const size = targetSize({ width: 3843, height: 2163 });
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });

  it('follows the height asked for', () => {
    expect(targetSize({ width: 3840, height: 2160 }, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('holds the ratio of a clip that is neither 16:9 nor portrait', () => {
    expect(targetSize({ width: 2000, height: 2000 })).toEqual({ width: 1920, height: 1920 });
  });
});

describe('filterChain', () => {
  it('tone-maps an HDR clip down to BT.709', () => {
    // Not cosmetic. Handing HLG BT.2020 straight to an SDR H.264 encoder gives
    // washed-out, grey video — a rendition worse than the original in a way
    // that has nothing to do with resolution.
    const vf = filterChain(probed());
    expect(vf).toContain('tonemap=tonemap=hable');
    expect(vf).toContain('zscale=t=bt709:m=bt709:r=tv');
  });

  it('works in linear light and floating point, or the shadows band', () => {
    const vf = filterChain(probed());
    expect(vf).toContain('zscale=t=linear:npl=100');
    expect(vf).toContain('format=gbrpf32le');
  });

  it('leaves an SDR clip\u2019s colour alone', () => {
    // Tone-mapping SDR content would compress highlights that were never
    // compressed, which is a quality regression rather than a correction.
    expect(filterChain(sdr())).not.toContain('tonemap');
  });

  it('scales before tone-mapping, which is most of the speed', () => {
    // Measured: 0.872x scaling first against 0.201x tone-mapping at 4K. The
    // tone map costs by the pixel, so doing it at 1080p rather than 2160p is
    // over four times faster.
    const vf = filterChain(probed());
    expect(vf.indexOf('scale')).toBeLessThan(vf.indexOf('tonemap'));
  });

  it('scales on the card and only then copies to system memory, for NVENC', () => {
    const vf = filterChain(probed(), { vcodec: 'h264_nvenc' });
    expect(vf).toContain('scale_cuda=1920:1080');
    expect(vf.indexOf('scale_cuda')).toBeLessThan(vf.indexOf('hwdownload'));
  });

  it('names the format hwdownload should produce', () => {
    // hwdownload cannot choose one on its own, and naming the wrong one fails
    // the whole encode.
    expect(filterChain(probed(), { vcodec: 'h264_nvenc' })).toContain('hwdownload,format=p010le');
    expect(filterChain(sdr(), { vcodec: 'h264_nvenc' })).toContain('hwdownload,format=nv12');
  });

  // h264_nvenc refuses 10-bit input with "Provided device doesn't support
  // required NVENC features", and H.264 has no 10-bit profile a browser decodes
  // anyway. Both paths have to end in 8-bit.
  it('takes the depth off a 10-bit SDR clip, which needs no tone mapping', () => {
    const tenBitSdr = probed({ color_transfer: 'bt709', color_primaries: 'bt709' });
    const vf = filterChain(tenBitSdr);
    expect(vf).not.toContain('tonemap');
    expect(vf).toContain('format=yuv420p');
  });

  it('ends in 8-bit for every NVENC chain', () => {
    expect(filterChain(probed(), { vcodec: 'h264_nvenc' })).toContain('format=yuv420p');
    expect(filterChain(sdr(), { vcodec: 'h264_nvenc' })).toContain('format=yuv420p');
  });
});

describe('encoderArgs', () => {
  // The first version of this pretended the two encoders shared a vocabulary:
  // it passed -crf and -preset veryfast to both. NVENC accepts neither, and
  // would have failed every GPU encode outright on the preset alone.
  it('gives x264 a CRF', () => {
    const args = encoderArgs({ vcodec: 'libx264', crf: 21, maxrateMbps: 8, preset: null });
    expect(arg(args, '-crf')).toBe('21');
    expect(arg(args, '-preset')).toBe('veryfast');
  });

  it('gives NVENC constant quality in VBR, because it has no CRF', () => {
    const args = encoderArgs({ vcodec: 'h264_nvenc', crf: 21, maxrateMbps: 8, preset: null });
    expect(has(args, '-crf')).toBe(false);
    expect(arg(args, '-rc')).toBe('vbr');
    expect(arg(args, '-cq')).toBe('21');
    // -cq only takes effect with the target bitrate left at zero.
    expect(arg(args, '-b:v')).toBe('0');
  });

  it('gives NVENC one of its own preset names', () => {
    // p1..p7. "veryfast" is an x264 name and h264_nvenc rejects it.
    expect(arg(encoderArgs({ vcodec: 'h264_nvenc', crf: 21, maxrateMbps: 8, preset: null }), '-preset'))
      .toBe('p5');
  });

  it('honours an explicit preset for either encoder', () => {
    expect(arg(encoderArgs({ vcodec: 'h264_nvenc', crf: 21, maxrateMbps: 8, preset: 'p7' }), '-preset'))
      .toBe('p7');
    expect(arg(encoderArgs({ vcodec: 'libx264', crf: 21, maxrateMbps: 8, preset: 'slow' }), '-preset'))
      .toBe('slow');
  });

  it('holds a ceiling as well as a quality target, for both', () => {
    // CRF or CQ alone lets a dark, grainy crowd shot balloon past the
    // original's own bitrate, which would make the viewing copy the slow one.
    for (const vcodec of ['libx264', 'h264_nvenc']) {
      const args = encoderArgs({ vcodec, crf: 21, maxrateMbps: 6, preset: null });
      expect(arg(args, '-maxrate')).toBe('6M');
      expect(arg(args, '-bufsize')).toBe('12M');
    }
  });
});

describe('hwaccelArgs', () => {
  it('decodes on the card when it is going to encode there', () => {
    // NVDEC does the HEVC decode and the frames stay in VRAM for the scale,
    // which is the reason to ask for cuda output as well as cuda decoding.
    expect(hwaccelArgs('h264_nvenc')).toEqual(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
  });

  it('asks for no acceleration for a software encode', () => {
    expect(hwaccelArgs('libx264')).toEqual([]);
  });
});

describe('ffmpegArgs', () => {
  const cpu = () => ffmpegArgs({ input: 'i', output: 'o.mp4.part', source: probed() });
  const gpu = () => ffmpegArgs({
    input: 'i', output: 'o.mp4.part', source: probed(), vcodec: 'h264_nvenc',
  });

  it('encodes H.264, the one codec every browser decodes', () => {
    // The whole reason this service exists: the originals are HEVC, which
    // Firefox plays none of and Chrome only with hardware support.
    expect(arg(cpu(), '-c:v')).toBe('libx264');
    expect(arg(gpu(), '-c:v')).toBe('h264_nvenc');
  });

  it('puts the index at the front of the file', () => {
    // A phone writes moov at the end, so without this a player must fetch the
    // tail of a gigabyte before it can start. That was most of the slow start.
    expect(arg(cpu(), '-movflags')).toBe('+faststart');
  });

  it('states the container, which the .part extension hides', () => {
    // The output is written to <name>.mp4.part so a partial file is never
    // served, and ffmpeg infers the muxer from the extension. Without -f every
    // encode failed at "Error initializing the muxer: Invalid argument".
    expect(arg(cpu(), '-f')).toBe('mp4');
  });

  it('never reads stdin', () => {
    // There is none under a service manager, and ffmpeg treating a closed stdin
    // as a keypress has ended runs early.
    expect(cpu()).toContain('-nostdin');
  });

  it('keeps the audio as AAC', () => {
    expect(arg(cpu(), '-c:a')).toBe('aac');
  });

  it('puts the hwaccel before the input, where ffmpeg requires it', () => {
    const args = gpu();
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
  });

  it('names the input and output it was given', () => {
    const args = ffmpegArgs({
      input: '/a/VID_1.mp4', output: '/a/.web/VID_1.mp4.part', source: probed(),
    });
    expect(arg(args, '-i')).toBe('/a/VID_1.mp4');
    expect(args[args.length - 1]).toBe('/a/.web/VID_1.mp4.part');
  });
});

describe('pendingInShow', () => {
  const sidecar = (files) => ({ files });

  it('finds the clips with no rendition yet', () => {
    const jobs = pendingInShow(sidecar([{ kind: 'VIDEO', name: 'VID_1.mp4' }]), []);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].output).toBe('VID_1.mp4.mp4');
  });

  it('leaves a clip alone once its rendition is there', () => {
    expect(pendingInShow(sidecar([{ kind: 'VIDEO', name: 'VID_1.mp4' }]), ['VID_1.mp4.mp4'])).toEqual([]);
  });

  it('never looks at a photograph', () => {
    expect(pendingInShow(sidecar([{ kind: 'PHOTO', name: 'IMG_1.jpg' }]), [])).toEqual([]);
  });

  // A clip ffmpeg cannot read will not become readable next pass, and retrying
  // it every interval would spend every interval failing on the same file and
  // never reach the rest of the archive.
  it('skips a clip already marked as refused', () => {
    const jobs = pendingInShow(
      sidecar([{ kind: 'VIDEO', name: 'VID_1.mp4' }]),
      [`VID_1.mp4.mp4${FAILED_SUFFIX}`],
    );
    expect(jobs).toEqual([]);
  });

  it('keys the doubled extension off the whole filename', () => {
    // uniqueFilename only guarantees the FULL name is unique in a folder, so
    // clip.mov and clip.mp4 can both be there. Keying on the stem would have
    // one overwrite the other's rendition.
    const jobs = pendingInShow(
      sidecar([{ kind: 'VIDEO', name: 'clip.mov' }, { kind: 'VIDEO', name: 'clip.mp4' }]),
      ['clip.mov.mp4'],
    );
    expect(jobs.map((j) => j.output)).toEqual(['clip.mp4.mp4']);
  });

  it('carries the size along, for a log line that says which clip is the long one', () => {
    const jobs = pendingInShow(
      sidecar([{ kind: 'VIDEO', name: 'VID_1.mp4', bytes: 1_182_000_000, duration_ms: 222_900 }]),
      [],
    );
    expect(jobs[0]).toMatchObject({ bytes: 1_182_000_000, durationMs: 222_900 });
  });

  it('says nothing is pending for a show with no sidecar', () => {
    expect(pendingInShow(null, [])).toEqual([]);
    expect(pendingInShow({ files: [] }, [])).toEqual([]);
  });

  it('ignores an entry with no usable name', () => {
    // The sidecar is a file the design invites a human to edit, so its fields
    // are exactly as untrusted as request input.
    expect(pendingInShow(sidecar([{ kind: 'VIDEO' }, { kind: 'VIDEO', name: '' }]), [])).toEqual([]);
  });
});

describe('part files', () => {
  it('recognises a killed run’s leftover', () => {
    expect(isAbandonedPart('VID_1.mp4.mp4.part')).toBe(true);
    expect(isAbandonedPart('VID_1.mp4.mp4')).toBe(false);
  });

  it('names the temp file after the output it becomes', () => {
    // Renamed into place on success, so the serving route — which decides on
    // existence alone — can never be handed a half-written file.
    expect(partNameFor('VID_1.mp4.mp4')).toBe('VID_1.mp4.mp4.part');
  });
});
