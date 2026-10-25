import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BLOCKS, mergeAiModeratorSection, normalizeAllowedWords, parseBlocks, type AiModerationBlock } from './config';
import { buildConversationPrompt, canRespondToConversation, freshConversationEvidence, validateConversationDecision, conversationMention, type ConversationMessage } from './conversationPolicy';
import { verifiedProfanityTerms } from './profanityPolicy';
import { presentModerationEvent } from './eventPresentation';
import { sanctionTargets } from './sanctionTargets';
import { warningScope } from './warningEngine';

const ai = () => structuredClone(DEFAULT_BLOCKS.find(b => b.type === 'ai_moderation') as AiModerationBlock);
const settings = { ...ai().conversationAnalysis, enabled: true, reaction: 'respond' as const };
const now = new Date('2026-10-25T10:00:00Z');
const messages: ConversationMessage[] = [
  { telegramMessageId: 130190, tgUserId: '10', username: 'person_a', text: 'Давайте обсудим аргументы', sentAt: new Date(+now - 70_000) },
  { telegramMessageId: 130192, tgUserId: '20', username: 'person_b', text: 'Ты ничего не понимаешь, идиот', replyToUserId: '10', sentAt: new Date(+now - 20_000) },
  { telegramMessageId: 130235, tgUserId: '30', text: 'Смешно получилось', sentAt: now },
];
const verdict = (patch: Record<string, unknown> = {}) => ({ intervene: true, category: 'conflict', conduct: 'personal_attack', severity: 'medium', confidence: .97, state: 'ESCALATING', materialChange: true, reason: 'Личный выпад в адрес участника', summary: 'Перепалка', response: 'Прекратите личные выпады.', participantIds: ['10','20','30'], actorIds: ['20'], targetIds: ['10'], evidence: [{ messageId: 130192, actorId: '20', targetIds: ['10'], excerpt: 'идиот', speechAct: 'direct' }], ...patch });
const checked = () => validateConversationDecision(verdict(), messages, settings)!;

