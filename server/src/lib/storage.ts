import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { storageOwner } from './storageContext';
/**
 * storage.ts
 *
 * Local filesystem object storage — the self-hosted replacement for Vercel Blob.
 *
 * Files are written under env.STORAGE_DIR (a Docker volume in production) and
 * served publicly at `${PUBLIC_BASE_URL}/uploads/<pathname>` by nginx (prod) or
 * by the Express static handler (dev — see index.ts). The returned URL is a real,
 * public HTTPS URL so Telegram can fetch covers and the frontend can render them,
 * exactly like the old Vercel Blob URLs.
 *
 * Drop-in shape: `putObject(pathname, buffer, { contentType })` returns `{ url }`,
 * mirroring the `put()` call sites it replaces. contentType is accepted for
 * call-site compatibility but not needed on disk — the web server sets the
 * Content-Type header from the file extension (pathnames carry .jpg/.png/.html).
 */

import fs from 'fs/promises';
import path from 'path';
import { env } from '../env';

/** Public URL path prefix under which all stored objects are served. */
const PUBLIC_PREFIX = '/uploads';

export interface PutResult {
  /** Public URL of the stored object (e.g. https://domain/uploads/covers/x.jpg). */
  url: string;
  /** Storage-relative path the object was written to. */
  pathname: string;
}

/**
 * Writes a buffer to local storage and returns its public URL.
 * Creates any missing parent directories. Never silently no-ops: local FS is
 * always available, so (unlike the old Blob token guards) callers can assume
 * this succeeds or throws.
 */
export async function putObject(
  pathname: string,
  data: Buffer,
  _opts?: { contentType?: string },
): Promise<PutResult> {
  // Normalize: strip leading slashes and reject path traversal.
  const original = pathname.replace(/^\/+/, '');
  if (original.includes('..') || original.includes('\\') || original.includes(':')) throw new Error('Illegal storage path');
  const clean = path.posix.join(path.posix.dirname(original), `${randomUUID()}-${path.posix.basename(original)}`);
  if (clean.includes('..')) {
    throw new Error(`[storage] Illegal pathname (path traversal): ${pathname}`);
  }

  const dest = path.join(env.STORAGE_DIR, clean);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, data);

  await prisma.storedAsset.create({ data: { pathname: clean, ownerUserId: storageOwner.getStore() ?? null } });
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return { url: `${base}${PUBLIC_PREFIX}/${clean}`, pathname: clean };
}

/**
 * Reads a previously stored object's bytes by its public URL (or storage-relative
 * path). Returns null if the file is missing or resolves outside STORAGE_DIR.
 * Applies the same path-traversal guards as deleteObject.
 */
export async function readObject(urlOrPath: string): Promise<Buffer | null> {
  try {
    if (!urlOrPath || typeof urlOrPath !== 'string') return null;
    const rel = storagePath(urlOrPath);
    if (!rel) return null;

    const dest = path.resolve(env.STORAGE_DIR, rel);
    const root = path.resolve(env.STORAGE_DIR);
    if (dest !== root && !dest.startsWith(root + path.sep)) return null; // outside storage — refuse
    return await fs.readFile(dest);
  } catch {
    return null;
  }
}

/**
 * Deletes a previously stored object by its public URL (or storage-relative path).
 * Non-fatal and bounded: ignores URLs that aren't ours, rejects path traversal,
 * and never deletes outside STORAGE_DIR. Swallows all errors (best-effort cleanup).
 */
export function storagePath(value: string): string | null {
  try {
    let rel = value;
    if (/^https?:/i.test(value)) {
      const url = new URL(value);
      if (url.origin !== new URL(env.PUBLIC_BASE_URL).origin || !url.pathname.startsWith('/uploads/')) return null;
      rel = decodeURIComponent(url.pathname.slice('/uploads/'.length));
    } else if (/^[a-z]+:/i.test(value)) return null;
    else rel = decodeURIComponent(value.split(/[?#]/)[0]!).replace(/^\/?uploads\//, '');
    rel = rel.split('?')[0]!.replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes(':') || path.isAbsolute(rel)) return null;
    return rel;
  } catch { return null; }
}

/** Cleanup requires known ownership and never follows arbitrary URL path fragments.
 * Legacy files and shared assets remain intact when ownership cannot be proven. */
export async function deleteObject(urlOrPath: string, ownerUserId = storageOwner.getStore()): Promise<void> {
  const pathname = storagePath(urlOrPath);
  if (!pathname || !ownerUserId) return;
  const asset = await prisma.storedAsset.findUnique({ where: { pathname } });
  if (!asset || asset.ownerUserId !== ownerUserId) return;
  // Search every persistent reference, including shared templates and other posts.
  for (const table of ['BrandKit', 'PostVariant', 'GeneratedPost', 'Style', 'ProjectDoc', 'RoleKnowledgeDoc', 'ChatMessage']) {
    const encoded = pathname.split('/').map(encodeURIComponent).join('/');
    const rows = await prisma.$queryRawUnsafe<{ found: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM "${table}" t WHERE strpos(to_jsonb(t)::text, $1) > 0 OR strpos(to_jsonb(t)::text, $2) > 0) AS found`, pathname, encoded);
    if (rows[0]?.found) return;
  }
  await fs.unlink(path.resolve(env.STORAGE_DIR, pathname)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await prisma.storedAsset.deleteMany({ where: { pathname, ownerUserId } });
}

/**
 * Deletes files directly inside `<STORAGE_DIR>/<subdir>` older than `maxAgeMs`.
 * Used to sweep short-lived scratch uploads (e.g. assistant chat screenshots,
 * which are deleted right after vision extraction but can be orphaned if a
 * request fails). Best-effort; returns the count removed.
 */
export async function purgeOldFiles(subdir: string, maxAgeMs: number): Promise<number> {
  const safe = subdir.replace(/^\/+|\/+$/g, '');
  if (!safe || safe.includes('..')) return 0;
  const dir = path.resolve(env.STORAGE_DIR, safe);
  const root = path.resolve(env.STORAGE_DIR);
  if (dir !== root && !dir.startsWith(root + path.sep)) return 0;
  let removed = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) { const pathname = `${safe}/${entry.name}`; const asset = await prisma.storedAsset.findUnique({ where: { pathname } }); if (asset?.ownerUserId) { await deleteObject(pathname, asset.ownerUserId); removed++; } }
      } catch { /* skip */ }
    }
  } catch { /* dir missing — nothing to do */ }
  return removed;
}
