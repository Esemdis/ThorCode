import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveStatus, archiveWarning } from './mediaHealth.js';

const ORIGINAL_ROOT = process.env.MEDIA_ROOT;

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-health-'));
});

afterEach(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.MEDIA_ROOT;
  else process.env.MEDIA_ROOT = ORIGINAL_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('archiveStatus', () => {
  it('reports an unset MEDIA_ROOT rather than throwing', async () => {
    // mediaRoot() throws on use, not at boot, so nothing else notices this
    // until the first byte route answers 404.
    delete process.env.MEDIA_ROOT;
    expect(await archiveStatus()).toEqual({
      root: null, readable: false, entries: null, reason: 'unconfigured',
    });
  });

  it('reports a mount point with nothing behind it', async () => {
    // What a dropped SMB share looks like: the directory is there, readable and
    // empty, and every path under it resolves to a file that is not.
    process.env.MEDIA_ROOT = tmp;
    await fs.mkdir(path.join(tmp, 'archive'));
    expect(await archiveStatus()).toMatchObject({ readable: true, entries: 0, reason: 'empty' });
  });

  it('says nothing is wrong when the archive has owners in it', async () => {
    process.env.MEDIA_ROOT = tmp;
    await fs.mkdir(path.join(tmp, 'archive', 'f09cd1f0-user'), { recursive: true });
    expect(await archiveStatus()).toMatchObject({ readable: true, entries: 1, reason: null });
  });

  it('reports a missing archive directory', async () => {
    process.env.MEDIA_ROOT = path.join(tmp, 'nowhere');
    expect(await archiveStatus()).toMatchObject({ readable: false, reason: 'missing' });
  });

  it('reports a MEDIA_ROOT that points at a file', async () => {
    const file = path.join(tmp, 'a-file');
    await fs.writeFile(file, 'x');
    process.env.MEDIA_ROOT = file;
    expect(await archiveStatus()).toMatchObject({ readable: false, reason: 'not_a_directory' });
  });
});

describe('archiveWarning', () => {
  it('stays quiet when the archive is there and populated', () => {
    expect(archiveWarning({ root: '/media/archive', readable: true, reason: null })).toBeNull();
  });

  it('names the path, because the point is to look at it', () => {
    const said = archiveWarning({ root: '/media/archive', readable: false, reason: 'missing' });
    expect(said).toContain('/media/archive');
    expect(said).toMatch(/404/);
  });

  it('suggests the mount when the archive is merely empty', () => {
    expect(archiveWarning({ root: '/media/archive', readable: true, reason: 'empty' }))
      .toMatch(/not mounted/i);
  });

  it('says so plainly when MEDIA_ROOT was never set', () => {
    expect(archiveWarning({ root: null, readable: false, reason: 'unconfigured' }))
      .toMatch(/MEDIA_ROOT is not set/);
  });
});
