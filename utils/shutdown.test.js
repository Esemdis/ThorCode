import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { closeOnSigterm } from './shutdown.js';

function makeShutdownProc() {
  const proc = new EventEmitter();
  proc.exit = vi.fn();
  return proc;
}

describe('closeOnSigterm', () => {
  it('closes the server on SIGTERM and exits 0 only once it has closed', () => {
    const proc = makeShutdownProc();
    let finishClose;
    const server = { close: vi.fn((cb) => { finishClose = cb; }) };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    closeOnSigterm(server, proc);
    expect(server.close).not.toHaveBeenCalled();

    proc.emit('SIGTERM');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(proc.exit).not.toHaveBeenCalled();

    finishClose();
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('does not close twice when a second SIGTERM arrives', () => {
    const proc = makeShutdownProc();
    const server = { close: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    closeOnSigterm(server, proc);
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
  });
});