test('section publishing preserves the other AI section and derives the outer switch', () => {
  const base = ai(), next = ai(); next.messageModeration.enabled = true; next.messageModeration.allowedWords = ['хер']; next.conversationAnalysis.reaction = 'sanctions';
  const merged = mergeAiModeratorSection(base, next, 'messageModeration');
  assert.equal(merged.enabled, true); assert.deepEqual(merged.messageModeration.allowedWords, ['хер']);
  assert.deepEqual(merged.conversationAnalysis, base.conversationAnalysis);
  assert.equal(mergeAiModeratorSection(base,next,'conversationAnalysis').messageModeration.enabled, false);
});
test('legacy disabled shared sanctions do not become enabled conduct sanctions', () => {
  const block = ai(); delete (block.conversationAnalysis as Partial<typeof settings>).sanctions; block.conversationAnalysis.reaction = 'sanctions';
  const parsed = parseBlocks([block, { id: 'warn', type: 'warning_policy', enabled: false }])[0] as AiModerationBlock;
  assert.equal(parsed.conversationAnalysis.reaction, 'respond');
  assert.equal((parseBlocks([ai()])[0] as AiModerationBlock).conversationAnalysis.sanctions.banAfterWarnings, 0);
});
test('word list normalizes unicode, duplicates and ё without accepting regex wildcards', () => {
  assert.deepEqual(normalizeAllowedWords([' ХЕР;Херня', 'ёлки', 'елки', '*', 'two words']), ['хер','херня','елки','two words']);
});
test('allowed word cannot cause deletion even if the model returns a surrounding phrase', () => {
  assert.deepEqual(verifiedProfanityTerms('Да что за ХЕР в чате', ['ХЕР','за ХЕР в чате'], ['хер']), []);
});
test('allowlist is whole-word and does not disable actual mat elsewhere in a mixed message', () => {
  assert.deepEqual(verifiedProfanityTerms('хер, блять, херня', ['хер','блять','херня','вымышленное'], ['хер']), ['блять','херня']);
  assert.deepEqual(verifiedProfanityTerms('Вот ёлки!', ['ёлки'], ['елки']), []);
  assert.deepEqual(verifiedProfanityTerms('бл*ть!', ['бл*ть'], []), ['бл*ть']);
});
test('new author is never substituted for the actor in older evidence', () => {
  const d = checked(); assert.deepEqual(d.actorIds,['20']); assert.deepEqual(d.targetIds,['10']); assert.notEqual(d.actorIds[0],messages.at(-1)!.tgUserId);
});
test('unseen evidence, invented actors and invented victims cannot enter execution', () => {
  for (const proof of [
    { messageId: 888, actorId: '20', targetIds: ['10'], excerpt: 'идиот', speechAct: 'direct' },
    { messageId: 130192, actorId: '30', targetIds: ['10'], excerpt: 'идиот', speechAct: 'direct' },
    { messageId: 130192, actorId: '20', targetIds: ['999'], excerpt: 'идиот', speechAct: 'direct' },
    { messageId: 130192, actorId: '20', targetIds: ['10'], excerpt: 'выдуманная цитата', speechAct: 'direct' },
  ]) assert.equal(validateConversationDecision(verdict({ evidence: [proof] }), messages, settings), null);
});
test('quotations, illustrative insults, consensual banter and discussion are not direct evidence', () => {
  const proof = verdict().evidence[0]!;
  for (const speechAct of ['example','quotation','banter','discussion']) assert.equal(validateConversationDecision(verdict({ evidence: [{...proof,speechAct}] }), messages, settings), null);
});
test('bot-directed complaints do not become a personal conflict', () => {
  const botReply = messages.map(m => m.telegramMessageId === 130192 ? { ...m, replyToBot: true } : m);
  assert.equal(validateConversationDecision(verdict(),botReply,settings),null);
});
test('profanity or a coarse word alone cannot use the conflict execution category', () => {
  for (const patch of [{ category: 'profanity' }, { conduct: 'none' }]) assert.equal(validateConversationDecision(verdict(patch), messages, settings), null);
});
test('freshness rejects the 15 minute audit failure, reused evidence and replies far behind the chat', () => {
  assert.equal(freshConversationEvidence(checked(), messages, new Date(+now+15*60_000), [130192]).length,0);
  assert.equal(freshConversationEvidence(checked(), messages.map(m => ({ ...m,evidenceEventId:'old' })), now,[130192]).length,0);
  assert.equal(freshConversationEvidence(checked(), messages, now, [130235]).length,0);
  assert.equal(freshConversationEvidence(checked(), messages, now, [130192,130235]).length,1);
});
test('a fresh continuation can receive a notice without changing ESCALATING state', () => {
  assert.equal(canRespondToConversation(checked(), settings),true);
  assert.equal(canRespondToConversation({...checked(),materialChange:false},settings),false);
  assert.equal(canRespondToConversation(checked(),{...settings,reaction:'observe'}),false);
  assert.equal(canRespondToConversation({...checked(),state:'RESOLVED'},settings),false);
});
test('conduct prompt preserves independent policies and source IDs and timestamps', () => {
  const prompt=buildConversationPrompt({messages,settings,allowedWords:['хер'],channelContext:{},ownerFeedback:'',episodes:[],previousNotices:[],knowledge:''});
  assert.ok(prompt.includes('130192')); assert.ok(prompt.includes(messages[1]!.sentAt.toISOString())); assert.ok(prompt.includes('illustrative insult')); assert.ok(prompt.includes('ANOTHER independent filter'));
});
test('mentions use known Telegram identities and escape clickable display names', () => {
  assert.equal(conversationMention(messages[1]!), '<a href="tg://user?id=20"><b>@person_b</b></a>');
  assert.equal(conversationMention({ tgUserId:'20',displayName:'<b>Имя</b>' }), '<a href="tg://user?id=20"><b>&lt;b&gt;Имя&lt;/b&gt;</b></a>');
});
test('warning scopes never combine profanity with conduct or ordinary filters', () => {
  assert.equal(warningScope('AI'),'PROFANITY'); assert.equal(warningScope('AI_CONVERSATION'),'CONVERSATION'); assert.equal(warningScope('ANTISPAM'),'GENERAL');
});
const event = (patch: Record<string, unknown> = {}) => ({ id:'event',tgUserId:'30',eventType:'AI_INTERVENTION',decision:'conflict',action:'RESPOND',reason:'Личный выпад',status:'PROCESSED',confidence:.97,metadata:{scope:'CONVERSATION',actorIds:['20'],evidence:[{messageId:130192,tgUserId:'20',username:'person_b',text:messages[1]!.text}]},feedback:null,reversedAt:null,createdAt:now,...patch });
test('journal displays actual source and actor, never an innocent triggering message', () => {
  const dto=presentModerationEvent(event());
  assert.equal(dto.categoryLabel,'Личный конфликт'); assert.equal(dto.messages[0]!.text,messages[1]!.text); assert.equal(dto.messages[0]!.author.tgUserId,'20');
  assert.equal(dto.actors[0]!.username,'person_b'); assert.equal(dto.canReverse,false);
});
test('legacy journal never fabricates a missing original from suggestedRewrite', () => {
  const dto=presentModerationEvent(event({metadata:{suggestedRewrite:'Слова бота'}}));
  assert.deepEqual(dto.messages,[]); assert.equal(dto.suggestedRewrite,'Слова бота');
});
test('expired/unmute events do not expose an incorrect undo button', () => {
  const dto=presentModerationEvent(event({action:'UNMUTE',eventType:'SANCTION_EXPIRED',metadata:{}}));
  assert.equal(dto.canReverse,false); assert.deepEqual(sanctionTargets({tgUserId:'10',action:'UNMUTE',metadata:{}}),[]);
});
test('multi-person sanctions undo actual per-person actions', () => {
  assert.deepEqual(sanctionTargets(event({action:'RESPOND_MUTE',metadata:{sanctions:[{tgUserId:'20',action:'WARN'},{tgUserId:'10',action:'MUTE'}]}})),[{tgUserId:'20',action:'WARN'},{tgUserId:'10',action:'MUTE'}]);
});
