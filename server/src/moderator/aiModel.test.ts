import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../env';
import { terraStructured, terraText } from '../lib/assistantModel';
import { moderateProfanity } from './modelRouter';
import { moderatorCostMicros, moderatorTextModel } from './aiModel';

test('moderator override reaches both structured paths without changing ordinary AI calls', async () => {
  const previous = { key: env.OPENAI_API_KEY, chat: env.OPENAI_CHAT_MODEL, moderator: env.OPENAI_MODERATOR_MODEL, fetch: globalThis.fetch };
  Object.assign(env, { OPENAI_API_KEY: 'sk-fixture', OPENAI_CHAT_MODEL: 'gpt-5.6-terra', OPENAI_MODERATOR_MODEL: 'gpt-6.1-sol' });
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    const value = body.text.format?.name === 'telegram_profanity_decision'
      ? { violation: false, confidence: .99, reason: 'Нарушений нет', matchedTerms: [], safeToRepublish: true, suggestedRewrite: null } : { ok: true };
    return { ok: true, json: async () => ({ output_text: JSON.stringify(value), usage: { input_tokens: 100, output_tokens: 120, output_tokens_details: { reasoning_tokens: 80 } } }) };
  }) as typeof fetch;
  try {
    const decision = await moderateProfanity({ text: 'Доброе утро', customRule: '' });
    await terraStructured({ model: moderatorTextModel(), system: 's', prompt: 'p', effort: 'medium', schemaName: 'conduct', schema: { type: 'object' } });
    await terraText({ system: 's', prompt: 'ordinary assistant call' });
    assert.deepEqual(requests.map(r => r.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-5.6-terra']);
    assert.equal(requests[0]!.reasoning.effort, 'medium');
    assert.equal(requests[0]!.store, false);
    assert.equal(decision?.usage?.outputTokens, 120); // includes the 80 reasoning tokens
    assert.equal(env.OPENAI_CHAT_MODEL, 'gpt-5.6-terra');
  } finally { Object.assign(env, { OPENAI_API_KEY: previous.key, OPENAI_CHAT_MODEL: previous.chat, OPENAI_MODERATOR_MODEL: previous.moderator }); globalThis.fetch = previous.fetch; }
});

test('moderator cost estimate accounts for Sol output and cached input rates', () => {
  const previous = env.OPENAI_MODERATOR_MODEL;
  try {
    Object.assign(env, { OPENAI_MODERATOR_MODEL: 'gpt-6.1-sol' });
    assert.equal(moderatorCostMicros(1000, 200, 500), 3050);
    Object.assign(env, { OPENAI_MODERATOR_MODEL: 'gpt-5.6-terra' });
    assert.equal(moderatorCostMicros(1000, 200, 500), 3500);
  } finally { Object.assign(env, { OPENAI_MODERATOR_MODEL: previous }); }
});
