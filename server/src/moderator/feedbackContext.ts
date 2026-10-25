import { prisma } from '../db';

/**
 * Owner-labelled AI decisions (👍/👎 in the journal, reversals) rendered as a
 * prompt section so the model adapts to this community without retraining.
 */
export async function ownerFeedbackContext(communityId: string, scope: 'PROFANITY' | 'CONVERSATION' = 'CONVERSATION'): Promise<string> {
  const events = await prisma.moderationEvent.findMany({
    where: { communityId, feedback: { in: ['FALSE_POSITIVE', 'CONFIRMED'] }, eventType: { in: scope === 'PROFANITY' ? ['AI_MODERATION_TRIGGERED'] : ['AI_INTERVENTION', 'CONVERSATION_EPISODE'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { feedback: true, decision: true, reason: true },
  });
  if (!events.length) return '';
  const lines = events.map(event => `- [${event.feedback === 'FALSE_POSITIVE' ? 'MISTAKE' : 'CORRECT'}] category=${(event.decision ?? 'other').slice(0, 64)}: ${(event.reason ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
  return `\n\nOWNER FEEDBACK ON PAST AI DECISIONS (the owner reviewed these; avoid repeating MISTAKE-type decisions, stay confident on CORRECT-type ones):\n${lines.join('\n')}`;
}
