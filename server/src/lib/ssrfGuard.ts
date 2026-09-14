/**
 * ssrfGuard.ts
 *
 * Shared SSRF protection: rejects URLs that resolve to non-public addresses
 * (loopback, private, link-local, CGNAT, unique-local) so user-supplied URLs
 * and user-authored HTML cannot make the server reach internal services
 * (Postgres, other containers, localhost, cloud metadata).
 *
 * Used by urlContentExtractor (article fetch) and playwrightRenderer (cover
 * rendering route interception).
 */

import dns from 'dns/promises';
import net from 'net';

/** True for loopback / private / link-local / CGNAT / ULA / unspecified IPs. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().trim();

  if (net.isIPv6(v)) {
    if (v === '::1' || v === '::') return true;                 // loopback / unspecified
    if (/^fe[89ab]/.test(v)) return true;                      // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true;  // unique-local (ULA)
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);     // IPv4-mapped
    if (mapped && mapped[1]) return isPrivateIp(mapped[1]);
    const normalized = new URL(`http://[${v}]/`).hostname.slice(1, -1);
    const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16); return isPrivateIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    if (v.startsWith('ff') || v.startsWith('2001:db8:')) return true;
    return false;
  }

  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // not a clean IPv4 literal → treat as unsafe
  }
  const [a, b] = parts as [number, number];
  if (a >= 224) return true;
  if (a === 0)   return true;                       // 0.0.0.0/8
  if (a === 10)  return true;                       // 10/8 private
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true;          // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64/10 CGNAT
  return false;
}

/** Throws if the hostname is internal or resolves to any non-public address. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked: private IP literal');
    return;
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw new Error('blocked: internal hostname');
  }

  const records = await dns.lookup(host, { all: true });
  if (records.length === 0) throw new Error('blocked: no DNS records');
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('blocked: resolves to private IP');
  }
}

/**
 * For request interceptors (Playwright). Returns true when the request URL must
 * be blocked: non-http(s) schemes (file:, etc.) and any host that is/resolves to
 * a non-public address. data:/blob:/about: are allowed (inline, no network).
 */
export async function isBlockedRequestUrl(rawUrl: string): Promise<boolean> {
  if (rawUrl === 'about:blank' || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false; // relative URL inside about:blank — no network egress
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return true; // block file:, ftp:, etc.
  try {
    await assertPublicHost(u.hostname);
    return false;
  } catch {
    return true;
  }
}
