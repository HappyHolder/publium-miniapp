import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTonDeposit } from './tonVerification';

test('TON verification rejects aborted, bounced, emulated, foreign, expired, underpaid and reused transfers', async t => {
  const now = Math.floor(Date.now() / 1000);
  const sender = '0:' + 'a'.repeat(64);
  const valid = { now, hash: Buffer.alloc(32, 1).toString('base64'), description: { aborted: false }, in_msg: { source: sender, value: '20000000000', message_content: { decoded: { comment: 'publium:order' } } } };
  const wrongMessage = (patch: object) => ({ ...valid, in_msg: { ...valid.in_msg, ...patch } });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const query = new URL(String(url));
    assert.equal(query.searchParams.get('limit'), '1000');
    assert.equal(query.searchParams.get('end_utime'), String(now + 60));
    return new Response(JSON.stringify({ transactions: [
      { ...valid, description: { aborted: true } },
      { ...valid, description: undefined },
      { ...valid, emulated: true },
      wrongMessage({ bounced: true }),
      wrongMessage({ source: '0:' + 'b'.repeat(64) }),
      wrongMessage({ value: '1' }),
      wrongMessage({ message_content: { decoded: { comment: 'publium:other' } } }),
      { ...valid, now: now - 600 },
      { ...valid, now: now + 120 },
      { ...valid, hash: 'invalid' },
      valid,
      { ...valid, hash: Buffer.alloc(32, 2).toString('base64url') },
    ] }));
  });
  const checked: string[] = [];
  const result = await verifyTonDeposit({ expectedTon: 20, senderWallet: sender, receivingWallet: '0:' + 'c'.repeat(64), apiKey: 'test', expectedComment: 'publium:order', fromDate: new Date(now * 1000), untilDate: new Date((now + 60) * 1000), isHashUsed: async hash => { checked.push(hash); return hash === '01'.repeat(32); } });
  assert.equal(result.ok, true); assert.equal(result.txHash, '02'.repeat(32));
  assert.deepEqual(checked, ['01'.repeat(32), '02'.repeat(32)]);
});
