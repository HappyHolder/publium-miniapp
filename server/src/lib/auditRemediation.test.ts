import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedRequestUrl, isPrivateIp } from './ssrfGuard';
import { publicFetch } from './publicFetch';
import { storagePath } from './storage';
import { prisma } from '../db';
import { processCommunityManagerJobs } from '../communityManager/engine';
import { hydrateLinkedChannel } from '../communityManager/channelContext';
import { env } from '../env';

test('SSRF blocks normalized mapped IPv6, all link-local IPv6 and private literals', async () => {
  for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[fe90::1]', '[febf::1]', '[fd00::1]']) {
    assert.equal(await isBlockedRequestUrl(`http://${host}/`), true, host);
    await assert.rejects(publicFetch(`http://${host}/`), /Blocked/);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});

test('storage URLs must match our origin and cannot smuggle path fragments', () => {
  assert.equal(storagePath('https://foreign.example/uploads/shared.png'), null);
  assert.equal(storagePath('https://foreign.example/?x=/uploads/shared.png'), null);
  assert.equal(storagePath('a/../shared.png'), null);
  assert.equal(storagePath(`${env.PUBLIC_BASE_URL}/uploads/test.png`), 'test.png');
});

test('Community Manager recovers after the first lease-recovery query fails', async t => {
  let calls = 0;
  const update = prisma.communityManagerJob.updateMany, find = prisma.communityManagerJob.findFirst;
  t.after(() => { prisma.communityManagerJob.updateMany = update; prisma.communityManagerJob.findFirst = find; });
  prisma.communityManagerJob.updateMany = (async () => { if (++calls === 1) throw new Error('temporary DB outage'); return { count: 0 }; }) as typeof update;
  prisma.communityManagerJob.findFirst = (async () => null) as typeof find;
  await assert.rejects(processCommunityManagerJobs(), /temporary DB outage/);
  await processCommunityManagerJobs();
  assert.equal(calls, 2);
});

test('unlinking an independent chat removes legacy channel context', async t => {
  const find = prisma.channelChatLink.findFirst;
  t.after(() => { prisma.channelChatLink.findFirst = find; });
  prisma.channelChatLink.findFirst = (async () => null) as typeof find;
  const community = { chatId: 'chat', channelId: 'old', channel: { id: 'old' } };
  await hydrateLinkedChannel(community);
  assert.equal(community.channel, null);
  assert.equal(community.channelId, null);
});
