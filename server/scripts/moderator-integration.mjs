import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.startsWith('/publium_audit_')) throw Error('Requires an isolated local publium_audit_* database');
const require = createRequire(import.meta.url);
const { prisma } = require('../dist/db.js');
const { env } = require('../dist/env.js');
const telegram = require('../dist/lib/telegramBot.js');
const model = require('../dist/lib/assistantModel.js');
const { DEFAULT_BLOCKS } = require('../dist/moderator/config.js');
const { processIntervention, syncModeratorEntitlement, reserveModeratorAiCheck } = require('../dist/moderator/interventionEngine.js');
const { issueWarning, activeWarningCount } = require('../dist/moderator/warningEngine.js');
const { moderateProfanity } = require('../dist/moderator/modelRouter.js');
const { issueModeratorSession } = require('../dist/lib/moderatorSession.js');
const express = require('express');
const originalFetch = globalThis.fetch;
globalThis.fetch = (url,...args) => { if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,...args); throw Error('External network blocked in moderator test') };
env.MODERATOR_BOT_TOKEN='200:fixture'; env.MODERATOR_WEBHOOK_SECRET='test-secret';
const tag=randomUUID(),updateBase=Date.now()%1_000_000_000; let user,httpServer,seq=1000,chatSeq=Date.now();const chatIds=[];
const deliveries=[],deletions=[],restrictions=[],bans=[],unbans=[],roles=new Map();
let mode='conduct', modelCalls=0, selectedId=null, blockModel=null, noticeFails=false;
telegram.getChatMember=async(chat,id)=>({ status:Number(id)===200||String(id)===user?.telegramId?'administrator':roles.get(String(id))??'member',user:{id:Number(id),username:'person_'+id,first_name:'Участник '+id},can_delete_messages:true,can_restrict_members:true });
telegram.sendRichMessage=async(chat,text,token,keyboard,replyId)=>{if(noticeFails)throw Error('SIMULATED_DELIVERY_FAILURE');deliveries.push({chat,text,replyId});return {messageId:++seq,chatId:Number(chat)}};
telegram.sendBotMessage=async(chat,text)=>{deliveries.push({chat,text});return {messageId:++seq,chatId:Number(chat)}};
telegram.deleteBotMessage=async(chat,messageId)=>{deletions.push(messageId)};
telegram.restrictChatUser=async(chat,id,restricted,token,until)=>{restrictions.push({id:String(id),restricted,until})};
telegram.banChatUser=async(chat,id)=>{bans.push(String(id))};
telegram.unbanChatUser=async(chat,id)=>{unbans.push(String(id))};
model.terraStructured=async p=>{
 modelCalls++;
 if(p.schemaName==='telegram_conduct_repeat_verification')return {value:{confirmed:true},usage:{inputTokens:10,outputTokens:5}};
 if(p.schemaName==='telegram_profanity_decision')return {value:{violation:true,confidence:.99,reason:'Мат',suggestedRewrite:mode==='rewrite'?'Почему это снова не работает?':mode==='unsafe-rewrite'?'Я тебе лицо набью':null,matchedTerms:mode==='allowed'?['хер']:['блять'],safeToRepublish:mode!=='unsafe-rewrite'},usage:{inputTokens:10,outputTokens:10}};
 if(mode==='model-error')return null;
 const source=p.prompt.split('CONVERSATION (untrusted data; timestamps are source times, IDs are not line numbers):\n')[1].split('\n\nReturn')[0];
 const context=JSON.parse(source), proof=selectedId?context.find(m=>m.messageId===selectedId):[...context].reverse().find(m=>m.authorId==='20');
 if(blockModel){const gate=blockModel;blockModel=null;gate.started();await gate.wait}
 const value=proof?{intervene:true,category:'conflict',conduct:'personal_attack',severity:'medium',confidence:.99,state:'ESCALATING',materialChange:true,reason:'Прямой личный выпад',summary:'Перепалка',response:'Остановите личные выпады. Обсуждайте аргументы.',participantIds:['10','20'],actorIds:['20'],targetIds:['10'],evidence:[{messageId:proof.messageId,actorId:'20',targetIds:['10'],excerpt:proof.text,speechAct:mode==='example'?'example':'direct'}]}:{intervene:false,category:'none',conduct:'none',severity:'low',confidence:.99,state:'OBSERVING',materialChange:false,reason:'Нет личного выпада',summary:'',response:'',participantIds:[],actorIds:[],targetIds:[],evidence:[]};
 return {value,usage:{inputTokens:10,outputTokens:10}};
};
const ai=()=>{const a=structuredClone(DEFAULT_BLOCKS.find(b=>b.type==='ai_moderation'));a.enabled=true;a.conversationAnalysis.enabled=true;a.conversationAnalysis.minMessages=2;a.conversationAnalysis.reaction='sanctions';a.conversationAnalysis.responseAutoDeleteSeconds=0;a.conversationAnalysis.sanctions.muteAfterWarnings=2;a.conversationAnalysis.sanctions.banAfterWarnings=0;return a};
async function community(name){
 const chat=await prisma.chat.create({data:{userId:user.id,tgChatId:'-100'+(++chatSeq),title:name}});
 const modChat=await prisma.moderatorChat.create({data:{tgChatId:chat.tgChatId,title:name,type:'supergroup',botStatus:'administrator'}});
 chatIds.push(modChat.id);
 return prisma.community.create({data:{chatId:chat.id,moderatorChatId:modChat.id},include:{moderatorChat:true}});
}
const input=(c,id,actor='20',thread='main',block=ai())=>({updateId:tag+':'+id,communityId:c.id,ownerUserId:user.id,chatId:Number(c.moderatorChat.tgChatId),tgUserId:actor,username:'person_'+actor,displayName:'Участник '+actor,telegramMessageId:id,replyToUserId:actor==='20'?'10':undefined,replyToMessageId:actor==='20'?id-1:undefined,threadKey:thread,text:actor==='20'?'Ты ничего не понимаешь, идиот':'Обсудим аргументы',sentAt:new Date(),block,channelContext:{},token:'200:fixture'});
async function noticeBefore(c){
 const e=await prisma.moderationEvent.findFirstOrThrow({where:{communityId:c.id,eventType:'AI_INTERVENTION'},orderBy:{createdAt:'desc'}});
 await prisma.moderationEvent.update({where:{id:e.id},data:{metadata:{...e.metadata,notifiedAt:new Date(Date.now()-60_000).toISOString()}}});
}
try{
 user=await prisma.user.create({data:{telegramId:String(Date.now()),subscription:{create:{tier:'STARTER',expiresAt:new Date(Date.now()+86400000),quotaResetAt:new Date(Date.now()+86400000)}}}});
 const access=await syncModeratorEntitlement(user.id);
 await prisma.aiModeratorEntitlement.update({where:{id:access.id},data:{checksUsed:99,quotaResetAt:new Date(Date.now()-1000)}});
 await Promise.all([syncModeratorEntitlement(user.id),syncModeratorEntitlement(user.id)]);
 assert.equal((await prisma.aiModeratorEntitlement.findUniqueOrThrow({where:{id:access.id}})).checksUsed,0);
 await Promise.all([reserveModeratorAiCheck(user.id,10),reserveModeratorAiCheck(user.id,10)]);
 assert.equal((await prisma.aiModeratorEntitlement.findUniqueOrThrow({where:{id:access.id}})).checksUsed,2);
 console.log('PASS quota boundary reset and concurrent reservations');
 mode='allowed';assert.equal((await moderateProfanity({text:'Да что за хер',customRule:'',allowedWords:['хер']})).violation,false);
 mode='unsafe-rewrite';assert.equal((await moderateProfanity({text:'Я тебе лицо набью',customRule:'',checkRewriteSafety:true})).safeToRepublish,false);mode='conduct';
 const c=await community('Conduct integration');
 await prisma.moderationWarning.createMany({data:Array.from({length:6},(_,i)=>({communityId:c.id,tgUserId:'20',source:'AI',scope:'PROFANITY',reason:'Предыдущий мат '+i}))});
 await processIntervention(input(c,1,'10'));const first=await processIntervention(input(c,2));
 assert.equal(first.intervened,true);assert.equal(await activeWarningCount(c.id,'20','CONVERSATION'),0);assert.equal(restrictions.length,0);
 const firstEvent=await prisma.moderationEvent.findFirstOrThrow({where:{communityId:c.id,eventType:'AI_INTERVENTION'}});
 assert.equal(firstEvent.tgUserId,'20');assert.equal(firstEvent.telegramMessageId,2);assert.match(deliveries.at(-1).text,/@person_20/);assert.equal(deliveries.at(-1).replyId,2);
 const before=deliveries.length;selectedId=2;await processIntervention(input(c,3,'30'));assert.equal(deliveries.length,before);
 const repeatedAssessment=await prisma.pulseAssessment.findUniqueOrThrow({where:{communityId_analysisKey:{communityId:c.id,analysisKey:'intervention:'+tag+':3:3'}}});
 assert.deepEqual(repeatedAssessment.evidenceIds,[]);assert.deepEqual(repeatedAssessment.messageIds,[3]);
 assert.equal((await prisma.moderatorParticipantRisk.findUniqueOrThrow({where:{communityId_tgUserId:{communityId:c.id,tgUserId:'20'}}})).evidenceCount,1);
 selectedId=null;await noticeBefore(c);await processIntervention(input(c,4));assert.equal(await activeWarningCount(c.id,'20','CONVERSATION'),1);assert.equal(restrictions.length,0);
 await noticeBefore(c);await processIntervention(input(c,5));assert.equal(await activeWarningCount(c.id,'20','CONVERSATION'),2);assert.equal(restrictions.at(-1).id,'20');assert.equal(await activeWarningCount(c.id,'20','PROFANITY'),6);
 console.log('PASS targeted first notice, no reused proof, repeated ESCALATING, scoped warning ladder');
 const event=await prisma.moderationEvent.findFirstOrThrow({where:{communityId:c.id,action:'RESPOND_MUTE'}});
 const count=await activeWarningCount(c.id,'20','CONVERSATION');
 await issueWarning({communityId:c.id,chatId:1,tgUserId:'20',telegramMessageId:5,reason:'Повтор',source:'AI_CONVERSATION',eventId:event.id,policy:ai().conversationAnalysis.sanctions,token:'fixture'});
 assert.equal(await activeWarningCount(c.id,'20','CONVERSATION'),count);assert.equal(restrictions.length,1);
 await noticeBefore(c);roles.set('20','administrator');await processIntervention(input(c,6));assert.equal(await activeWarningCount(c.id,'20','CONVERSATION'),2);roles.delete('20');
 console.log('PASS idempotent warnings and live administrator protection');
 const quotes=await community('Examples');
 mode='example';const start=deliveries.length;await processIntervention(input(quotes,10,'10'));await processIntervention(input(quotes,11));assert.equal(deliveries.length,start);assert.equal(await prisma.moderatorConversationEpisode.count({where:{communityId:quotes.id}}),0);mode='conduct';
 const duplicate=await community('Duplicates');await processIntervention(input(duplicate,20,'10'));const dupeStart=deliveries.length;
 await Promise.all([processIntervention(input(duplicate,21)),processIntervention(input(duplicate,21))]);assert.equal(deliveries.length,dupeStart+1);
 console.log('PASS examples rejected and concurrent duplicate delivery causes one intervention');
 const topics=await community('Topics');await processIntervention(input(topics,30,'10'));
 let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);blockModel={started:entered,wait};
 const running=processIntervention(input(topics,31));await started;
 await processIntervention(input(topics,40,'10','topic:7'));await processIntervention(input(topics,41,'20','topic:7'));release();await running;
 assert.equal(await prisma.moderationEvent.count({where:{communityId:topics.id,eventType:'AI_INTERVENTION'}}),2);
 assert.equal(await prisma.moderatorConversationMessage.count({where:{communityId:topics.id,reviewedAt:null}}),0);
 console.log('PASS arrivals during inference drain across forum topics');
 const failed=await community('Failed delivery');noticeFails=true;await processIntervention(input(failed,50,'10'));await processIntervention(input(failed,51));noticeFails=false;
 assert.equal(await prisma.moderationWarning.count({where:{communityId:failed.id}}),0);
 const failEvent=await prisma.moderationEvent.findFirstOrThrow({where:{communityId:failed.id,action:'RESPOND_FAILED'}});assert.equal(failEvent.metadata.deliveryStatus,'FAILED');
 const stale=await processIntervention({...input(failed,52),sentAt:new Date(Date.now()-16*60_000)});assert.equal(stale.analyzed,false);
 console.log('PASS failed notices cannot justify sanctions; stale messages cannot reopen old conflicts');
 // Exercise real config/journal routes with real SQL and authenticated ownership.
 const moderator=await prisma.moderator.create({data:{communityId:c.id,enabled:true,status:'ACTIVE',draftVersion:2,publishedVersion:1,configs:{create:[{version:1,status:'PUBLISHED',blocks:DEFAULT_BLOCKS},{version:2,status:'DRAFT',blocks:DEFAULT_BLOCKS}]}}});
 const app=express();app.use(express.json());app.use('/api/moderator-config',require('../dist/routes/moderatorConfig.js').default);app.use('/api/moderator',require('../dist/routes/moderator.js').default);
 app.use((e,req,res,next)=>res.status(500).json({error:e.message}));
 httpServer=app.listen(0,'127.0.0.1');await new Promise(r=>httpServer.once('listening',r));
 const base='http://127.0.0.1:'+httpServer.address().port;
 const headers={Authorization:'Bearer '+issueModeratorSession(user.telegramId).token,'Content-Type':'application/json'};
 async function api(path,body,method=body?'POST':'GET'){const r=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d}
 const path='/api/moderator-config/'+moderator.id;
 await Promise.all([
  api(path+'/draft',{aiSection:'messageModeration',settings:{...ai().messageModeration,enabled:true,action:'delete_rewrite',allowedWords:['хер'],noticeText:'Пиши без мата.'}},'PATCH'),
  api(path+'/draft',{aiSection:'conversationAnalysis',settings:{...ai().conversationAnalysis,reaction:'sanctions'}},'PATCH')
 ]);
 await api(path+'/publish',{blockType:'ai_moderation',aiSection:'messageModeration'});
 const after=await api(path+'/draft'),pubAi=after.published.blocks.find(b=>b.type==='ai_moderation'),draftAi=after.draft.blocks.find(b=>b.type==='ai_moderation');
 assert.equal(pubAi.messageModeration.enabled,true);assert.equal(pubAi.conversationAnalysis.enabled,false);assert.equal(draftAi.conversationAnalysis.reaction,'sanctions');
 await api(path+'/publish',{blockType:'ai_moderation',aiSection:'conversationAnalysis'});
 const both=(await api(path+'/draft')).published.blocks.find(b=>b.type==='ai_moderation');assert.equal(both.messageModeration.action,'delete_rewrite');assert.equal(both.conversationAnalysis.reaction,'sanctions');
 const journal=await api('/api/moderator/communities/'+c.id+'/events?kind=conversation');assert.ok(journal.events.some(e=>e.messages.some(m=>m.author.username==='person_20'&&m.text.includes('идиот'))));
 await api('/api/moderator/communities/'+c.id+'/events/'+event.id+'/reverse',{});
 assert.equal(await activeWarningCount(c.id,'20','CONVERSATION'),1);assert.equal(await activeWarningCount(c.id,'20','PROFANITY'),6);assert.equal(restrictions.at(-1).restricted,false);
 // Reversing an older sanction must not remove a newer one.
 const old=await prisma.moderationEvent.create({data:{communityId:c.id,telegramUpdateId:tag+'old',tgUserId:'20',eventType:'MANUAL_COMMAND',action:'MUTE',status:'PROCESSED'}});
 await prisma.moderationEvent.create({data:{communityId:c.id,telegramUpdateId:tag+'new',tgUserId:'20',eventType:'MANUAL_COMMAND',action:'MUTE',status:'PROCESSED'}});
 const restoreStart=restrictions.length;await api('/api/moderator/communities/'+c.id+'/events/'+old.id+'/reverse',{});assert.equal(restrictions.length,restoreStart);
 console.log('PASS concurrent section saves, independent publication, readable journal, scoped undo, newer sanction protection');
 const webhookCommunity=await community('Profanity webhook');
 const profanityBlock=ai();profanityBlock.messageModeration={...profanityBlock.messageModeration,enabled:true,action:'delete_rewrite',allowedWords:['хер'],noticeText:'Пиши без мата.'};profanityBlock.conversationAnalysis.enabled=false;
 await prisma.moderator.create({data:{communityId:webhookCommunity.id,status:'ACTIVE',enabled:true,publishedVersion:1,draftVersion:2,configs:{create:{version:1,status:'PUBLISHED',blocks:[profanityBlock]}}}});
 const background=[];require('../dist/lib/webhookBackground.js').runWebhookBackgroundTask=(task)=>{background.push(task())};
 async function webhook(id,text){const response=await fetch(base+'/api/moderator/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':env.MODERATOR_WEBHOOK_SECRET},body:JSON.stringify({update_id:updateBase+id,message:{message_id:id,date:Math.floor(Date.now()/1000),chat:{id:Number(webhookCommunity.moderatorChat.tgChatId),type:'supergroup'},from:{id:20,first_name:'Миша',username:'person_20'},text}})});assert.equal(response.status,200);await Promise.all(background.splice(0));for(let i=0;i<100;i++){if(await prisma.pulseMessage.count({where:{communityId:webhookCommunity.id,telegramMessageId:id}}))return;await new Promise(r=>setTimeout(r,10))}throw Error('Pulse ingress did not finish')}
 mode='allowed';const deletionStart=deletions.length;await webhook(8001,'Что за хер');assert.equal(deletions.length,deletionStart);
 mode='rewrite';const messageStart=deliveries.length;await webhook(8002,'Блять, почему это снова не работает?');assert.ok(deletions.includes(8002));assert.equal(deliveries.length,messageStart+1);assert.equal(deliveries.at(-1).text,'@person_20, Пиши без мата.\n\n«Почему это снова не работает?»');
 assert.equal(await prisma.moderationWarning.count({where:{communityId:webhookCommunity.id}}),0);
 mode='unsafe-rewrite';await webhook(8003,'Блять, я тебе лицо набью');assert.equal(deliveries.at(-1).text,'@person_20, Пиши без мата.');
 const profanityJournal=await api('/api/moderator/communities/'+webhookCommunity.id+'/events?kind=profanity');assert.ok(profanityJournal.events.some(e=>e.messages.some(m=>m.text==='Блять, почему это снова не работает?'&&m.author.username==='person_20')));
 assert.equal(await prisma.pulseMessage.count({where:{communityId:webhookCommunity.id}}),3);
 const {rollupPulseDay,pulseDayKey}=require('../dist/lib/communityPulse.js');await rollupPulseDay(webhookCommunity.id,pulseDayKey());
 const day=await prisma.communityDailyStat.findUniqueOrThrow({where:{communityId_day:{communityId:webhookCommunity.id,day:pulseDayKey()}}});
 assert.equal(day.messages,3);assert.equal(day.blockedMsgs,2);assert.equal(day.conflictEvents,0);assert.equal(day.toxicityWeight,0);
 console.log('PASS actual webhook: allowlisted word, short editable notice, safe rewrite, no profanity sanctions, journal and Pulse ingress');mode='conduct';
 const stranger=await prisma.user.create({data:{telegramId:'9'+Date.now()}});
 const denied=await fetch(base+path+'/draft',{headers:{Authorization:'Bearer '+issueModeratorSession(stranger.telegramId).token}});assert.equal(denied.status,404);await prisma.user.delete({where:{id:stranger.id}});
 console.log('PASS community ownership; external network remained blocked');
} finally { await new Promise(r=>httpServer?httpServer.close(r):r());if(user)await prisma.user.delete({where:{id:user.id}});await prisma.moderatorChat.deleteMany({where:{id:{in:chatIds}}});await prisma.$disconnect();globalThis.fetch=originalFetch }
