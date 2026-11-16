// IP address classification for SSRF defence. A webhook may only be delivered to globally routable
// unicast addresses. Everything else is refused: loopback, private, link-local, CGNAT, multicast,
// documentation and reserved ranges, plus IPv6 forms that embed an IPv4 address (IPv4-mapped,
// NAT64), which are judged by the embedded IPv4 address.

import net from 'node:net';

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata endpoints live here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
].map(([base, bits]) => ({ net: v4ToInt(parseIPv4(base)), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

/** Returns [a, b, c, d] for a dotted-quad IPv4 address, otherwise null. */
export function parseIPv4(str) {
  if (!net.isIPv4(String(str))) return null;
  return String(str).split('.').map(Number);
}

function v4ToInt([a, b, c, d]) {
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

/** Returns the 16 bytes of an IPv6 address (brackets and zone ids allowed), otherwise null. */
export function parseIPv6(input) {
  let str = String(input).replace(/^\[|\]$/g, '');
  const zone = str.indexOf('%');
  if (zone !== -1) str = str.slice(0, zone);
  if (!net.isIPv6(str)) return null;

  // Rewrite an embedded dotted IPv4 tail (e.g. ::ffff:1.2.3.4) as two hextets.
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    str = `${str.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  let groups;
  if (str.includes('::')) {
    const [head, rest] = str.split('::');
    const h = head ? head.split(':') : [];
    const t = rest ? rest.split(':') : [];
    groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  } else {
    groups = str.split(':');
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    bytes[2 * i] = v >> 8;
    bytes[2 * i + 1] = v & 0xff;
  });
  return bytes;
}

function isPublicV4(octets) {
  const ip = v4ToInt(octets);
  return !V4_BLOCKED.some(({ net: base, mask }) => ((ip & mask) >>> 0) === base);
}

const allZero = (bytes, from, to) => bytes.slice(from, to).every((x) => x === 0);

/** True only for globally routable unicast IPv4/IPv6 addresses. Non-IP strings return false. */
export function isPublicAddress(address) {
  const v4 = parseIPv4(address);
  if (v4) return isPublicV4(v4);

  const b = parseIPv6(address);
  if (!b) return false;

  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64): judge the embedded IPv4 address.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4([...b.slice(12)]);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) return isPublicV4([...b.slice(12)]);

  if ((b[0] & 0xe0) !== 0x20) return false; // outside 2000::/3 global unicast (::, ::1, fc00::/7, fe80::/10, ff00::/8, ...)
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return false; // 2001::/23 special purpose (Teredo, ORCHID, ...)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 2002::/16 6to4 (tunnels to arbitrary IPv4)
  return true;
}
