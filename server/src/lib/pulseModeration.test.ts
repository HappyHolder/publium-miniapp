import test from 'node:test';
import assert from 'node:assert/strict';
import { pulseModerationFacts, summarizePulseModeration, type PulseModerationFacts } from './pulseModeration';
const base: PulseModerationFacts = { eventType: 'CONVERSATION_EPISODE', action: 'OBSERVE', category: 'conflict', status: 'PROCESSED', messageId: 1, userId: '1', episodeId: 'e1', state: 'DEVELOPING', targetIds: ['2'], rewrite: false, invalid: false, analysisKey: 'a' };
const row = (id: number, facts: Partial<PulseModerationFacts>) => ({ id: String(id), occurredAt: new Date(id * 1000), facts: { ...base, ...facts } });
test('period moderation counts unique episodes and targets, not daily/event sums', () => {
  const r = summarizePulseModeration([row(1, {}), row(2, { state: 'ESCALATING' }), row(3, { state: 'RESOLVED' })]);
  assert.equal(r.conflicts, 1); assert.equal(r.harassment, 0); assert.equal(r.affectedUsers, 1); assert.equal(r.resolvedEpisodes, 1); assert.equal(r.escalatedEpisodes, 1);
});
test('pending deletes are not successful deletes, and duplicate message events count once', () => {
  const r = summarizePulseModeration([row(1, { action: 'DELETE_PENDING' }), row(2, { action: 'DELETE', messageId: 2 }), row(3, { action: 'DELETE', messageId: 2 })]);
  assert.equal(r.blockedMessages, 1); assert.equal(r.pendingDeletions, 1);
});
test('sanctioned responses are not soft; reclassification does not undo an executed deletion', () => {
  const r = summarizePulseModeration([row(1, { eventType: 'AI_INTERVENTION', action: 'RESPOND_WARN' }), row(2, { eventType: 'AI_INTERVENTION', action: 'RESPOND' }), row(3, { action: 'DELETE', invalid: true })]);
  assert.equal(r.interventions, 1); assert.equal(r.sanctionedResponses, 1); assert.equal(r.blockedMessages, 1);
});
test('historical action labels alone do not prove successful deletion', () => {
  const event = { id: 'e', communityId: 'c', telegramUpdateId: 'u', telegramMessageId: 1, tgUserId: '1', eventType: 'CONTENT_FILTER_TRIGGERED', action: 'DELETE', decision: null, status: 'PROCESSED', metadata: {}, feedback: null, reversedAt: null, createdAt: new Date() };
  const old = summarizePulseModeration([{ id: event.id, occurredAt: event.createdAt, facts: pulseModerationFacts(event) }]);
  assert.equal(old.blockedMessages, 0); assert.equal(old.unconfirmedDeletions, 1);
  assert.match(pulseModerationFacts({ ...event, metadata: { deletePending: true } }).action, /DELETE_PENDING/);
  assert.equal(pulseModerationFacts({ ...event, metadata: { deletePending: false } }).action, 'DELETE');
});
