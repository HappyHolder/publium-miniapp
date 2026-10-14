import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPulseHistory, type HistoryParticipantDay, type HistoryStatDay } from './pulseHistoryPreview';
import { calculatePulseWindow, DAY, pulseDays, pulseStart, type PulseScoringInput } from './pulseScoring';

function fixture() {
  const days = pulseDays('2026-09-01','2026-10-13');
  const facts: HistoryParticipantDay[] = days.flatMap((day,i) => Array.from({length:6},(_,u)=>({day,tgUserId:String((u+i)%10),messages:u+1,replies:0,estimated:false})));
  const stats: HistoryStatDay[] = days.map(day=>({day,messages:21,activeUsers:6,memberCount:100,joins:0,leaves:0,newSpeakers:0,toxicityWeight:0}));
  return {from:'2026-09-14',to:'2026-10-13',facts,stats};
}
test('historical A/K match event-based v2 arithmetic without inventing the other axes',()=>{
  const f=fixture(); let id=0;
  const input: PulseScoringInput = {from:f.from,to:f.to,excludedIds:[],memberships:[],assessments:[],snapshots:f.stats,
    coverage:f.stats.map(s=>({day:s.day,healthy:true,membership:true,firstAt:new Date(pulseStart(s.day)),lastAt:new Date(pulseStart(s.day)+DAY),maxGapMs:0})),
    messages:f.facts.flatMap(r=>Array.from({length:r.messages},()=>({telegramMessageId:++id,tgUserId:r.tgUserId,sentAt:new Date(pulseStart(r.day)+3600000),isReply:false,replyToMessageId:null,replyToUserId:null,replyToBot:false}))),
  };
  const a=previewPulseHistory(f),b=calculatePulseWindow(input);
  assert.ok(Math.abs(a.historical.axes.activity!-b.axes.activity!)<1e-9);
  assert.ok(Math.abs(a.historical.axes.core!-b.axes.core!)<1e-9);
  assert.equal(a.historical.score,null);
  for(const key of ['engagement','climate','growth'] as const) assert.equal(a.historical.axes[key],null);
});
test('a missing day cannot be filled with zero or dropped to improve the score',()=>{
  const f=fixture(); f.facts=f.facts.filter(r=>r.day!=='2026-10-05');f.stats=f.stats.filter(r=>r.day!=='2026-10-05');
  const r=previewPulseHistory(f).historical;
  assert.equal(r.axes.activity,null);assert.equal(r.axes.core,null);assert.deepEqual(r.missingRecordedDays,['2026-10-05']);
});
test('legacy empty rows do not prove quiet-day coverage',()=>{
  const f=fixture(); f.facts=f.facts.filter(r=>r.day!=='2026-10-05');f.stats.find(r=>r.day==='2026-10-05')!.messages=0;
  assert.equal(previewPulseHistory(f).historical.axes.activity,null);
});
test('missing population is not replaced by the latest snapshot',()=>{
  const f=fixture();f.stats.find(r=>r.day===f.from)!.memberCount=null;
  assert.equal(previewPulseHistory(f).historical.axes.activity,null);
});
test('missing prior history blocks core but preserves recoverable activity',()=>{
  const f=fixture();f.facts=f.facts.filter(r=>r.day!=='2026-09-01');
  const r=previewPulseHistory(f).historical;
  assert.notEqual(r.axes.activity,null);assert.equal(r.axes.core,null);
});
test('counter mismatch and estimated seed data stay diagnostic gaps',()=>{
  const f=fixture();f.facts[100]!.estimated=true;
  assert.equal(previewPulseHistory(f).historical.axes.activity,null);
  f.facts[100]!.estimated=false;f.facts[100]!.messages++;
  assert.equal(previewPulseHistory(f).historical.axes.activity,null);
});
test('duplicate participant-days are rejected, and no participant identifiers escape',()=>{
  const f=fixture();f.facts[0]!.tgUserId='private-identity';
  assert.equal(JSON.stringify(previewPulseHistory(f)).includes('private-identity'),false);
  f.facts.push({...f.facts[0]!});assert.throws(()=>previewPulseHistory(f),/Duplicate/);
});
