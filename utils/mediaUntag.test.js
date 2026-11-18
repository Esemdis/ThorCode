import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { retagBandInSidecars } = require('./mediaUntag.js');

// Stands in for updateSidecar: runs the mutation against the sidecar held for
// each folder and keeps what it returns, or records a write that failed.
function tho999SidecarStore(byDir, { failing = [] } = {}) {
  const written = {};
  const update = async (abs, mutate) => {
    const dir = Object.keys(byDir).find((d) => abs.endsWith(d));
    if (failing.includes(dir)) throw new Error('EACCES');
    const next = mutate(byDir[dir] ?? null);
    if (next) written[dir] = next;
  };
  return { update, written };
}

describe('retagBandInSidecars', () => {
  // resolveArchivePath refuses to run without a root; nothing is written there.
  beforeEach(() => { vi.stubEnv('MEDIA_ROOT', '/srv/tho999-media'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('moves the merged band\'s files onto the survivor by id and name, keeping the song', async () => {
    // band_name follows the id, or a rebuild restores the old spelling; the song
    // stays because it is the same artist's song.
    const store = tho999SidecarStore({
      'u/show-a': {
        files: [
          { name: 'a.mp4', band_id: 1, band_name: 'Opeth (SE)', song: 'Ghost of Perdition' },
          { name: 'b.jpg', band_id: 3, band_name: 'Gojira', song: null },
        ],
      },
    });
    const failed = await retagBandInSidecars(['u/show-a/a.mp4'], 1, { id: 2, name: 'Opeth' }, { update: store.update });
    expect(failed).toEqual([]);
    expect(store.written['u/show-a'].files).toEqual([
      { name: 'a.mp4', band_id: 2, band_name: 'Opeth', song: 'Ghost of Perdition' },
      { name: 'b.jpg', band_id: 3, band_name: 'Gojira', song: null },
    ]);
  });

  it('writes each folder once, however many of its files were tagged', async () => {
    let calls = 0;
    const update = async (_abs, mutate) => { calls += 1; mutate({ files: [] }); };
    await retagBandInSidecars(['u/s/a.jpg', 'u/s/b.jpg', 'u/t/c.jpg'], 1, { id: 2, name: 'Opeth' }, { update });
    expect(calls).toBe(2);
  });

  it('reports a folder it could not write and carries on with the rest, since the rows have already committed', async () => {
    const store = tho999SidecarStore({
      'u/locked': { files: [{ name: 'a.jpg', band_id: 1 }] },
      'u/open': { files: [{ name: 'b.jpg', band_id: 1 }] },
    }, { failing: ['u/locked'] });
    const failed = await retagBandInSidecars(['u/locked/a.jpg', 'u/open/b.jpg'], 1, { id: 2, name: 'Opeth' }, { update: store.update });
    expect(failed).toEqual([{ dir: 'u/locked', error: 'EACCES' }]);
    expect(store.written['u/open'].files[0]).toMatchObject({ band_id: 2, band_name: 'Opeth' });
  });
});
