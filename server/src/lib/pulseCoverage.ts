import { prisma } from '../db';
import { getBotIdFromToken, getBotWebhookInfo, getChatMember } from './telegramBot';
import { pulseKey, pulseStart, DAY } from './pulseScoring';

/** Sampling availability every 30 minutes is an explicit coverage proxy. It
 * cannot certify Telegram delivery or classifier accuracy. Failed probes stay
 * visible, including quiet chats: no message is needed to establish a day. */
export async function observePulseCoverage(communityId: string, chatId: string, tokens: string[], now = new Date()): Promise<string | null> {
  const probes = await Promise.all([...new Set(tokens.filter(Boolean))].map(async token => {
    const [hook, member] = await Promise.all([getBotWebhookInfo(token).catch(() => null), getChatMember(chatId, getBotIdFromToken(token), token).catch(() => null)]);
    const updates = hook?.allowed_updates;
    const knownHandler = hook?.url && /\/api\/(moderator|community-manager)\/webhook(?:\/\d+)?$/.test(hook.url);
    const healthy = Boolean(knownHandler && member?.status === 'administrator' && hook?.pending_update_count === 0 && (!updates?.length || updates.includes('message')));
    return { token, healthy, membership: healthy && Boolean(updates?.includes('chat_member')) };
  }));
  const healthy = probes.some(p => p.healthy), membership = probes.some(p => p.membership);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${communityId + ':coverage'}))`;
    // The first heartbeat after midnight closes the previous day, without
    // inventing a heartbeat on days lost to an outage.
    const keys = [pulseKey(+now - DAY), pulseKey(+now)];
    let continuousAtMidnight = false;
    for (const day of keys) {
      const row = await tx.pulseCoverage.findUnique({ where: { communityId_day: { communityId, day } } });
      const isToday = day === keys[1];
      if (!row && !isToday) continue;
      if (!isToday && row) continuousAtMidnight = row.healthy && +now - +row.lastAt <= 45 * 60_000;
      if (!isToday && row && +row.lastAt >= pulseStart(day) + DAY) continue;
      const gap = row ? Math.min(2_147_483_647, Math.max(0, +now - +row.lastAt)) : 0;
      const lastAt = new Date(Math.min(+now, pulseStart(day) + DAY));
      await tx.pulseCoverage.upsert({ where: { communityId_day: { communityId, day } },
        create: { communityId, day, firstAt: continuousAtMidnight ? new Date(pulseStart(day)) : now, lastAt, healthy, membership },
        update: { lastAt, maxGapMs: Math.max(row?.maxGapMs ?? 0, gap), healthy: Boolean(row?.healthy && healthy), membership: Boolean(row?.membership && membership) },
      });
    }
  });
  return probes.find(p => p.healthy)?.token ?? null;
}
