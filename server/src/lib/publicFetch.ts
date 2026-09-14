import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { isPrivateIp } from './ssrfGuard';

/** Bounded GET for untrusted URLs. DNS is validated inside the socket lookup,
 * so redirects and DNS changes cannot bypass the address policy. */
export async function publicFetch(raw: string, options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<Response> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  let url = new URL(raw);
  for (let hop = 0; hop <= 4; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /^(localhost|.*\.(local|internal|localhost))$/i.test(host)) throw new Error('Blocked URL');
    if (net.isIP(host) && isPrivateIp(host)) throw new Error('Blocked private address');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Download timed out');
    const response = await new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        agent: false,
        signal: options.signal,
        headers: { 'User-Agent': 'PubliumBot/1.0', ...options.headers, 'Accept-Encoding': 'identity' },
        lookup: ((_hostname: string, lookupOptions: any, callback: any) => {
          dns.lookup(host, { all: true }).then(records => {
            if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('Blocked DNS address');
            if (lookupOptions.all) callback(null, records);
            else callback(null, records[0]!.address, records[0]!.family);
          }).catch(error => callback(error));
        }) as any,
      }, incoming => {
        incoming.on('error', reject);
        const status = incoming.statusCode ?? 502;
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        if (status >= 300 && status < 400) { incoming.destroy(); resolve(new Response(null, { status, headers })); return; }
        if (Number(headers.get('content-length')) > maxBytes || !['', 'identity', 'gzip', 'br', 'deflate'].includes(headers.get('content-encoding') ?? '')) { incoming.destroy(new Error('Download too large or unsupported encoding')); return; }
        const encoding = headers.get('content-encoding');
        const stream = encoding === 'gzip' ? incoming.pipe(createGunzip()) : encoding === 'br' ? incoming.pipe(createBrotliDecompress()) : encoding === 'deflate' ? incoming.pipe(createInflate()) : incoming;
        if (stream !== incoming) { headers.delete('content-encoding'); headers.delete('content-length'); }
        const chunks: Buffer[] = []; let size = 0;
        stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { stream.destroy(new Error('Download too large')); incoming.destroy(); } else chunks.push(chunk); });
        stream.on('error', reject);
        stream.on('end', () => resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers })));
      });
      const timer = setTimeout(() => request.destroy(new Error('Download timed out')), remaining);
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) { url = new URL(response.headers.get('location')!, url); continue; }
    return response;
  }
  throw new Error('Too many redirects');
}
