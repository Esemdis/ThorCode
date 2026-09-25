import { describe, it, expect } from 'vitest';
import {
  ffmpegArgs, pendingInShow, isAbandonedPart, partNameFor, FAILED_SUFFIX,
} from './renditionPlan.js';

const arg = (args, flag) => args[args.indexOf(flag) + 1];

describe('ffmpegArgs', () => {
  it('encodes H.264, the one codec every browser decodes', () => {
    // The whole reason this service exists: the originals are HEVC, which
    // Firefox plays none of and Chrome only with hardware support.
    expect(arg(ffmpegArgs({ input: 'i', output: 'o' }), '-c:v')).toBe('libx264');
  });

  it('puts the index at the front of the file', () => {
    // A phone writes moov at the end, so without this a player must fetch the
    // tail of a gigabyte before it can start. That was most of the slow start.
    expect(arg(ffmpegArgs({ input: 'i', output: 'o' }), '-movflags')).toBe('+faststart');
  });

  it('caps the long edge, so a portrait clip is not left at full height', () => {
    // Capping the width would bring a landscape 4K clip down to 1920 and leave
    // a portrait one at 2160 tall, which is most of a phone's footage.
    const vf = arg(ffmpegArgs({ input: 'i', output: 'o' }), '-vf');
    expect(vf).toContain('gt(iw,ih)');
    expect(vf).toContain('min(1920,iw)');
    expect(vf).toContain('min(1920,ih)');
  });

  it('lets the other dimension fall out even, as H.264 requires', () => {
    expect(arg(ffmpegArgs({ input: 'i', output: 'o' }), '-vf')).toContain('-2');
  });

  it('derives the long edge from the height asked for', () => {
    expect(arg(ffmpegArgs({ input: 'i', output: 'o', height: 720 }), '-vf')).toContain('min(1280,iw)');
  });

  it('holds a ceiling as well as a quality target', () => {
    // CRF alone lets a dark, grainy crowd shot balloon past the original's own
    // bitrate, which would make the viewing copy the slow one.
    const args = ffmpegArgs({ input: 'i', output: 'o', maxrateMbps: 6 });
    expect(arg(args, '-maxrate')).toBe('6M');
    expect(arg(args, '-bufsize')).toBe('12M');
  });

  it('takes a hardware encoder when one is configured', () => {
    // A box with a GPU turns hours of 4K into minutes, and libx264 is only the
    // default because every build of ffmpeg has it.
    expect(arg(ffmpegArgs({ input: 'i', output: 'o', vcodec: 'h264_nvenc' }), '-c:v'))
      .toBe('h264_nvenc');
  });

  it('never reads stdin', () => {
    // There is none under a service manager, and ffmpeg treating a closed stdin
    // as a keypress has ended runs early.
    expect(ffmpegArgs({ input: 'i', output: 'o' })).toContain('-nostdin');
  });

  it('states the container, which the .part extension hides', () => {
    // The output is written to <name>.mp4.part so a partial file is never
    // served, and ffmpeg infers the muxer from the extension. Without -f every
    // encode failed at "Error initializing the muxer: Invalid argument".
    const args = ffmpegArgs({ input: 'i', output: 'o.mp4.part' });
    expect(arg(args, '-f')).toBe('mp4');
  });

  it('names the input and output it was given', () => {
    const args = ffmpegArgs({ input: '/a/VID_1.mp4', output: '/a/.web/VID_1.mp4.part' });
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
    const jobs = pendingInShow(sidecar([{ kind: 'VIDEO', name: 'VID_1.mp4' }]), ['VID_1.mp4.mp4']);
    expect(jobs).toEqual([]);
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
