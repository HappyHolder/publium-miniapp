import { prisma } from '../db';
import { storagePath } from './storage';

/** External public media may be referenced; registered local media is owner scoped. */
export async function assertMediaAccess(value: unknown, userId: string): Promise<void> {
  if (Array.isArray(value)) { for (const item of value) await assertMediaAccess(item, userId); return; }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) await assertMediaAccess(item, userId); return; }
  if (typeof value !== 'string') return;
  const pathname = storagePath(value);
  if (!pathname) return;
  const asset = await prisma.storedAsset.findUnique({ where: { pathname } });
  if (asset?.ownerUserId && asset.ownerUserId !== userId) throw Object.assign(new Error('Этот файл принадлежит другому пользователю.'), { status: 403 });
}
