const net = require('node:net');

// Every IP-keyed rate limit counts one client per key, and for IPv6 one client
// is not one address. A subscriber is handed a whole /64 (RFC 6177; most ISPs
// give a /56 or /48), and privacy extensions pick a fresh address inside it on
// their own, so keying on the full address gave anyone on IPv6 a fresh budget
// per request: ten wrong passwords per address was ten per request (THO-975).
// The /64 is the smallest block one subscriber always owns, so it never lumps
// two households together.
//
// IPv4-mapped addresses (`::ffff:203.0.113.7`) are what Node reports for an
// IPv4 client on a dual-stack socket. Read as IPv6 they would all fall into
// one /64, `0:0:0:0::/64`, and every IPv4 client on the internet would share
// a single budget, so they are read as the IPv4 address they carry.

/** The eight 16-bit groups of an IPv6 address, as numbers. */
function ipv6Groups(address) {
  let text = address;
  // A dotted IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two groups.
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : (rest ? rest.split(':') : []);
  const missing = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(missing).fill('0'), ...right].map((g) => parseInt(g, 16));
}

/**
 * The key an IP-keyed limiter counts a request under: an IPv4 address as it
 * is, an IPv6 address as its /64 (`2001:db8:0:1::/64`), and anything else,
 * including no address at all, as a fixed string of its own.
 *
 * @param {unknown} ip - `req.ip`
 * @returns {string}
 */
function ipBucket(ip) {
  if (typeof ip !== 'string' || ip === '') return 'unknown';
  // A zone id (`fe80::1%eth0`) names the local interface, not the client.
  const address = ip.split('%')[0].toLowerCase();
  if (net.isIPv4(address)) return address;
  if (!net.isIPv6(address)) return address;

  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6], groups[7]];
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

module.exports = { ipBucket };
