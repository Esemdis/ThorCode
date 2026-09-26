import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normaliseRange, isClip, parseClipRequest, planClips, prepareClip, removeClip, retargetClipRequests, clipFiles,
} from './mediaClips.js';

describe('normaliseRange', () => {
  it('reads neither end as the whole file', () => {
    expect(normaliseRange({})).toEqual({ range: { start_ms: null, end_ms: null } });
  });

  it('keeps a moment with both ends as asked', () => {
    expect(normaliseRange({ start_ms: 83_000, end_ms: 101_000 }, { durationMs: 240_000 }))
      .toEqual({ range: { start_ms: 83_000, end_ms: 101_000 } });
  });

  it('starts a moment with only an end at the beginning', () => {
    expect(normaliseRange({ end_ms: 12_000 })).toEqual({ range: { start_ms: 0, end_ms: 12_000 } });
  });

  it('runs a moment with only a start to the end', () => {
    expect(normaliseRange({ start_ms: 60_000 })).toEqual({ range: { start_ms: 60_000, end_ms: null } });
  });

  it('treats an end at or past the video\'s length as no end, so both ask for one link', () => {
    // The player's duration and the stored one are measured differently, so
    // "end here" on the last frame can land a few milliseconds either side.
    const past = normaliseRange({ start_ms: 60_000, end_ms: 240_004 }, { durationMs: 240_000 });
    const open = normaliseRange({ start_ms: 60_000 }, { durationMs: 240_000 });
    expect(past).toEqual(open);
  });

  it('shares 0-to-the-end as the file itself, not as a cut copy of all of it', () => {
    expect(normaliseRange({ start_ms: 0, end_ms: 240_000 }, { durationMs: 240_000 }))
      .toEqual({ range: { start_ms: null, end_ms: null } });
  });

  it('refuses a moment shorter than a second', () => {
    expect(normaliseRange({ start_ms: 5000, end_ms: 5400 }).error).toMatch(/at least a second/);
    expect(normaliseRange({ start_ms: 5000, end_ms: 4000 }).error).toMatch(/at least a second/);
  });

  it('refuses a start past the end of the video', () => {
    expect(normaliseRange({ start_ms: 250_000 }, { durationMs: 240_000 }).error).toMatch(/after the video ends/);
  });

  it('does not guess at the length of a video whose duration was never recorded', () => {
    expect(normaliseRange({ start_ms: 999_000 }, { durationMs: null }))
      .toEqual({ range: { start_ms: 999_000, end_ms: null } });
  });
});

describe('isClip', () => {
  it('is true when either end is set', () => {
    expect(isClip({ start_ms: 0, end_ms: 5000 })).toBe(true);
    expect(isClip({ start_ms: 5000, end_ms: null })).toBe(true);
    expect(isClip({ start_ms: null, end_ms: null })).toBe(false);
  });
});

describe('parseClipRequest', () => {
  const good = {
    id: 7, rel_path: 'user-1/show/VID_1.mp4', start_ms: 2500, end_ms: 6000,
    expires_at: '2026-09-27T12:00:00.000Z',
  };
  const text = (over = {}) => JSON.stringify({ ...good, ...over });

  it('reads a well-formed request', () => {
    expect(parseClipRequest('7.json', text())).toEqual({
      ...good, expires_at: new Date(good.expires_at),
    });
  });

  it('refuses a request whose id is not its own filename', () => {
    // So a renamed or copied request cannot cut one link's clip under another's.
    expect(parseClipRequest('8.json', text())).toBeNull();
  });

  it('refuses anything that is not JSON, or not a request', () => {
    expect(parseClipRequest('7.json', '{not json')).toBeNull();
    expect(parseClipRequest('7.json', text({ rel_path: '' }))).toBeNull();
    expect(parseClipRequest('7.json', text({ start_ms: -1 }))).toBeNull();
    expect(parseClipRequest('7.json', text({ end_ms: 1000 }))).toBeNull();
    expect(parseClipRequest('7.json', text({ expires_at: 'soon' }))).toBeNull();
    expect(parseClipRequest('notes.txt', text())).toBeNull();
  });

  it('accepts an open end', () => {
    expect(parseClipRequest('7.json', text({ end_ms: null })).end_ms).toBeNull();
  });
});

