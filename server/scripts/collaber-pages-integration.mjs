import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';

if(!new URL(process.env.DATABASE_URL??'').pathname.startsWith('/publium_audit_'))throw Error('Pagination integration requires an isolated publium_audit_* database');
const require=createRequire(import.meta.url),{prisma}=require('../dist/db.js'),{env}=require('../dist/env.js');
const {DEFAULT_CM_CONFIG}=require('../dist/communityManager/config.js');
const ai=require('../dist/communityManager/collaber/inference.js'),telegram=require('../dist/lib/telegramBot.js');
const {createMatch,profilePreference}=require('../dist/communityManager/collaber/service.js');
const {deliverMatch}=require('../dist/communityManager/collaber/delivery.js');
const {navigateMatch,continueMatchInPrivate,recoverMatchPages}=require('../dist/communityManager/collaber/pages.js');
const {acceptCollaberUpdate,processTelegramTask,continuationPayload}=require('../dist/communityManager/collaber/telegram.js');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Unexpected external request')};
env.COMMUNITY_MANAGER_BOT_TOKEN='100:fixture';env.COMMUNITY_MANAGER_BOT_USERNAME='fixture_bot';
let user,community,moderatorChat,manager,chatId,serial=10000,rankCalls=0,editFail='',faultAfterDispatch=false,commitFault=false,emptyRanks=0,onlyIds=null;
const tag=randomUUID(),sends=[],edits=[],answers=[],left=new Set(),names=new Map();
const evidence='Занимаюсь продвижением Telegram Mini Apps и предлагаю маркетинг.';
const read=async r=>prisma.collaberRequest.findUniqueOrThrow({where:{id:r.id??r}});
const exposureCount=async r=>prisma.collaberExposure.count({where:{requestId:r.id??r}});
const activeIds=r=>r.candidates.map(c=>c.id);
telegram.getChatMember=async(_chat,uid)=>({status:Number(uid)===100?'administrator':left.has(String(uid))?'left':'member',user:{id:Number(uid),first_name:'Участник '+uid,username:names.get(String(uid))??'fixture_'+uid}});
telegram.sendRichMessage=async(chat,html,_token,keyboard,replyId)=>{const messageId=++serial;sends.push({chat:String(chat),html,keyboard,replyId,messageId});if(faultAfterDispatch)commitFault=true;return {chatId:Number(chat),messageId}};
telegram.sendBotMessage=async(chat,text,_token,keyboard)=>{const messageId=++serial;sends.push({chat:String(chat),text,keyboard,messageId});return {chatId:Number(chat),messageId}};
telegram.telegramAction=async(method,payload)=>{
 if(method==='answerCallbackQuery'){answers.push(payload);return}
 assert.equal(method,'editMessageText');edits.push(payload);
 if(editFail==='known')throw new telegram.TelegramApiError('Bad Request: fixture edit rejected',400);
 if(editFail==='network')throw Error('Simulated connection loss');
 if(faultAfterDispatch)commitFault=true;
};
telegram.answerBotCallback=async(id,text)=>answers.push({id,text});
ai.collaberJson=async(_manager,_stage,{system,prompt})=>{
 const input=JSON.parse(prompt);
 if(system.startsWith('Given'))return {keywords:['маркетинг','продвижение']};
 assert.ok(system.startsWith('Rank'));rankCalls++;
 const empty=emptyRanks-->0;
 return {decisions:input.candidates.map(c=>({id:c.id,role:'provider',fit:empty||onlyIds&&!onlyIds.has(c.id)?'none':'direct',matchQuality:'exact',reasonCode:empty||onlyIds&&!onlyIds.has(c.id)?'unrelated':'relevant_capability',evidence:empty||onlyIds&&!onlyIds.has(c.id)?'':c.facts[0].text}))};
};
async function provider(uid){
 const participant=await prisma.communityManagerParticipant.create({data:{communityManagerId:manager.id,tgUserId:String(uid),displayName:'Маркетолог '+uid,username:'fixture_'+uid}});
 return prisma.collaberProfile.create({data:{communityManagerId:manager.id,participantId:participant.id,tgUserId:String(uid),publicMentions:true,membership:'MEMBER',sourceText:evidence,sourceMessageId:Number(uid),sourceAt:new Date(),facts:[{kind:'offer',value:evidence,evidence,at:new Date().toISOString(),expiresAt:null,sourceMessageId:String(uid),sourceChatId:chatId}]}});
}
async function search(owner='4000',query='Ищу маркетолога'){
 return createMatch({managerId:manager.id,userId:owner,chatId,query,dedupeKey:'pages:'+tag+':'+randomUUID()});
}
async function next(r,owner){const view=await read(r);await navigateMatch(manager.id,view.id,owner??view.tgUserId,view.chatId,view.telegramMessageId,view.pageVersion,'next');return read(view)}
try{
 user=await prisma.user.create({data:{telegramId:String(Date.now()),subscription:{create:{tier:'STARTER',expiresAt:new Date(Date.now()+86400000),quotaResetAt:new Date(Date.now()+86400000)}}}});
 const chat=await prisma.chat.create({data:{userId:user.id,tgChatId:'-100'+Date.now(),title:'Pagination fixture'}});chatId=chat.tgChatId;
 moderatorChat=await prisma.moderatorChat.create({data:{tgChatId:chatId,title:chat.title,type:'supergroup',botStatus:'administrator'}});
 community=await prisma.community.create({data:{chatId:chat.id,moderatorChatId:moderatorChat.id}});
 const config=structuredClone(DEFAULT_CM_CONFIG);config.features.collaber.enabled=true;config.features.collaber.initiatives='off';config.features.collaber.periodicDays=0;config.features.collaber.imageUrl='https://example.com/cover.png';config.limits.quietEnabled=false;config.limits.maxRepliesPerHour=500;config.limits.maxRepliesPerDay=500;
 manager=await prisma.communityManager.create({data:{communityId:community.id,enabled:true,publishedVersion:1,configs:{create:{version:1,status:'PUBLISHED',config}}}});
 const providers=await Promise.all(Array.from({length:25},(_,i)=>provider(1000+i)));
 const first=await search(),second=await search('4001');assert.equal(first.candidatePool.length,25);assert.equal(await exposureCount(first),0);
 await Promise.all([deliverMatch(first.id,manager.id),deliverMatch(first.id,manager.id)]);
 let view=await read(first);assert.equal(sends.length,1);assert.equal(view.candidates.length,5);assert.equal(await exposureCount(first),5);
 assert.ok(sends[0].html.includes('cover.png'));assert.ok(sends[0].keyboard.inline_keyboard.slice(0,5).every(row=>row.length===2));
 await deliverMatch(second.id,manager.id);const secondView=await read(second);
 assert.ok(activeIds(secondView).every(id=>!activeIds(view).includes(id)),'Comparable less-exposed candidates get their turn');
 const callsBeforePages=rankCalls;const shown=[...activeIds(view)];
 for(let i=1;i<5;i++){view=await next(first);assert.equal(view.candidates.length,5);shown.push(...activeIds(view))}
 assert.equal(new Set(shown).size,25);assert.equal(await exposureCount(first),25);assert.equal(rankCalls,callsBeforePages);
 assert.equal(view.pages.length,5);assert.ok(!edits.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.text==='Показать ещё'));
 const beforeBack=await exposureCount(first);await navigateMatch(manager.id,view.id,view.tgUserId,chatId,view.telegramMessageId,view.pageVersion,'back');view=await read(first);assert.equal(view.pageIndex,3);assert.equal(await exposureCount(first),beforeBack);
 await next(first);assert.equal(await exposureCount(first),beforeBack);
 const concurrent=await read(second);const oldVersion=concurrent.pageVersion,editsBefore=edits.length;
 await Promise.all([navigateMatch(manager.id,second.id,'4001',chatId,concurrent.telegramMessageId,oldVersion,'next'),navigateMatch(manager.id,second.id,'4001',chatId,concurrent.telegramMessageId,oldVersion,'next')]);
 assert.equal((await read(second)).pageIndex,1);assert.equal(edits.length,editsBefore+1);
 await navigateMatch(manager.id,second.id,'4001',chatId,concurrent.telegramMessageId,oldVersion,'next');assert.equal(edits.length,editsBefore+1);
 console.log('PASS 25 candidates in five pages, stable cached ranking, paired buttons, fair first pages, back navigation and double-click protection');

 onlyIds=new Set([providers.at(-1).id]);const single=await search('4010');onlyIds=null;await deliverMatch(single.id,manager.id);assert.equal((await read(single)).candidates.length,1);assert.equal(await exposureCount(single),1);
 onlyIds=new Set();const empty=await search('4011');onlyIds=null;await deliverMatch(empty.id,manager.id);assert.equal((await read(empty)).candidates.length,0);assert.equal((await read(empty)).poolExhausted,true);assert.equal(await exposureCount(empty),0);
 console.log('PASS one or zero matches never force-fill a page');


 const shared=await search('4002');await deliverMatch(shared.id,manager.id);let group=await read(shared);const familyIds=[...activeIds(group)],callsBeforePrivate=rankCalls;
 const ownStart={update_id:987600,message:{message_id:1,chat:{id:4002,type:'private'},from:{id:4002,first_name:'Fixture'},text:'/start '+continuationPayload(shared.id)}};
 assert.equal(await acceptCollaberUpdate(ownStart,{type:'SHARED',botId:100}),true);
 await processTelegramTask(await prisma.collaberTask.findUniqueOrThrow({where:{dedupeKey:'telegram:100:987600'}}));
 const child=await prisma.collaberRequest.findUniqueOrThrow({where:{dedupeKey:'private-view:'+shared.id}});let personal=await read(child);
 assert.equal(personal.chatId,'4002');assert.equal(personal.query,group.query);assert.equal(personal.originRequestId,shared.id);assert.ok(activeIds(personal).every(id=>!familyIds.includes(id)));familyIds.push(...activeIds(personal));
 const beforeReopen=sends.length;await continueMatchInPrivate(manager.id,shared.id,'4002','100');assert.equal(sends.length,beforeReopen);
 group=await next(shared);assert.ok(activeIds(group).every(id=>!familyIds.includes(id)));familyIds.push(...activeIds(group));
 personal=await next(child);assert.ok(activeIds(personal).every(id=>!familyIds.includes(id)));familyIds.push(...activeIds(personal));
 group=await next(shared);assert.ok(activeIds(group).every(id=>!familyIds.includes(id)));familyIds.push(...activeIds(group));
 assert.equal(new Set(familyIds).size,25);assert.equal(rankCalls,callsBeforePrivate);assert.equal((await read(shared)).seenIds.length,25);
 assert.equal(await exposureCount(shared),15);assert.equal(await exposureCount(child),10);assert.equal(await prisma.collaberExposure.count({where:{requestId:child.id,public:true}}),0);
 console.log('PASS group/private continuation shares the query and viewed candidates without sending duplicates or consuming public exposure counts');

 const current=await read(second),beforeForeign=edits.length,queued=await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'TELEGRAM'}});
 const foreign={update_id:987654,callback_query:{id:'foreign',from:{id:4999},data:'cb:more:'+second.id+':'+current.pageVersion,message:{message_id:current.telegramMessageId,chat:{id:Number(chatId),type:'supergroup'}}}};
 await acceptCollaberUpdate(foreign,{type:'SHARED',botId:100});assert.match(answers.at(-1).text,/автора/);assert.equal(await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'TELEGRAM'}}),queued);
 await navigateMatch(manager.id,second.id,'4999',chatId,current.telegramMessageId,current.pageVersion,'next');
 await navigateMatch(manager.id,second.id,'4001','-100999',current.telegramMessageId,current.pageVersion,'next');assert.equal(edits.length,beforeForeign);
 const wrongStart={update_id:987655,message:{message_id:1,chat:{id:4999,type:'private'},from:{id:4999},text:'/start '+continuationPayload(second.id)}};
 await acceptCollaberUpdate(wrongStart,{type:'SHARED',botId:100});assert.equal(await prisma.collaberRequest.count({where:{originRequestId:second.id}}),0);
 console.log('PASS foreign clicks, chats and private deep links cannot take over another user search');

 await prisma.communityManager.update({where:{id:manager.id},data:{enabled:false}});await assert.rejects(next(second));assert.equal(edits.length,beforeForeign);await prisma.communityManager.update({where:{id:manager.id},data:{enabled:true}});
 await prisma.collaberRequest.update({where:{id:second.id},data:{deliveryBotId:'other-bot'}});await assert.rejects(next(second));await prisma.collaberRequest.update({where:{id:second.id},data:{deliveryBotId:'100'}});
 const oldCreatedAt=(await read(shared)).createdAt;await prisma.collaberRequest.update({where:{id:shared.id},data:{createdAt:new Date(Date.now()-8*86400000)}});await assert.rejects(next(child));await prisma.collaberRequest.update({where:{id:shared.id},data:{createdAt:oldCreatedAt}});
 assert.equal(edits.length,beforeForeign);console.log('PASS pause, changed bot and expired source search prevent further page delivery');


 const guarded=await search('4003');await deliverMatch(guarded.id,manager.id);const guardedView=await read(guarded);
 const unseen=guardedView.candidatePool.filter(c=>!guardedView.seenIds.includes(c.id)).slice(0,4);
 await profilePreference(manager.id,unseen[0].tgUserId,'hide');
 await prisma.collaberProfile.update({where:{id:unseen[1].id},data:{publicMentions:false}});left.add(unseen[2].tgUserId);
 await prisma.collaberProfile.update({where:{id:unseen[3].id},data:{sourceText:evidence+' Изменено.'}});
 const guardedNext=await next(guarded);assert.equal(guardedNext.candidates.length,5);assert.ok(activeIds(guardedNext).every(id=>!unseen.some(c=>c.id===id)));
 for(const c of unseen)await prisma.collaberProfile.update({where:{id:c.id},data:{searchable:true,publicMentions:true,membership:'MEMBER',sourceText:evidence}});left.clear();
 console.log('PASS revoked visibility, hidden profiles, departed members and changed intros are skipped with reserve candidates');

 await Promise.all(Array.from({length:40},(_,i)=>provider(2000+i)));
 const large=await search('4004'),beforeLarge=rankCalls;assert.equal(large.poolExhausted,false);await deliverMatch(large.id,manager.id);let largeView=await read(large),largeIds=[...activeIds(largeView)];
 for(let i=0;i<20&&largeIds.length<65;i++){largeView=await next(large);largeIds.push(...activeIds(largeView))}
 assert.equal(largeIds.length,65);assert.equal(new Set(largeIds).size,65);assert.equal((await read(large)).poolExhausted,true);assert.equal(rankCalls-beforeLarge,2);
 emptyRanks=2;const partial=await search('4005');await deliverMatch(partial.id,manager.id);let partialView=await read(partial);assert.equal(partialView.candidates.length,0);assert.equal(partialView.poolExhausted,false);assert.match(partialView.response,/проверенной части/);
 partialView=await next(partial);assert.equal(partialView.candidates.length,5);
 console.log('PASS additional batches beyond 30, no false exhaustion, and no model calls for cached page changes');

 const known=await search('4006');await deliverMatch(known.id,manager.id);const knownBefore=await read(known),knownCount=await exposureCount(known);
 editFail='known';await assert.rejects(next(known));editFail='';assert.equal((await read(known)).status,'SENT');assert.equal((await read(known)).pageVersion,knownBefore.pageVersion);assert.equal(await exposureCount(known),knownCount);
 await next(known);assert.equal(await exposureCount(known),knownCount+5);
 const ambiguous=await search('4007');await deliverMatch(ambiguous.id,manager.id);editFail='network';await assert.rejects(next(ambiguous));editFail='';assert.equal((await read(ambiguous)).status,'UNCERTAIN');const editCount=edits.length;await next(ambiguous);assert.equal(edits.length,editCount);assert.equal(await exposureCount(ambiguous),5);
 console.log('PASS known edit failures are retryable and uncertain results never advance or blindly repeat a page');

 const receipt=await search('4008');const originalTransaction=prisma.$transaction.bind(prisma);const sendBeforeReceipt=sends.length;
 prisma.$transaction=async(...args)=>{if(commitFault&&typeof args[0]==='function'){commitFault=false;throw Error('Simulated page receipt storage failure')}return originalTransaction(...args)};
 faultAfterDispatch=true;await assert.rejects(deliverMatch(receipt.id,manager.id));faultAfterDispatch=false;prisma.$transaction=originalTransaction;
 assert.equal(sends.length,sendBeforeReceipt+1);await recoverMatchPages(manager.id);assert.equal((await read(receipt)).status,'SENT');assert.equal(await exposureCount(receipt),5);assert.equal(sends.length,sendBeforeReceipt+1);
 const editsBeforeRecovery=edits.length;
 prisma.$transaction=async(...args)=>{if(commitFault&&typeof args[0]==='function'){commitFault=false;throw Error('Simulated page receipt storage failure')}return originalTransaction(...args)};
 faultAfterDispatch=true;await assert.rejects(next(receipt));faultAfterDispatch=false;prisma.$transaction=originalTransaction;
 await recoverMatchPages(manager.id);assert.equal((await read(receipt)).pageIndex,1);assert.equal(await exposureCount(receipt),10);assert.equal(edits.length,editsBeforeRecovery+1);
 console.log('PASS confirmed sends and page edits recover from a database write failure without duplicate Telegram calls or exposure counts');

 const erased=providers.find(p=>p.id===first.candidatePool[0].id);
 await prisma.collaberRequest.update({where:{id:first.id},data:{candidatePool:[],pages:[],examinedIds:[],seenIds:[]}});
 await profilePreference(manager.id,erased.tgUserId,'forget');assert.equal((await read(first)).status,'CANCELLED','Exposure trace must retain erasure linkage even after a cache was cleared');
 assert.equal(await prisma.collaberExposure.count({where:{profileId:erased.id}}),0);
 const erasedSearch=await read(shared);assert.equal(erasedSearch.status,'CANCELLED');assert.deepEqual(erasedSearch.candidatePool,[]);assert.deepEqual(erasedSearch.pages,[]);assert.equal((await read(child)).status,'CANCELLED');
 const pageTasks=await prisma.collaberTask.findMany({where:{communityManagerId:manager.id,dedupeKey:{startsWith:'page-plan:'+shared.id+':'}}});
 for(const t of pageTasks)assert.deepEqual(t.payload,{});
 const pageActions=await prisma.communityManagerAction.findMany({where:{communityManagerId:manager.id,OR:[shared.id,...pageTasks.map(t=>t.id)].map(id=>({metadata:{path:['collaberKey'],equals:id}}))}});assert.ok(pageActions.length>0);assert.ok(pageActions.every(a=>a.response===null));
 console.log('PASS erasure clears cached pools, private views, page receipts and candidate exposure history');
}finally{
 if(community)await prisma.community.delete({where:{id:community.id}});
 if(moderatorChat)await prisma.moderatorChat.delete({where:{id:moderatorChat.id}});
 if(user)await prisma.user.delete({where:{id:user.id}});
 globalThis.fetch=originalFetch;await prisma.$disconnect();
}
