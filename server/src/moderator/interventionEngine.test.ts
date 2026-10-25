import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAnalyzeConversation } from './interventionEngine.js';

test('conversation analysis starts after the configured count of relevant messages', () => {
  assert.equal(shouldAnalyzeConversation({messageCount:3,messagesSinceAnalysis:3,isReply:false,hasActiveEpisode:false,minMessages:3}),true);
  assert.equal(shouldAnalyzeConversation({messageCount:2,messagesSinceAnalysis:2,isReply:false,hasActiveEpisode:false,minMessages:3}),false);
});

test('active episodes are analyzed adaptively without a global cooldown', () => {
  assert.equal(shouldAnalyzeConversation({messageCount:2,messagesSinceAnalysis:1,isReply:false,hasActiveEpisode:true}),true);
});

test('one isolated message cannot invent an ongoing conversation', () => {
  assert.equal(shouldAnalyzeConversation({messageCount:1,messagesSinceAnalysis:1,isReply:true,hasActiveEpisode:true}),false);
});