describe('planClips', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const request = (id, over = {}) => ({
    id, rel_path: 'u/s/V.mp4', start_ms: 0, end_ms: 5000,
    expires_at: new Date('2026-09-26T20:00:00Z'), ...over,
  });

  it('cuts a live request that has no clip yet', () => {
    const { jobs, sweep } = planClips(['7.json'], new Map([['7.json', request(7)]]), now);
    expect(jobs.map((j) => j.id)).toEqual([7]);
    expect(sweep).toEqual([]);
  });

  it('leaves a clip that is already cut, or that ffmpeg already refused', () => {
    const { jobs } = planClips(
      ['7.json', '7.mp4', '8.json', '8.mp4.failed'],
      new Map([['7.json', request(7)], ['8.json', request(8)]]),
      now,
    );
    expect(jobs).toEqual([]);
  });

  it('deletes everything belonging to an expired link', () => {
    const { jobs, sweep } = planClips(
      ['7.json', '7.mp4'],
      new Map([['7.json', request(7, { expires_at: new Date('2026-09-26T11:00:00Z') })]]),
      now,
    );
    expect(jobs).toEqual([]);
    expect(sweep.sort()).toEqual(['7.json', '7.mp4']);
  });

  it('deletes a request it cannot read, and whatever was cut for it', () => {
    const { sweep } = planClips(['7.json', '7.mp4.failed'], new Map([['7.json', null]]), now);
    expect(sweep.sort()).toEqual(['7.json', '7.mp4.failed']);
  });

  it('deletes a clip whose request is gone — a link revoked while it was cut', () => {
    const { sweep } = planClips(['9.mp4'], new Map(), now);
    expect(sweep).toEqual(['9.mp4']);
  });

  it('deletes a half-written cut left by a killed run', () => {
    const { jobs, sweep } = planClips(['7.json', '7.mp4.part'], new Map([['7.json', request(7)]]), now);
    expect(sweep).toEqual(['7.mp4.part']);
    // And cuts it again from the start: ffmpeg cannot resume into it.
    expect(jobs.map((j) => j.id)).toEqual([7]);
  });

  it('never touches a request the API is still writing', () => {
    // Swept between the API's write and its rename, the rename would fail and
    // the share with it.
    const { sweep } = planClips(['.7.json.a1b2c3.tmp'], new Map(), now);
    expect(sweep).toEqual([]);
  });
});

describe('prepareClip and removeClip', () => {
  let root;
  const link = {
    id: 7, start_ms: 2500, end_ms: 6000, expires_at: new Date('2026-09-27T00:00:00Z'),
  };
  const row = { rel_path: 'user-1/show/VID_1.mp4' };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clips-'));
  });

  it('writes the request the service reads, and says the clip is on its way', async () => {
    expect(await prepareClip(link, row, join(root, 'clips'))).toBe('preparing');

    const written = await readFile(join(root, 'clips', '7.json'), 'utf8');
    expect(parseClipRequest('7.json', written)).toEqual({
      id: 7, rel_path: 'user-1/show/VID_1.mp4', start_ms: 2500, end_ms: 6000,
      expires_at: link.expires_at,
    });
  });

  it('leaves no temp file behind', async () => {
    await prepareClip(link, row, root);
    expect(await readdir(root)).toEqual(['7.json']);
  });

  it('writes a lost request again, which is what makes cache/ safe to delete', async () => {
    await prepareClip(link, row, root);
    await removeClip(7, root);
    expect(await prepareClip(link, row, root)).toBe('preparing');
    expect(await readdir(root)).toEqual(['7.json']);
  });

  it('reports a finished clip as ready and a refused one as failed', async () => {
    await prepareClip(link, row, root);
    await writeFile(clipFiles(7, root).output, 'mp4');
    expect(await prepareClip(link, row, root)).toBe('ready');

    await removeClip(7, root);
    await writeFile(clipFiles(7, root).failed, 'ffprobe exited 1');
    expect(await prepareClip(link, row, root)).toBe('failed');
  });

  it('removes the request, the clip and the marker', async () => {
    await prepareClip(link, row, root);
    await writeFile(clipFiles(7, root).output, 'mp4');
    await removeClip(7, root);
    expect(await readdir(root)).toEqual([]);
  });
});

describe('retargetClipRequests', () => {
  let root;
  const link = {
    id: 7, start_ms: 2500, end_ms: 6000, expires_at: new Date('2026-09-27T00:00:00Z'),
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clips-'));
  });

  it('points a waiting request at the file\'s new path', async () => {
    await prepareClip(link, { rel_path: 'user-1/old-show/VID_1.mp4' }, root);

    const moved = await retargetClipRequests('user-1/old-show/VID_1.mp4', 'user-1/new-show/VID_1.mp4', root);
    expect(moved).toEqual([7]);

    const written = await readFile(clipFiles(7, root).request, 'utf8');
    expect(parseClipRequest('7.json', written).rel_path).toBe('user-1/new-show/VID_1.mp4');
  });

  it('leaves a request for a different file alone', async () => {
    await prepareClip(link, { rel_path: 'user-1/old-show/VID_1.mp4' }, root);

    const moved = await retargetClipRequests('user-1/old-show/VID_9.mp4', 'user-1/new-show/VID_9.mp4', root);
    expect(moved).toEqual([]);

    const written = await readFile(clipFiles(7, root).request, 'utf8');
    expect(parseClipRequest('7.json', written).rel_path).toBe('user-1/old-show/VID_1.mp4');
  });

  it('does not touch a clip that is already cut or already failed', async () => {
    await prepareClip(link, { rel_path: 'user-1/old-show/VID_1.mp4' }, root);
    await writeFile(clipFiles(7, root).output, 'mp4');

    expect(await retargetClipRequests('user-1/old-show/VID_1.mp4', 'user-1/new-show/VID_1.mp4', root)).toEqual([]);
  });

  it('is a no-op when nothing is waiting yet', async () => {
    expect(await retargetClipRequests('user-1/old-show/VID_1.mp4', 'user-1/new-show/VID_1.mp4', root)).toEqual([]);
  });
});
