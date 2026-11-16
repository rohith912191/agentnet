// SSRF-safe HTTP transport for webhook delivery.
//
// Registration-time URL checks are not enough: a public-looking hostname can resolve to a private
// address (e.g. localtest.me -> 127.0.0.1), DNS answers can change between check and use (DNS
// rebinding), and an endpoint can answer with a redirect into the private network. So, at send time:
//   - IP-literal hosts are checked before connecting;
//   - hostnames go through a guarded DNS lookup that is the *same* lookup the socket connects with,
//     and every returned address must be public, otherwise the request fails (no TOCTOU window);
//   - redirects are never followed (node:http does not follow them; 3xx is returned to the caller);
//   - response bodies are drained and discarded, so sockets are released.
//
// Returns a fetch-like function `(url, { method, headers, body, signal }) -> { ok, status }`.
// `allowPrivateNetworks` disables the address checks; it is only for local development and tests.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isPublicAddress } from '../security/ip.js';

export class BlockedDestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedDestinationError';
    this.code = 'EBLOCKED';
  }
}

/** A `lookup` for net/http that refuses hostnames resolving to any non-public address. */
export function createGuardedLookup(resolver = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolver(hostname, { all: true, family: options.family ?? 0, hints: options.hints }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (list.length === 0) return callback(new BlockedDestinationError(`${hostname} did not resolve to any address`));
      const blocked = list.find((a) => !isPublicAddress(a.address));
      if (blocked) return callback(new BlockedDestinationError(`${hostname} resolves to non-public address ${blocked.address}`));
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

export function createSafeFetch({ allowPrivateNetworks = false, resolver = dns.lookup } = {}) {
  const lookup = allowPrivateNetworks ? null : createGuardedLookup(resolver);

  return function safeFetch(url, { method = 'POST', headers = {}, body = '', signal } = {}) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch {
        reject(new BlockedDestinationError('invalid webhook URL'));
        return;
      }
      const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
      if (!transport) {
        reject(new BlockedDestinationError(`unsupported protocol ${target.protocol}`));
        return;
      }
      const host = target.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivateNetworks && net.isIP(host) && !isPublicAddress(host)) {
        reject(new BlockedDestinationError(`non-public address ${host}`));
        return;
      }

      const options = {
        method,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        ...(lookup ? { lookup } : {}),
        ...(signal ? { signal } : {}),
      };
      const req = transport.request(target, options, (res) => {
        res.resume(); // webhook responses are never read; drain so the socket is released
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}
