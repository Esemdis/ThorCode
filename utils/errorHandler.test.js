import { describe, it, expect, beforeEach, vi } from 'vitest';
import { inspect } from 'node:util';
import express from 'express';
import request from 'supertest';
import { errorHandler, logFieldsFor } from './errorHandler.js';

const THO982_PASSWORD = 'hunter2secret';

// Built the way index.js builds the app: the same parsers with the same
// limits, a route behind them, and the handler last.
function buildTho982App() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.post('/users/login', (_req, res) => res.json({ ok: true }));
  app.get('/boom', () => {
    const err = new Error('relation "users" violates constraint users_email_key');
    err.status = 500;
    throw err;
  });
  app.use(errorHandler);
  return app;
}

// What `docker logs` would hold: console renders each argument with
// util.inspect, so that is what is searched, not the arguments themselves.
function tho982Logged(spy) {
  return spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ')).join('\n');
}

describe('the app-wide error handler with a body that does not parse', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('answers a login with its closing brace cut off 400 and logs no password', async () => {
    const res = await request(buildTho982App())
      .post('/users/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"a@b.c","password":"${THO982_PASSWORD}"`);

    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalled();
    expect(tho982Logged(spy)).not.toContain('hunter2');
  });

  it('logs nothing of a body whose parse error quotes the input around it', async () => {
    // V8's "Unexpected token" message quotes about ten characters either side
    // of the position, so `err.message` and `err.stack` carry part of the
    // password even with `err.body` gone. Logging the message is not safe.
    const res = await request(buildTho982App())
      .post('/users/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"a@b.c","password":${THO982_PASSWORD}}`);

    expect(res.status).toBe(400);
    const logged = tho982Logged(spy);
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('a@b.c');
    expect(logged).not.toContain('email');
  });

  it('still says what happened: method, path, status and type', async () => {
    const res = await request(buildTho982App())
      .post('/users/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"a@b.c","password":"${THO982_PASSWORD}"`);

    const logged = tho982Logged(spy);
    expect(logged).toMatch(/POST \/users\/login/);
    expect(logged).toContain('400 entity.parse.failed');
    // The client's answer is the parser's own message, as before.
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('logs a too-large body by its type and answers 413', async () => {
    const app = express();
    app.use(express.json({ limit: '10b' }));
    app.post('/users/login', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/users/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.c', password: THO982_PASSWORD }));

    expect(res.status).toBe(413);
    const logged = tho982Logged(spy);
    expect(logged).toContain('413 entity.too.large');
    expect(logged).not.toContain('hunter2');
  });

  it('redacts a urlencoded body the parser refused the same way', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true, parameterLimit: 1 }));
    app.post('/users/login', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app)
      .post('/users/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`email=a%40b.c&password=${THO982_PASSWORD}`);

    expect(res.status).toBe(413);
    const logged = tho982Logged(spy);
    expect(logged).toContain('parameters.too.many');
    expect(logged).not.toContain('hunter2');
  });
});

describe('the app-wide error handler with an error of our own', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('still logs the whole error object, stack included', async () => {
    const res = await request(buildTho982App()).get('/boom');

    expect(res.status).toBe(500);
    const [, logged] = spy.mock.calls[0];
    expect(logged).toBeInstanceOf(Error);
    expect(inspect(logged)).toMatch(/users_email_key/);
    expect(inspect(logged)).toMatch(/at /);
  });
});

describe('logFieldsFor', () => {
  it('hands back an error that is neither the parser\'s nor axios\'s untouched', () => {
    const err = new Error('db down');
    expect(logFieldsFor(err)).toEqual([err]);
  });

  it('reduces an axios error to its status, never its config and headers', () => {
    const err = Object.assign(new Error('Request failed with status code 401'), {
      isAxiosError: true,
      response: { status: 401 },
      config: { headers: { Authorization: 'Bearer tho982-scraper-secret' } },
    });
    expect(logFieldsFor(err)).toEqual([401]);
  });

  it('falls back to the message for an axios error that never got an answer', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true });
    expect(logFieldsFor(err)).toEqual(['connect ECONNREFUSED']);
  });

  it('does not throw on a thrown string, null or undefined', () => {
    expect(logFieldsFor('oops')).toEqual(['oops']);
    expect(logFieldsFor(null)).toEqual([null]);
    expect(logFieldsFor(undefined)).toEqual([undefined]);
  });
});
