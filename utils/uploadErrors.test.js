import { describe, it, expect, vi } from 'vitest';
import multer from 'multer';
import { uploadErrors, MAX_FILE_MB } from './uploadErrors.js';

const fakeRes = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

describe('uploadErrors', () => {
  it('turns an oversized file into a 413 that says the limit', () => {
    // Without this the MulterError reaches the app-wide handler, which reads
    // its missing `.status` as 500 and — in production — replaces the message
    // with "Internal server error". That is what you get told after spending
    // four minutes pushing a video up a home upstream link.
    const res = fakeRes();
    uploadErrors(new multer.MulterError('LIMIT_FILE_SIZE'), {}, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json.mock.calls[0][0].error).toContain(String(MAX_FILE_MB));
  });

  it('says a file rather than the file, because multer will not say which', () => {
    // A MulterError carries the form field ('files'), never the filename, and
    // a batch of forty is the normal case here. Claiming to know which one
    // would be worse than admitting we do not.
    const res = fakeRes();
    uploadErrors(new multer.MulterError('LIMIT_FILE_SIZE', 'files'), {}, res, vi.fn());
    expect(res.json.mock.calls[0][0].error).not.toMatch(/files/);
  });

  it('says how many files at once is too many', () => {
    const res = fakeRes();
    uploadErrors(new multer.MulterError('LIMIT_FILE_COUNT'), {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toMatch(/at once/i);
  });

  it('answers any other upload failure with multer\'s own wording, not a 500', () => {
    const res = fakeRes();
    uploadErrors(new multer.MulterError('LIMIT_UNEXPECTED_FILE'), {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('lets anything that is not an upload failure carry on to the app handler', () => {
    // A database error arriving here must not be answered as a bad request.
    const res = fakeRes();
    const next = vi.fn();
    const err = new Error('connection refused');
    uploadErrors(err, {}, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('uploadErrors, wired the way the upload route wires it', () => {
  it('answers a file over the limit rather than letting it reach the handler', async () => {
    // The unit tests above call the middleware directly, which proves what it
    // says but not that Express will ever hand it anything. A four-argument
    // function in a route chain is only reached as an error handler, and
    // getting that position wrong is silent: the route works, and the one
    // request that overruns the cap falls through to the app-wide 500.
    //
    // A real oversized upload is two gigabytes, so the limit is shrunk here
    // instead and the wiring is what is under test.
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;

    const tiny = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 } });
    const handler = vi.fn((req, res) => res.json({ reached: true }));

    const app = express();
    app.post('/upload', tiny.fields([{ name: 'files', maxCount: 2 }]), uploadErrors, handler);
    app.use((err, req, res, _next) => res.status(err.status ?? 500).json({ error: 'Internal server error' }));

    const res = await request(app)
      .post('/upload')
      .attach('files', Buffer.alloc(64), 'big.mp4')
      .expect(413);

    expect(res.body.error).toContain(String(MAX_FILE_MB));
    expect(handler).not.toHaveBeenCalled();
  });

  it('still lets a file under the limit through to the handler', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;

    const tiny = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 } });
    const app = express();
    app.post('/upload', tiny.fields([{ name: 'files', maxCount: 2 }]), uploadErrors,
      (req, res) => res.json({ reached: true }));

    const res = await request(app).post('/upload').attach('files', Buffer.alloc(16), 'ok.mp4').expect(200);
    expect(res.body.reached).toBe(true);
  });
});
