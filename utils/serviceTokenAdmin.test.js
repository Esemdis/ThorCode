import { describe, it, expect } from 'vitest';
import { parseServiceTokensArgs, serviceTokenStatus, formatServiceTokenRows } from './serviceTokenAdmin.js';

const JTI_ADMIN_1016 = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60';
const NOW_ADMIN_1016 = new Date('2026-11-25T12:00:00Z');

describe('parseServiceTokensArgs (THO-1016)', () => {
  it('reads list, list --all and withdraw <jti>', () => {
    expect(parseServiceTokensArgs(['list'])).toEqual({ command: 'list', all: false });
    expect(parseServiceTokensArgs(['list', '--all'])).toEqual({ command: 'list', all: true });
    expect(parseServiceTokensArgs(['withdraw', JTI_ADMIN_1016])).toEqual({ command: 'withdraw', jti: JTI_ADMIN_1016 });
  });

  it('lowercases a pasted jti, as Prisma stores it', () => {
    expect(parseServiceTokensArgs(['withdraw', JTI_ADMIN_1016.toUpperCase()]).jti).toBe(JTI_ADMIN_1016);
  });

  it('refuses a malformed jti before it reaches a query', () => {
    expect(parseServiceTokensArgs(['withdraw', 'abc']).error).toMatch(/Not a token id/);
    expect(parseServiceTokensArgs(['withdraw']).error).toBeTruthy();
    expect(parseServiceTokensArgs(['withdraw', JTI_ADMIN_1016, 'extra']).error).toBeTruthy();
  });

  it('refuses no command, an unknown one and a stray list option', () => {
    expect(parseServiceTokensArgs([]).error).toBeTruthy();
    expect(parseServiceTokensArgs(['delete', JTI_ADMIN_1016]).error).toBeTruthy();
    expect(parseServiceTokensArgs(['list', '--everything']).error).toBeTruthy();
  });
});

describe('serviceTokenStatus (THO-1016)', () => {
  const future = new Date('2027-11-25T12:00:00Z');
  const past = new Date('2026-01-01T00:00:00Z');

  it('calls a token active, expired or withdrawn', () => {
    expect(serviceTokenStatus({ withdrawn_at: null, expires_at: future }, NOW_ADMIN_1016)).toBe('active');
    expect(serviceTokenStatus({ withdrawn_at: null, expires_at: past }, NOW_ADMIN_1016)).toBe('expired');
    expect(serviceTokenStatus({ withdrawn_at: past, expires_at: future }, NOW_ADMIN_1016)).toBe('withdrawn');
  });

  it('says withdrawn for a token that was withdrawn and has since expired, since that one was done on purpose', () => {
    expect(serviceTokenStatus({ withdrawn_at: past, expires_at: past }, NOW_ADMIN_1016)).toBe('withdrawn');
  });
});

describe('formatServiceTokenRows (THO-1016)', () => {
  const rowsAdmin1016 = [
    {
      id: JTI_ADMIN_1016, scope: null, created_at: new Date('2026-11-25T08:00:00Z'),
      expires_at: new Date('2027-11-25T08:00:00Z'), withdrawn_at: null,
      user_rel: { email: 'sync@example.test', role: 'SYSTEM' },
    },
    {
      id: '00000000-0000-4000-8000-000000000001', scope: 'wander', created_at: new Date('2026-11-01T08:00:00Z'),
      expires_at: new Date('2027-11-01T08:00:00Z'), withdrawn_at: new Date('2026-11-20T08:00:00Z'),
      user_rel: { email: 'me@example.test', role: 'USER' },
    },
  ];

  it('prints a header and one aligned line per token with jti, email, role or scope, created and expiry', () => {
    const lines = formatServiceTokenRows(rowsAdmin1016, NOW_ADMIN_1016);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^JTI\s+EMAIL\s+ROLE\/SCOPE\s+CREATED\s+EXPIRES$/);
    expect(lines[1]).toMatch(new RegExp(`^${JTI_ADMIN_1016}\\s+sync@example.test\\s+SYSTEM\\s+2026-11-25\\s+2027-11-25$`));
    expect(lines[2]).toMatch(/me@example.test\s+USER\/wander\s+2026-11-01\s+2027-11-01$/);
    expect(lines[1].indexOf('2026-11-25')).toBe(lines[2].indexOf('2026-11-01'));
  });

  it('adds a status column for --all', () => {
    const lines = formatServiceTokenRows(rowsAdmin1016, NOW_ADMIN_1016, { withStatus: true });
    expect(lines[0]).toMatch(/STATUS$/);
    expect(lines[1]).toMatch(/active$/);
    expect(lines[2]).toMatch(/withdrawn$/);
  });

  it('says so when there is nothing to list', () => {
    expect(formatServiceTokenRows([], NOW_ADMIN_1016)).toEqual(['No active service tokens.']);
    expect(formatServiceTokenRows([], NOW_ADMIN_1016, { withStatus: true })).toEqual(['No service tokens.']);
  });
});
