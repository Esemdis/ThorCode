import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ipBucket } = require('./clientIp.js');

describe('ipBucket (THO-975)', () => {
  it('keys an IPv4 address on the address itself', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('203.0.113.8')).toBe('203.0.113.8');
  });

  // The bug: each of these was its own bucket, so an IPv6 client could make
  // every request from a fresh address and never be limited.
  it('gives every address in one IPv6 /64 the same key', () => {
    const a = ipBucket('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = ipBucket('2001:db8:1234:5678::1');
    expect(a).toBe('2001:db8:1234:5678::/64');
    expect(b).toBe(a);
  });

  it('keeps neighbouring /64s apart, so two households are never lumped together', () => {
    expect(ipBucket('2001:db8:1234:5679::1')).not.toBe(ipBucket('2001:db8:1234:5678::1'));
  });

  it('expands :: wherever it sits before reading the first four groups', () => {
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('2001:db8:0:1::')).toBe('2001:db8:0:1::/64');
    expect(ipBucket('2001:0db8:0000:0001:0:0:0:1')).toBe('2001:db8:0:1::/64');
  });

  // Node reports an IPv4 client on a dual-stack socket this way. Read as IPv6,
  // every IPv4 client would land in 0:0:0:0::/64 and share one budget.
  it('reads an IPv4-mapped address as the IPv4 address it carries', () => {
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('ignores case and the zone id', () => {
    expect(ipBucket('2001:DB8:ABCD:1::1')).toBe('2001:db8:abcd:1::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('gives a request with no address one fixed key rather than undefined', () => {
    expect(ipBucket(undefined)).toBe('unknown');
    expect(ipBucket('')).toBe('unknown');
    expect(ipBucket(null)).toBe('unknown');
  });
});
