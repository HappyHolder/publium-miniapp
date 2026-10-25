import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePulseParticipantIdentity, pulseClimateScore, pulseToxicityWeight } from './communityPulse.js';

test('deleted toxic messages lower climate without an intervention event', () => {
  const event = { eventType:'AI_MODERATION_TRIGGERED', action:'DELETE_REWRITE_NONE', decision:'insult', tgUserId:'1', metadata:{ category:'insult', severity:'medium', directed:true } };
  const weight = Array.from({length:8},()=>pulseToxicityWeight(event)).reduce((a,b)=>a+b,0);
  assert.ok(pulseClimateScore(16,weight) < 100);
});

test('harassment weighs more than ordinary spam', () => {
  const harassment = pulseToxicityWeight({ eventType:'AI_MODERATION_TRIGGERED', action:'DELETE', decision:'harassment', tgUserId:'1', metadata:{severity:'high'} });
  const spam = pulseToxicityWeight({ eventType:'AI_MODERATION_TRIGGERED', action:'DELETE', decision:'spam', tgUserId:'1', metadata:{severity:'medium'} });
  assert.ok(harassment > spam);
});

test('new profanity events do not masquerade as an interpersonal climate signal', () => {
  assert.equal(pulseToxicityWeight({ eventType:'AI_MODERATION_TRIGGERED',action:'DELETE_REWRITE_NONE',decision:'profanity',tgUserId:'1',metadata:{scope:'PROFANITY',severity:'medium'} }),0);
});

test('fresh conduct has the same climate weight before and after delivering a notice', () => {
  const event = { eventType:'CONVERSATION_EPISODE',action:'OBSERVE',decision:'conflict',tgUserId:'1',metadata:{scope:'CONVERSATION',severity:'medium',state:'ESCALATING',evidenceMessageIds:[1,1,2]} };
  const observed=pulseToxicityWeight(event), delivered=pulseToxicityWeight({...event,eventType:'AI_INTERVENTION',action:'RESPOND'});
  assert.equal(observed,2);assert.equal(delivered,observed);
  assert.equal(pulseToxicityWeight({...event,feedback:'FALSE_POSITIVE'}),0);
  assert.equal(pulseToxicityWeight({...event,reversedAt:new Date()}),0);
});

test('normalizes a Telegram participant identity for Pulse', () => {
  assert.deepEqual(normalizePulseParticipantIdentity({ username:' @stepan ', firstName:' Степан ', lastName:'  Иванов\n' }), {
    username:'stepan', displayName:'Степан Иванов',
  });
});

test('keeps a participant anonymous when Telegram exposes no public identity', () => {
  assert.deepEqual(normalizePulseParticipantIdentity(), { username:null, displayName:null });
});
