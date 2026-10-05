import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

if(!new URL(process.env.DATABASE_URL??'').pathname.startsWith('/publium_audit_'))throw new Error('Collaber integration requires an isolated publium_audit_* database');
const require=createRequire(import.meta.url);
const {prisma}=require('../dist/db.js');
const {env}=require('../dist/env.js');
const ai=require('../dist/communityManager/collaber/inference.js');
const telegram=require('../dist/lib/telegramBot.js');
const {DEFAULT_CM_CONFIG}=require('../dist/communityManager/config.js');
const {ingestIntro,findCandidates,createMatch,profilePreference,queueLiveIntro}=require('../dist/communityManager/collaber/service.js');
const {deliverMatch}=require('../dist/communityManager/collaber/delivery.js');
const {processCollaberJobs}=require('../dist/communityManager/collaber/worker.js');
const {processTelegramTask,acceptCollaberUpdate,entryPayload}=require('../dist/communityManager/collaber/telegram.js');
const {issueModeratorSession}=require('../dist/lib/moderatorSession.js');
const express=require('express');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,...args)=>{if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,...args);throw new Error('Unexpected network access in Collaber integration')};
env.COMMUNITY_MANAGER_BOT_TOKEN='100:test';env.COMMUNITY_MANAGER_BOT_USERNAME='fixture_bot';
let sends=0,ambiguous=false,noMatches=false;const deliveries=[];
env.MODERATOR_BOT_TOKEN='200:moderator-test';
telegram.getChatMember=async(chat,user,token)=>{
 if(token==='100:test'&&Number(user)!==100)throw new Error('Non-admin CM must not verify other users');
 return {status:Number(user)===200?'administrator':'member',user:{id:Number(user),first_name:'Участник '+user,username:'current_'+user}};
};
telegram.sendRichMessage=async(chat,html,token,keyboard,replyId)=>{sends++;deliveries.push({chat,html,keyboard,replyId});if(ambiguous)throw new Error('Simulated connection loss');return {chatId:Number(chat),messageId:900+sends}};
telegram.sendBotMessage=async(chat,text,token,keyboard,parseMode,replyId)=>{sends++;deliveries.push({chat,text,keyboard,replyId});if(ambiguous)throw new Error('Simulated connection loss');return {chatId:Number(chat),messageId:900+sends}};
ai.collaberJson=async(managerId,stage,{prompt,system})=>{
 const p=JSON.parse(prompt);
 if(system.startsWith('Extract'))return {facts:[{kind:'offer',value:p.message,evidence:p.message}],closedNeedsEvidence:null};
 if(system.startsWith('Given'))return{keywords:['маркетинг','продвижение']};
 if(system.startsWith('Rank'))return{ids:noMatches?[]:p.candidates.slice(0,3).map(x=>x.id)};
 throw new Error('Unexpected inference');
};
const tag=randomUUID();let user,community,other,moderatorChat,httpServer;
try{
 user=await prisma.user.create({data:{telegramId:String(Date.now()),subscription:{create:{tier:'STARTER',expiresAt:new Date(Date.now()+86400000),quotaResetAt:new Date(Date.now()+86400000)}}}});
 const chat=await prisma.chat.create({data:{tgChatId:'-100'+Date.now(),title:'Collaber integration',userId:user.id}});
 moderatorChat=await prisma.moderatorChat.create({data:{tgChatId:chat.tgChatId,title:chat.title,type:'supergroup',botStatus:'administrator'}});
 community=await prisma.community.create({data:{chatId:chat.id,moderatorChatId:moderatorChat.id}});
 other=await prisma.community.create({data:{}});
 const config=structuredClone(DEFAULT_CM_CONFIG);config.features.collaber.enabled=true;config.features.collaber.initiatives='off';config.limits.quietEnabled=false;config.limits.maxRepliesPerHour=100;config.limits.maxRepliesPerDay=100;
 const manager=await prisma.communityManager.create({data:{communityId:community.id,enabled:true,publishedVersion:1,draftVersion:1,configs:{create:{version:1,status:'PUBLISHED',config}}}});
 const foreign=await prisma.communityManager.create({data:{communityId:other.id}});
 const intro={id:'10',userId:'42',name:'Анна',username:'old_name',text:'Занимаюсь маркетингом и предлагаю продвижение приложений.',at:new Date().toISOString()};
 assert.equal(await ingestIntro(manager.id,intro,config.features.collaber),true);
 assert.equal(await ingestIntro(manager.id,intro,config.features.collaber),false);
 assert.equal(await prisma.collaberProfile.count({where:{communityManagerId:manager.id}}),1);
 assert.equal((await findCandidates(foreign.id,'маркетинг','43',config.features.collaber,false,false)).length,0);
 assert.equal((await findCandidates(manager.id,'маркетинг','43',config.features.collaber,true,false)).length,0);
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id},data:{publicMentions:true}});
 const found=await findCandidates(manager.id,'маркетинг','43',config.features.collaber,true,true);
 assert.equal(found.length,1);assert.equal(found[0].username,'current_42');
 console.log('PASS identity deduplication, community isolation, visibility, current Telegram username');

 const historic={...intro,id:'9',userId:'55',at:'2024-06-01T00:00:00.000Z'};
 assert.equal(await ingestIntro(manager.id,historic,config.features.collaber),true);
 const historicResult=(await findCandidates(manager.id,'маркетинг','43',config.features.collaber,false,false)).find(c=>c.tgUserId==='55');
 assert.ok(historicResult);assert.match(historicResult.reason,/Исторические сведения/);
 await profilePreference(manager.id,'55','hide');
 assert.ok(!(await findCandidates(manager.id,'маркетинг','43',config.features.collaber,false,false)).some(c=>c.tgUserId==='55'));
 console.log('PASS all-time matching retains historical offers with explicit confirmation and respects opt-out');

 const request=await createMatch({managerId:manager.id,userId:'43',chatId:chat.tgChatId,query:'маркетинг',dedupeKey:'match-'+tag});
 await Promise.all([deliverMatch(request.id,manager.id),deliverMatch(request.id,manager.id)]);
 assert.equal(sends,1);assert.equal((await prisma.collaberRequest.findUnique({where:{id:request.id}})).status,'SENT');
 assert.equal((await prisma.subscription.findUnique({where:{userId:user.id}})).communityManagerActionsUsed,1);
 console.log('PASS concurrent delivery is claimed once and charged once');

 ambiguous=true;
 const uncertain=await createMatch({managerId:manager.id,userId:'43',chatId:chat.tgChatId,query:'маркетинг',dedupeKey:'uncertain-'+tag});
 await assert.rejects(deliverMatch(uncertain.id,manager.id));assert.equal((await prisma.collaberRequest.findUnique({where:{id:uncertain.id}})).status,'UNCERTAIN');
 await deliverMatch(uncertain.id,manager.id);assert.equal(sends,2);ambiguous=false;
 console.log('PASS ambiguous dispatch is not retried');

 const archive=await prisma.collaberImport.create({data:{communityManagerId:manager.id,checksum:tag,filename:'fixture.json',total:1,status:'PENDING',messages:[{...intro,id:'11',userId:'44'}]}});
 await processCollaberJobs();
 const imported=await prisma.collaberImport.findUnique({where:{id:archive.id}});
 assert.equal(imported.status,'COMPLETED');assert.deepEqual(imported.messages,[]);assert.equal(imported.processed,1);assert.equal(sends,2);
 console.log('PASS background import builds profiles, clears source archive and sends no messages');

 const edited={...intro,text:'Занимаюсь дизайном и предлагаю оформление приложений.',at:new Date(Date.now()+1).toISOString()};
 assert.equal(await ingestIntro(manager.id,edited,config.features.collaber),true);
 const updated=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}});
 assert.equal(updated.facts.length,1);assert.equal(updated.facts[0].evidence,edited.text);
 console.log('PASS edited message replaces its obsolete facts');

 const app=express();app.use(express.json());app.use('/cm',require('../dist/routes/communityManager.js').default);
 httpServer=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const base='http://127.0.0.1:'+httpServer.address().port+'/cm/';
 const headers={Authorization:'Bearer '+issueModeratorSession(user.telegramId).token};
 assert.equal((await fetch(base+manager.id+'/collaber')).status,401);
 assert.equal((await fetch(base+foreign.id+'/collaber',{headers})).status,404);
 assert.equal((await fetch(base+manager.id+'/collaber',{headers})).status,200);
 const upload=async()=>{const form=new FormData();form.append('file',new Blob([JSON.stringify({chatId:chat.tgChatId,messages:[{id:66,userId:'66',name:'Test',text:intro.text,at:intro.at}]})],{type:'application/json'}),'history.json');const r=await fetch(base+manager.id+'/collaber/imports',{method:'POST',headers,body:form});assert.equal(r.status,200);return r.json()};
 const preview=await upload();assert.equal(preview.status,'PREVIEW');
 await fetch(base+manager.id+'/collaber/imports/'+preview.id+'/cancel',{method:'POST',headers});
 assert.equal((await upload()).status,'PREVIEW');
 await fetch(base+manager.id+'/collaber/imports/'+preview.id+'/cancel',{method:'POST',headers});
 assert.equal((await fetch(base+manager.id+'/collaber/profiles/foreign-profile',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:'{"forget":true}'})).status,400);
 console.log('PASS HTTP authorization, foreign community/profile rejection, upload preview and cancelled re-upload');

 const task=(uid,callback,text='')=>({id:'fixture-'+randomUUID(),communityManagerId:manager.id,payload:{userId:uid,botId:'100',text,name:'Участник '+uid,messageId:100,callback:callback?{data:callback,chatId:chat.tgChatId}:null}});
 const beforeForeign=sends;
 await processTelegramTask(task('99','cb:f:'+request.id+':0'));
 assert.equal(sends,beforeForeign);assert.equal((await prisma.collaberRequest.findUnique({where:{id:request.id}})).feedback,null);
 await processTelegramTask(task('43',null,'/start '+entryPayload(manager.id)));
 await processTelegramTask(task('42',null,'/start '+entryPayload(manager.id)));
 await processTelegramTask(task('43','cb:n:'+request.id+':0'));
 const invite=await prisma.collaberInvite.findFirst({where:{communityManagerId:manager.id,pairKey:'42:43'}});assert.equal(invite.status,'WAITING');
 await processTelegramTask(task('99','cb:yes:'+invite.id+':0'));
 assert.equal((await prisma.collaberInvite.findUnique({where:{id:invite.id}})).status,'WAITING');
 await processTelegramTask(task('42','cb:yes:'+invite.id+':0'));
 assert.equal((await prisma.collaberInvite.findUnique({where:{id:invite.id}})).status,'INTRODUCED');
 const afterAccept=sends;await processTelegramTask(task('42','cb:yes:'+invite.id+':0'));assert.equal(sends,afterAccept);
 const webhook={update_id:8675309,message:{message_id:99,chat:{type:'private',id:43},from:{id:43,first_name:'Tester'},text:'/start '+entryPayload(manager.id)}};
 await acceptCollaberUpdate(webhook,{type:'SHARED',botId:100});await acceptCollaberUpdate(webhook,{type:'SHARED',botId:100});
 assert.equal(await prisma.collaberTask.count({where:{communityManagerId:manager.id,dedupeKey:'telegram:100:8675309'}}),1);
 console.log('PASS callback ownership, two-party consent, repeated acceptance and webhook deduplication');


 // Group-first onboarding uses actual source message IDs and no private session.
 const saveConfig=()=>prisma.communityManagerConfig.update({where:{communityManagerId_version:{communityManagerId:manager.id,version:1}},data:{config}});
 config.features.collaber.initiatives='auto';config.features.collaber.periodicDays=0;config.features.collaber.maxInitiativesPerDay=5;
 config.features.collaber.imageUrl='https://example.com/cover.png';config.replies.conversationMemory=true;await saveConfig();
 await ingestIntro(manager.id,{...intro,id:'600',userId:'60',at:new Date().toISOString()},config.features.collaber);
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:'60'},data:{publicMentions:true}});
 await queueLiveIntro(manager.id,{message_id:700,from:{id:56,first_name:'Борис',username:'boris_test'},text:'#intro Меня зовут Борис. Разрабатываю мини-приложение и могу помочь с интеграциями.',date:Math.floor(Date.now()/1000)});
 for(let i=0;i<5&&!deliveries.some(d=>d.replyId===700);i++)await processCollaberJobs();
 const boris=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'56'}}});
 assert.ok(boris);assert.equal(boris.publicMentions,false);assert.equal(await prisma.collaberSession.count({where:{communityManagerId:manager.id,tgUserId:'56'}}),0);
 const prompt=deliveries.find(d=>d.replyId===700);assert.equal(prompt.chat,chat.tgChatId);assert.match(prompt.keyboard.inline_keyboard[0][0].callback_data,/^cp:/);
 const publicButton=prompt.keyboard.inline_keyboard[0][0].callback_data;
 const beforeStranger=sends;await processTelegramTask(task('99',publicButton));assert.equal(sends,beforeStranger);
 assert.equal((await prisma.collaberProfile.findUnique({where:{id:boris.id}})).publicMentions,false);
 await processTelegramTask(task('56',publicButton));const afterPublic=sends;
 await processTelegramTask(task('56',publicButton));assert.equal(sends,afterPublic);
 assert.equal((await prisma.collaberProfile.findUnique({where:{id:boris.id}})).publicMentions,true);
 console.log('PASS live group intro saves profile; author-only public consent works without starting a private bot session');

 // Quiet hours defer a reply; disabling periodic checks must not disable retries.
 const localHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:config.limits.timezone,hour:'numeric',hourCycle:'h23'}).format(new Date()));
 config.limits.quietEnabled=true;config.limits.quietFrom=localHour;config.limits.quietTo=(localHour+1)%24;await saveConfig();
 await processCollaberJobs();
 let proposal=await prisma.collaberRequest.findFirst({where:{communityManagerId:manager.id,tgUserId:'56',initiative:true}});
 assert.equal(proposal.status,'DRAFT');assert.equal(proposal.sourceMessageId,700);assert.ok(proposal.candidates.length);
 const draftData=await (await fetch(base+manager.id+'/collaber',{headers})).json();
 assert.ok(draftData.drafts.some(r=>r.id===proposal.id));assert.ok(!draftData.requests.some(r=>r.id===proposal.id));
 config.limits.quietEnabled=false;await saveConfig();
 await prisma.communityManagerConversationState.upsert({where:{communityManagerId:manager.id},create:{communityManagerId:manager.id,lastHumanAt:new Date()},update:{lastHumanAt:new Date()}});
 await processCollaberJobs();
 proposal=await prisma.collaberRequest.findUnique({where:{id:proposal.id}});assert.equal(proposal.status,'SENT');
 const groupMatch=deliveries.find(d=>d.replyId===700&&d.html);assert.ok(groupMatch.html.includes('cover.png'));
 assert.equal(groupMatch.chat,chat.tgChatId);
 console.log('PASS intro match replies to source despite current conversation; quiet-hour retry works with periodicDays=0');

 noMatches=true;
 await prisma.collaberProfile.update({where:{id:boris.id},data:{publicMentions:false}});
 await queueLiveIntro(manager.id,{message_id:701,from:{id:57,first_name:'Вера'},text:'#intro Меня зовут Вера. Предлагаю маркетинг для мини-приложений.',date:Math.floor(Date.now()/1000)});
 await processCollaberJobs();await processCollaberJobs();
 const vera=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'57'}}});
 await processTelegramTask(task('57','cp:'+vera.id+':private'));const beforePrivate=sends;
 await processCollaberJobs();assert.equal(sends,beforePrivate);
 assert.equal((await prisma.collaberProfile.findUnique({where:{id:vera.id}})).publicMentions,false);
 assert.equal(await prisma.collaberRequest.count({where:{communityManagerId:manager.id,tgUserId:'57',initiative:true}}),0);
 // Explicitly allowed new author, no candidates: silent group result.
 await ingestIntro(manager.id,{...intro,id:'702',userId:'58',at:new Date().toISOString()},config.features.collaber);
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:'58'},data:{publicMentions:true}});
 const {propose}=require('../dist/communityManager/collaber/proposals.js');
 const beforeEmpty=sends;await propose(manager.id,'58','no-match-test',702);assert.equal(sends,beforeEmpty);
 assert.equal((await prisma.collaberRequest.findFirst({where:{communityManagerId:manager.id,tgUserId:'58',initiative:true}})).status,'NO_MATCH');
 const empty=await createMatch({managerId:manager.id,userId:'58',chatId:'58',query:'ищу маркетолога',dedupeKey:'empty-'+tag});
 await deliverMatch(empty.id,manager.id);const emptyDelivery=deliveries.at(-1);
 assert.ok(!emptyDelivery.html.includes('cover.png'));assert.equal(emptyDelivery.keyboard.inline_keyboard.length,1);assert.equal(emptyDelivery.keyboard.inline_keyboard[0].length,1);
 await processTelegramTask(task('58','cb:good:'+empty.id+':0'));
 assert.equal((await prisma.collaberRequest.findUnique({where:{id:empty.id}})).feedback,null);
 const resultsData=await (await fetch(base+manager.id+'/collaber',{headers})).json();
 assert.ok(resultsData.stats.sent>resultsData.stats.matched);assert.ok(resultsData.requests.every(r=>!['PREVIEW','DRAFT'].includes(r.status)));
 console.log('PASS private-only consent, silent empty group match, plain empty personal reply, feedback guard and meaningful owner statistics');
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id},data:{publicMentions:false}});
 await queueLiveIntro(manager.id,{message_id:703,from:{id:59,first_name:'Олег'},text:'#intro Меня зовут Олег. Предлагаю продвижение мини-приложений.',date:Math.floor(Date.now()/1000)});
 await processCollaberJobs();await processCollaberJobs();
 const oleg=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'59'}}});
 await processTelegramTask(task('59','cp:'+oleg.id+':public'));
 assert.match(deliveries.at(-1).text,/Разрешение сохранено.*нет других участников/);
 assert.equal(deliveries.at(-1).replyId,703);
 console.log('PASS public consent explicitly explains that no other public profiles are available');
 noMatches=false;
 await profilePreference(manager.id,'42','forget');
 const removed=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}});
 assert.equal(removed.forgotten,true);assert.equal(removed.sourceText,'');assert.deepEqual(removed.facts,[]);
 assert.equal(await ingestIntro(manager.id,{...intro,id:'12',at:new Date().toISOString()},config.features.collaber),false);
 assert.equal((await prisma.collaberRequest.findUnique({where:{id:request.id}})).status,'CANCELLED');
 console.log('PASS erasure invalidates derived recommendations and prevents re-import resurrection');

 // Missing extraction evidence must reach semantic review, without real AI/network calls.
 const originalInference=ai.collaberJson,originalMembership=telegram.getChatMember;
 const provider={...intro,id:'810',userId:'810',name:'Fixture Provider',text:'#intro Я художник. Создал Example ID.\n\nExample ID предоставляет верификацию пользователей мини-приложений и защиту от ботов.',at:new Date().toISOString(),sourceChatId:chat.tgChatId};
 ai.collaberJson=async(_manager,stage,{prompt,system})=>{
   const p=JSON.parse(prompt);
   if(system.startsWith('Extract'))return {facts:[{kind:'project',value:'Создал Example ID.',evidence:'Создал Example ID.'}]};
   if(system.startsWith('Given'))return {keywords:['верификация','пользователи']};
   if(system.startsWith('Rank')){
     const candidate=p.candidates.find(c=>c.intro.join(' ').includes('Example ID предоставляет верификацию'));
     assert.ok(candidate,'original project capabilities must reach semantic review');
     assert.ok(!candidate.facts.some(f=>f.text.includes('верификацию')),'fixture extraction intentionally omits the capability');
     return {ids:[candidate.id]};
   }
 };
 await ingestIntro(manager.id,provider,config.features.collaber,false,true);
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:'810'},data:{publicMentions:true}});
 const verification=await findCandidates(manager.id,'Ищу сервис верификации пользователей','811',config.features.collaber,true,false);
 assert.equal(verification.length,1);assert.equal(verification[0].tgUserId,'810');assert.match(verification[0].evidence,/верификацию/);
 assert.equal(verification[0].introUrl,'https://t.me/c/'+chat.tgChatId.slice(4)+'/810');
 const beforeDiagnostic=sends;
 telegram.getChatMember=async(chat,user,token)=>{if(Number(user)!==100&&Number(user)!==200)throw new Error('Simulated membership read failure');return originalMembership(chat,user,token)};
 await assert.rejects(findCandidates(manager.id,'Ищу сервис верификации пользователей','811',config.features.collaber,true,true),/проверить участие/);
 assert.equal(sends,beforeDiagnostic);
 const diagnostic=await prisma.communityManagerAction.findFirst({where:{communityManagerId:manager.id,intent:'collaber_matching'},orderBy:{createdAt:'desc'}});
 assert.equal(diagnostic.status,'FAILED');assert.equal(diagnostic.metadata.unverified,1);assert.equal(diagnostic.metadata.semantic,1);
 telegram.getChatMember=originalMembership;
 // Private edits do not inherit a group source, even if Telegram IDs collide.
 await ingestIntro(manager.id,{...provider,id:'811',at:new Date(Date.now()+1000).toISOString(),sourceChatId:undefined},config.features.collaber,true,false);
 const privateResult=await findCandidates(manager.id,'Ищу сервис верификации пользователей','811',config.features.collaber,true,false);
 assert.equal(privateResult[0].introUrl,undefined);
 ai.collaberJson=async(_manager,_stage,{system})=>system.startsWith('Given')?{keywords:['верификация']}:null;
 await assert.rejects(findCandidates(manager.id,'верификация пользователей','811',config.features.collaber,true,false),/корректный список/);
 ai.collaberJson=originalInference;
 console.log('PASS omitted project capability reaches semantic review; verified intro links, private edit isolation, model/membership failures are not NO_MATCH');

 const {handleGroupCollaborationQuery}=require('../dist/communityManager/collaber/routing.js');
 await prisma.communityManager.update({where:{id:manager.id},data:{mode:'AUTOPILOT'}});
 // Test the whole public handler with fake inference/Telegram, not just a keyword helper.
 let routes=0;
 ai.collaberJson=async(_manager,stage,{prompt,system})=>{
   const p=JSON.parse(prompt);
   if(stage==='Маршрут запроса Collaber'){
     routes++;
     if(p.text==='Привет!')return {kind:'NONE',query:''};
     if(p.text==='Найди партнёра')return {kind:'CLARIFY',query:''};
     if(p.text==='Для верификации')assert.equal(p.clarificationContext,'Найди партнёра');
     return {kind:'SEARCH',query:'Сервис верификации пользователей'};
   }
   if(system.startsWith('Given'))return {keywords:['верификация','пользователи']};
   if(system.startsWith('Rank'))return {ids:p.candidates.filter(c=>c.intro.join(' ').includes('Example ID предоставляет')).map(c=>c.id)};
   return originalInference(_manager,stage,{prompt,system});
 };
 await ingestIntro(manager.id,{...provider,id:'812',at:new Date(Date.now()+2000).toISOString()},config.features.collaber,false,true);
 const groupInput={managerId:manager.id,chatId:chat.tgChatId,userId:'811',messageId:820,eventKey:'route-test-'+tag,text:'Есть какие то проекты с проверкой человечности?',addressedToManager:true,addressedToOtherHuman:false};
 const beforeRouting=sends;
 assert.equal(await handleGroupCollaborationQuery(groupInput),true);
 assert.equal(sends,beforeRouting+1);assert.equal(routes,1);
 const routed=deliveries.at(-1);assert.equal(routed.replyId,820);assert.ok(routed.html.includes('cover.png'));
 assert.ok(routed.keyboard.inline_keyboard.flat().some(b=>b.url==='https://t.me/c/'+chat.tgChatId.slice(4)+'/812'));
 assert.ok(routed.keyboard.inline_keyboard.flat().some(b=>b.text.startsWith('Написать')));
 await handleGroupCollaborationQuery(groupInput);assert.equal(sends,beforeRouting+1);assert.equal(routes,1);
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'human-'+tag,addressedToOtherHuman:true}),false);assert.equal(routes,1);
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'hello-'+tag,text:'Привет!'}),false);assert.equal(sends,beforeRouting+1);
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'clarify-'+tag,text:'Найди партнёра',messageId:821}),true);
 assert.match(deliveries.at(-1).text,/Для какой задачи/);
 const clarificationAction=await prisma.communityManagerAction.findFirst({where:{communityManagerId:manager.id,intent:'collaber',status:'COMPLETED'},orderBy:{createdAt:'desc'}});
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'followup-'+tag,text:'Для верификации',messageId:822,replyToMessageId:clarificationAction.telegramMessageId}),true);
 assert.ok(deliveries.at(-1).html.includes('cover.png'));
 await handleGroupCollaborationQuery({...groupInput,eventKey:'self-'+tag,userId:'810',messageId:823});
 assert.ok(!deliveries.at(-1).html.includes('cover.png'),'requester must not recommend themselves');
 ai.collaberJson=originalInference;
 console.log('PASS natural group search renders one card with verified intro link; deduplication, normal chat, human reply exclusion, clarification follow-up and self exclusion');

 await prisma.communityManager.update({where:{id:manager.id},data:{enabled:false}});
 await assert.rejects(createMatch({managerId:manager.id,userId:'43',chatId:chat.tgChatId,query:'маркетинг',dedupeKey:'paused-'+tag}),/выключен/);
 const beforePrivacy=sends;telegram.getChatMember=async()=>({status:'left',user:{id:44}});
 await processTelegramTask(task('44',null,'/forget'));
 assert.equal((await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'44'}}})).forgotten,true);assert.equal(sends,beforePrivacy);
 console.log('PASS manager pause blocks new matching');
}finally{
 if(httpServer)await new Promise(resolve=>httpServer.close(resolve));
 if(community)await prisma.community.delete({where:{id:community.id}});
 if(other)await prisma.community.delete({where:{id:other.id}});
 if(moderatorChat)await prisma.moderatorChat.delete({where:{id:moderatorChat.id}});
 if(user)await prisma.user.delete({where:{id:user.id}});
 globalThis.fetch=originalFetch;await prisma.$disconnect();
}
