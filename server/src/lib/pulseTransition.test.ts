import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prisma } from '../db';
import { computePulse } from './communityPulseMetrics';
import { computeCompatiblePulse } from './pulseTransition';
import { DAY, pulseDays, pulseKey, pulseStart } from './pulseScoring';

test('migration preserves the entire historical report while evaluating v2 independently',async t=>{
  const now=new Date('2026-10-14T10:00:00+03:00'),days=pulseDays('2026-07-01','2026-10-14');
  let id=0;
  const facts=days.flatMap(day=>Array.from({length:16},(_,i)=>({day,tgUserId:String(i+1),messages:1,replies:1,estimated:false})));
  const stats=days.map(day=>({day,messages:16,activeUsers:16,replies:16,joins:1,leaves:0,newSpeakers:1,memberCount:1000,
    memberCountAt:null,blockedMsgs:1,culturalRewrites:0,interventions:1,conflictEvents:0,harassmentEvents:0,toxicityWeight:1,affectedUsers:1,resolvedEpisodes:0,escalatedEpisodes:0,hourHistogram:Array(24).fill(1)}));
  const messages=facts.map(f=>({telegramMessageId:++id,tgUserId:f.tgUserId,sentAt:new Date(pulseStart(f.day)+3600000),isReply:true,replyToUserId:String(Number(f.tgUserId)%2?Number(f.tgUserId)+1:Number(f.tgUserId)-1),replyToBot:false,replyToMessageId:null,actorKind:'HUMAN'}));
  const coverage=days.map(day=>({day,healthy:true,membership:true,firstAt:new Date(pulseStart(day)),lastAt:new Date(pulseStart(day)+DAY),maxGapMs:0}));
  const assessments=[{analysisKey:'all',assessedAt:now,messageIds:messages.map(m=>m.telegramMessageId),evidenceIds:[],targetIds:[],categories:['conflict','toxicity','harassment','threat'],category:'none',severity:'low',confidence:1}];
  let collect=false,fail=false;
  const restore: (()=>void)[]=[];
  const mock=(object:object,key:string,value:unknown)=>{const target=object as Record<string,unknown>,old=target[key];target[key]=value;restore.push(()=>{target[key]=old});};
  t.after(()=>restore.reverse().forEach(fn=>fn()));
  type Query={where?:{day?:{gte?:string;lte?:string}}};
  const within=<T extends {day:string}>(rows:T[],q:Query)=>rows.filter(r=>(!q.where?.day?.gte||r.day>=q.where.day.gte)&&(!q.where?.day?.lte||r.day<=q.where.day.lte));
  mock(prisma,'$transaction',async(fn:(tx:typeof prisma)=>unknown)=>{if(fail)throw Error('Preview unavailable');return fn(prisma)});
  mock(prisma,'$executeRawUnsafe',async(sql:string)=>{assert.equal(sql,'SET TRANSACTION READ ONLY');return 0});
  mock(prisma.communityDailyParticipant,'findMany',async(q:Query)=>within(facts,q));
  mock(prisma.communityDailyParticipant,'findFirst',async()=>({day:facts[0]!.day}));
  mock(prisma.communityDailyParticipant,'groupBy',async(q:Query)=>{
    const users=new Map<string,{tgUserId:string;_sum:{messages:number;replies:number};_count:{_all:number}}>();
    for(const f of within(facts,q)){const u=users.get(f.tgUserId)??{tgUserId:f.tgUserId,_sum:{messages:0,replies:0},_count:{_all:0}};u._sum.messages+=f.messages;u._sum.replies+=f.replies;u._count._all++;users.set(f.tgUserId,u)}
    return [...users.values()];
  });
  mock(prisma.communityDailyStat,'findMany',async(q:Query)=>within(stats,q));
  mock(prisma.pulseMessage,'findMany',async()=>collect?messages:[]);
  mock(prisma.pulseCoverage,'findMany',async()=>collect?coverage:[]);
  mock(prisma.pulseAssessment,'findMany',async()=>collect?assessments:[]);
  for(const delegate of [prisma.pulseMembership,prisma.moderationEvent,prisma.pulseModerationRecord,prisma.persona,prisma.moderatorParticipantRisk,prisma.communityPulseParticipant])mock(delegate,'findMany',async()=>[]);
  mock(prisma.communityMember,'findMany',async()=>[{tgUserId:'1',joinedAt:new Date('2026-09-20T12:00:00Z')}]);
  for(const n of [7,30,90,365]){
    const old=await computePulse('test',n,now),{transition,...compatible}=await computeCompatiblePulse('test',n,now);
    assert.deepEqual(compatible,old,`all legacy data survives for ${n} days`);
    assert.equal(transition.status,'ready');if(transition.status!=='ready')throw Error('expected ready');
    assert.equal(transition.model.score,null);assert.equal(transition.primary,'legacy');
    assert.ok(transition.historical!.axes.activity!=null);assert.ok(transition.historical!.axes.core!=null);
    assert.equal(transition.period.to,'2026-10-13');assert.equal(compatible.period.to,'2026-10-14');
    assert.ok(compatible.heatmap.flat().some(n=>n>0));assert.equal(compatible.cohorts.length,1);
    if(n===365)assert.ok(transition.historical!.period.days<365);
    if(n===30&&process.env['PULSE_TRANSITION_FIXTURE_OUTPUT']){const output=process.env['PULSE_TRANSITION_FIXTURE_OUTPUT'];mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({...compatible,transition},null,2));}
  }
  collect=true;
  const complete=await computeCompatiblePulse('test',30,now);
  assert.equal(complete.transition.status,'ready');
  if(complete.transition.status!=='ready')throw Error('expected ready');
  assert.equal(complete.transition.model.status,'complete');assert.equal(typeof complete.transition.model.score,'number');
  assert.equal(complete.score,(await computePulse('test',30,now)).score,'new model never silently replaces primary score');
  fail=true;
  const fallback=await computeCompatiblePulse('test',30,now);
  assert.equal(fallback.transition.status,'unavailable');assert.equal(fallback.score,complete.score);
  assert.deepEqual(fallback.heatmap,complete.heatmap);
});
