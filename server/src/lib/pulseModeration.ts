import { prisma } from '../db';

type Event = { id: string; communityId: string | null; telegramUpdateId: string; telegramMessageId: number | null; tgUserId: string | null; eventType: string; action: string | null; decision: string | null; status: string; metadata: unknown; feedback: string | null; reversedAt: Date | null; createdAt: Date };
export type PulseModerationFacts = { eventType: string; action: string; category: string; status: string; messageId: number | null; userId: string | null; episodeId: string | null; state: string; targetIds: string[]; rewrite: boolean; invalid: boolean; analysisKey: string };
export function pulseModerationFacts(e: Event): PulseModerationFacts {
  const m = e.metadata && typeof e.metadata === 'object' ? e.metadata as Record<string, unknown> : {};
  let action = e.action ?? '';
  if (action.includes('DELETE') && !action.includes('DELETE_PENDING')) {
    if (m['deletePending'] === true) action += '_DELETE_PENDING';
    else if (m['deletePending'] !== false) action += '_DELETE_UNCONFIRMED';
  }
  return { eventType: e.eventType, action, category: String(m['category'] ?? e.decision ?? ''), status: e.status,
    messageId: e.telegramMessageId, userId: e.tgUserId, episodeId: typeof m['episodeId'] === 'string' ? m['episodeId'] : null,
    state: String(m['state'] ?? ''), targetIds: Array.isArray(m['targetIds']) ? m['targetIds'].filter((x): x is string => typeof x === 'string') : [],
    rewrite: typeof m['suggestedRewrite'] === 'string' && Boolean(m['suggestedRewrite']) && !m['notificationError'],
    invalid: e.feedback === 'FALSE_POSITIVE' || Boolean(e.reversedAt), analysisKey: e.telegramUpdateId };
}

/** Copy only changed projections. No reason, response or source text is stored. */
export async function archivePulseModeration(events: Event[]): Promise<void> {
  const usable = events.filter((e): e is Event & { communityId: string } => Boolean(e.communityId) && (/DELETE/.test(e.action ?? '') || ['AI_MODERATION_TRIGGERED', 'AI_INTERVENTION', 'CONVERSATION_EPISODE'].includes(e.eventType)));
  if (!usable.length) return;
  const existing = await prisma.pulseModerationRecord.findMany({ where: { id: { in: usable.map(e => e.id) } }, select: { id: true, facts: true } });
  const previous = new Map(existing.map(e => [e.id, JSON.stringify(e.facts)]));
  const fresh = usable.filter(e => !previous.has(e.id));
  if (fresh.length) await prisma.pulseModerationRecord.createMany({ data: fresh.map(e => ({ id: e.id, communityId: e.communityId, occurredAt: e.createdAt, facts: pulseModerationFacts(e) })), skipDuplicates: true });
  // JSONB key order is normalized before comparison.
  for (const e of usable.filter(e => previous.has(e.id))) {
    const facts = pulseModerationFacts(e), old = JSON.parse(previous.get(e.id)!) as PulseModerationFacts;
    if (Object.keys(facts).some(k => JSON.stringify(facts[k as keyof PulseModerationFacts]) !== JSON.stringify(old[k as keyof PulseModerationFacts]))) await prisma.pulseModerationRecord.update({ where: { id: e.id }, data: { facts } });
  }
}

export function summarizePulseModeration(rows: { id: string; occurredAt: Date; facts: PulseModerationFacts }[]) {
  const episodes = new Map<string, { category: string; states: Set<string>; state: string }>();
  const affected = new Set<string>(), deleted = new Set<number>(), pending = new Set<number>(), unconfirmed = new Set<number>(), rewritten = new Set<number>();
  let softResponses = 0, sanctionedResponses = 0;
  for (const { facts: f } of [...rows].sort((a, b) => +a.occurredAt - +b.occurredAt)) {
    if (f.status === 'PROCESSED' && f.messageId != null && /DELETE/.test(f.action)) {
      if (f.action.includes('DELETE_PENDING')) pending.add(f.messageId);
      else if (f.action.includes('DELETE_UNCONFIRMED')) unconfirmed.add(f.messageId);
      else deleted.add(f.messageId);
      if (f.rewrite && deleted.has(f.messageId)) rewritten.add(f.messageId);
    }
    if (f.eventType === 'AI_INTERVENTION' && f.action.includes('RESPOND')) { if (/WARN|MUTE|BAN/.test(f.action)) sanctionedResponses++; else softResponses++; }
    // Feedback changes the classification, not the fact of a completed action.
    if (f.invalid) continue;
    if (f.episodeId) {
      const episode = episodes.get(f.episodeId) ?? { category: f.category, states: new Set<string>(), state: f.state };
      episode.states.add(f.state); episode.state = f.state; episodes.set(f.episodeId, episode);
    }
    for (const id of f.targetIds) affected.add(id);
  }
  for (const id of deleted) { pending.delete(id); unconfirmed.delete(id); }
  return { blockedMessages: deleted.size, pendingDeletions: pending.size, unconfirmedDeletions: unconfirmed.size, culturalRewrites: rewritten.size,
    interventions: softResponses, sanctionedResponses,
    conflicts: [...episodes.values()].filter(e => e.category === 'conflict').length,
    harassment: [...episodes.values()].filter(e => e.category === 'harassment').length,
    affectedUsers: affected.size, resolvedEpisodes: [...episodes.values()].filter(e => e.state === 'RESOLVED').length,
    escalatedEpisodes: [...episodes.values()].filter(e => e.states.has('ESCALATING')).length,
  };
}
