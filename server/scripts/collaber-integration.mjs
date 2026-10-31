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
const {processTelegramTask,acceptCollaberUpdate,entryPayload,refinementPayload}=require('../dist/communityManager/collaber/telegram.js');
const {issueModeratorSession}=require('../dist/lib/moderatorSession.js');
const express=require('express');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,...args)=>{if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,...args);throw new Error('Unexpected network access in Collaber integration')};
env.COMMUNITY_MANAGER_BOT_TOKEN='100:test';env.COMMUNITY_MANAGER_BOT_USERNAME='fixture_bot';
let sends=0,ambiguous=false,noMatches=false,failDelete=false,alreadyDeleted=false;const deliveries=[],deletions=[],markupEdits=[],callbackAnswers=[];
telegram.telegramAction=async(method,payload)=>{if(method==='answerCallbackQuery'){callbackAnswers.push(payload);return}assert.equal(method,'editMessageReplyMarkup');markupEdits.push(payload)};
telegram.answerBotCallback=async(id,text)=>{callbackAnswers.push({callback_query_id:id,text})};
telegram.deleteBotMessage=async(chatId,messageId)=>{if(failDelete)throw new Error('Simulated delete failure');if(alreadyDeleted)throw new telegram.TelegramApiError('Bad Request: message to delete not found',400);deletions.push({chatId,messageId})};
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
 if(system.startsWith('Classify'))return {kind:'SEARCH',query:(p.clarificationContext??'')+' '+p.text};
 if(system.startsWith('Given'))return{keywords:['маркетинг','продвижение']};
 if(system.startsWith('Rank'))return fixtureReview(p,noMatches?[]:p.candidates.slice(0,3).map(x=>x.id));
 throw new Error('Unexpected inference');
};
function fixtureReview(p,ids){return {decisions:p.candidates.map(c=>({id:c.id,role:'provider',fit:ids.includes(c.id)?'direct':'none',reasonCode:ids.includes(c.id)?'relevant_capability':'unrelated',evidence:ids.includes(c.id)?(c.intro.find(t=>t.includes('Example ID предоставляет'))??c.facts[0]?.text??c.intro[0]):''}))}}
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
 const beforeDeliveryInference=ai.collaberJson;
 ai.collaberJson=async()=>{throw new Error('Delivery must not rerun inference')};
 await Promise.all([deliverMatch(request.id,manager.id),deliverMatch(request.id,manager.id)]);
 ai.collaberJson=beforeDeliveryInference;
 assert.equal(sends,1);assert.equal((await prisma.collaberRequest.findUnique({where:{id:request.id}})).status,'SENT');
 assert.equal((await prisma.subscription.findUnique({where:{userId:user.id}})).communityManagerActionsUsed,1);
 console.log('PASS concurrent delivery is claimed once and charged once');
 const hiddenRequest=await createMatch({managerId:manager.id,userId:'43',chatId:chat.tgChatId,query:'маркетинг',dedupeKey:'hidden-'+tag,initiative:true});
 const {refreshCandidates}=require('../dist/communityManager/collaber/service.js');
 await profilePreference(manager.id,'42','no_mentions');
 assert.equal((await refreshCandidates(manager.id,'43',hiddenRequest.candidates,true)).length,0);
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:'42'},data:{publicMentions:true}});
 const changed=await prisma.collaberProfile.findFirst({where:{communityManagerId:manager.id,tgUserId:'42'}});
 await prisma.collaberProfile.update({where:{id:changed.id},data:{sourceText:changed.sourceText+' Обновление.'}});
 assert.equal((await refreshCandidates(manager.id,'43',hiddenRequest.candidates,true)).length,0);
 await prisma.collaberProfile.update({where:{id:changed.id},data:{sourceText:changed.sourceText}});
 const membershipBefore=telegram.getChatMember;
 telegram.getChatMember=async(chat,id,token)=>Number(id)===42?{status:'left',user:{id:42}}:membershipBefore(chat,id,token);
 assert.equal((await refreshCandidates(manager.id,'43',hiddenRequest.candidates,true)).length,0);
 telegram.getChatMember=membershipBefore;
 await prisma.collaberProfile.update({where:{id:changed.id},data:{membership:'MEMBER'}});
 console.log('PASS delivery uses saved selection without AI; consent revocation, changed intro and departed member remove stale candidates');


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
 const invite=await prisma.collaberInvite.create({data:{communityManagerId:manager.id,pairKey:'42:43',requesterId:'43',candidateId:'42',requestId:request.id,status:'WAITING',expiresAt:new Date(Date.now()+86400000)}});
 const retiredClick=(uid,kind,id)=>({update_id:8675300+Number(uid),callback_query:{id:'click-'+uid+'-'+kind,from:{id:Number(uid)},data:'cb:'+kind+':'+id+':0',message:{chat:{id:chat.tgChatId,type:'supergroup'}}}});
 for(const [kind,id] of [['n',request.id],['yes',invite.id],['no',invite.id]])for(const uid of ['43','42','99']){
  const queued=await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'TELEGRAM'}});
  assert.equal(await acceptCollaberUpdate(retiredClick(uid,kind,id),{type:'SHARED',botId:100}),true);
  assert.match(callbackAnswers.at(-1).text,/отключены/);
  assert.equal(await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'TELEGRAM'}}),queued);
  await processTelegramTask(task(uid,'cb:'+kind+':'+id+':0'));
 }
 assert.equal(sends,beforeForeign);assert.equal((await prisma.collaberInvite.findUnique({where:{id:invite.id}})).status,'WAITING');
 const directCandidates=await findCandidates(manager.id,'маркетинг','43',config.features.collaber,true,false);
 assert.ok(directCandidates.some(c=>c.tgUserId==='42'),'Old invitation must not suppress direct search');
 assert.ok((await refreshCandidates(manager.id,'43',directCandidates,true)).some(c=>c.tgUserId==='42'),'Old invitation must not suppress saved recommendations');
 const retiredTasks=await Promise.all([
  prisma.collaberTask.create({data:{communityManagerId:manager.id,kind:'TELEGRAM',dedupeKey:'retired-callback-'+tag,payload:{callback:{data:'cb:yes:'+invite.id+':0'}}}}),
  prisma.collaberTask.create({data:{communityManagerId:manager.id,kind:'INVITE_DELIVERY',dedupeKey:'retired-delivery-'+tag,payload:{inviteId:invite.id}}})
 ]);
 await prisma.communityManager.update({where:{id:manager.id},data:{enabled:false}});
 for(let i=0;i<4&&await prisma.collaberTask.count({where:{id:{in:retiredTasks.map(t=>t.id)},status:'PENDING'}});i++)await processCollaberJobs();
 assert.equal(await prisma.collaberTask.count({where:{id:{in:retiredTasks.map(t=>t.id)},status:'CANCELLED',payload:{equals:{}}}}),2);
 assert.equal(sends,beforeForeign);
 await prisma.communityManager.update({where:{id:manager.id},data:{enabled:true}});
 await processTelegramTask(task('43',null,'/start '+entryPayload(manager.id)));
 await processTelegramTask(task('42',null,'/start '+entryPayload(manager.id)));
 await processTelegramTask(task('43','cb:r:'+request.id+':0'));
 assert.ok(deliveries.at(-1).keyboard.inline_keyboard[0][0].url.includes('?start=cr_'));
 const hint=await prisma.collaberTask.findFirst({where:{communityManagerId:manager.id,kind:'REFINEMENT'}});assert.equal(hint.payload.query,request.query);
 const privateRefine=refinementPayload(request.id);
 const wrongRefine={update_id:8675388,message:{message_id:99,chat:{type:'private',id:99},from:{id:99,first_name:'Other'},text:'/start '+privateRefine}};
 assert.equal(await acceptCollaberUpdate(wrongRefine,{type:'SHARED',botId:100}),false);
 await processTelegramTask(task('43',null,'/start '+privateRefine));
 assert.equal((await prisma.collaberSession.findUnique({where:{botId_tgUserId:{botId:'100',tgUserId:'43'}}})).state,'REFINE');
 const refineTask=task('43',null,'Именно с опытом TON');await processTelegramTask(refineTask);
 const refined=await prisma.collaberRequest.findUnique({where:{dedupeKey:refineTask.id}});assert.ok(refined.query.includes(request.query));assert.match(refined.query,/TON/);
 await processTelegramTask(task('43',null,'/search'));
 const reset=await prisma.collaberSession.findUnique({where:{botId_tgUserId:{botId:'100',tgUserId:'43'}}});assert.equal(reset.state,'SEARCH');assert.equal(reset.query,'');
 console.log('PASS retired buttons and queued deliveries send nothing; historical invites do not suppress direct search; signed refinement preserves the author and query');
 const webhook={update_id:8675309,message:{message_id:99,chat:{type:'private',id:43},from:{id:43,first_name:'Tester'},text:'/start '+entryPayload(manager.id)}};
 await acceptCollaberUpdate(webhook,{type:'SHARED',botId:100});await acceptCollaberUpdate(webhook,{type:'SHARED',botId:100});
 assert.equal(await prisma.collaberTask.count({where:{communityManagerId:manager.id,dedupeKey:'telegram:100:8675309'}}),1);
 console.log('PASS callback ownership and webhook deduplication');

 const reserveProfiles=[];const reserveInference=ai.collaberJson,reserveMembership=telegram.getChatMember;
 try{
  for(const uid of ['881','882']){
   await ingestIntro(manager.id,{...intro,id:uid,userId:uid,name:'Reserve '+uid},config.features.collaber);
   await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:uid},data:{publicMentions:true}});
   reserveProfiles.push(await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:uid}}}));
  }
  const first=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}});
  const ids=[first.id,...reserveProfiles.map(p=>p.id)];
  ai.collaberJson=async(mid,stage,input)=>{
   if(!input.system.startsWith('Rank'))return reserveInference(mid,stage,input);
   const output=fixtureReview(JSON.parse(input.prompt),ids);output.decisions.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));return output;
  };
  telegram.getChatMember=async(chat,uid,token)=>Number(uid)===42?{status:'left',user:{id:42}}:reserveMembership(chat,uid,token);
  const replacement=await findCandidates(manager.id,'маркетинг','43',config.features.collaber,true,true);
  assert.equal(replacement.length,2);assert.deepEqual(new Set(replacement.map(c=>c.tgUserId)),new Set(['881','882']));
 }finally{
  ai.collaberJson=reserveInference;telegram.getChatMember=reserveMembership;
  await prisma.collaberProfile.deleteMany({where:{id:{in:reserveProfiles.map(p=>p.id)}}});
  await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:'42'},data:{membership:'MEMBER'}});
 }
 console.log('PASS departed top candidate is replaced by eligible reserves without exceeding the two-person group limit');

 const hideInGroup=task('42',null,'/hide@fixture_bot');hideInGroup.payload.chatId=chat.tgChatId;await processTelegramTask(hideInGroup);
 assert.equal(deliveries.at(-1).chat,chat.tgChatId);assert.equal((await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}})).searchable,false);
 const showInGroup=task('42',null,'/show@fixture_bot');showInGroup.payload.chatId=chat.tgChatId;await processTelegramTask(showInGroup);
 assert.equal(deliveries.at(-1).chat,chat.tgChatId);assert.equal((await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}})).searchable,true);
 console.log('PASS active group privacy commands acknowledge in the source chat without requiring private onboarding');




 // Group-first onboarding uses actual source message IDs and no private session.
 const saveConfig=()=>prisma.communityManagerConfig.update({where:{communityManagerId_version:{communityManagerId:manager.id,version:1}},data:{config}});
 config.features.collaber.initiatives='auto';config.features.collaber.periodicDays=0;config.features.collaber.maxInitiativesPerDay=5;
 config.features.collaber.imageUrl='https://example.com/cover.png';
 config.features.collaber.showImage=false;config.features.collaber.introduction='';
 config.features.collaber.buttons={contact:false,intro:true,refine:false};
 config.replies.conversationMemory=true;await saveConfig();
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
 const beforeConsent=sends;failDelete=true;await assert.rejects(processTelegramTask(task('56',publicButton)),/delete failure/);failDelete=false;
 assert.equal((await prisma.collaberProfile.findUnique({where:{id:boris.id}})).publicMentions,true,'choice survives deletion failure');
 await processTelegramTask(task('56',publicButton));const afterPublic=sends;assert.equal(sends,beforeConsent);
 const consentPromptTask=await prisma.collaberTask.findUnique({where:{dedupeKey:'consent:'+manager.id+':56'}});
 const promptTask=await prisma.collaberTask.findUnique({where:{dedupeKey:'consent-prompt:'+consentPromptTask.id}});
 const promptAction=await prisma.communityManagerAction.findFirst({where:{communityManagerId:manager.id,metadata:{path:['collaberKey'],equals:promptTask.id}}});
 assert.deepEqual(deletions.at(-1),{chatId:chat.tgChatId,messageId:promptAction.telegramMessageId});assert.notEqual(deletions.at(-1).messageId,700);
 const deleteCount=deletions.length;await processTelegramTask(task('56',publicButton));assert.equal(sends,afterPublic);assert.equal(deletions.length,deleteCount);
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
 const groupMatch=deliveries.find(d=>d.replyId===700&&d.html);assert.ok(!groupMatch.html.includes('cover.png'));assert.ok(groupMatch.keyboard.inline_keyboard.length<=2);
 assert.equal(groupMatch.chat,chat.tgChatId);
 console.log('PASS intro match replies to source despite current conversation; quiet-hour retry works with periodicDays=0');

 noMatches=true;
 await prisma.collaberProfile.update({where:{id:boris.id},data:{publicMentions:false}});
 await queueLiveIntro(manager.id,{message_id:701,from:{id:57,first_name:'Вера'},text:'#intro Меня зовут Вера. Предлагаю маркетинг для мини-приложений.',date:Math.floor(Date.now()/1000)});
 await processCollaberJobs();await processCollaberJobs();
 const vera=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'57'}}});
 const beforePrivateDelete=deletions.length;await processTelegramTask(task('57','cp:'+vera.id+':private'));const beforePrivate=sends;
 assert.equal(deletions.length,beforePrivateDelete+1);
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
 assert.ok(!emptyDelivery.html.includes('cover.png'));assert.equal(emptyDelivery.keyboard.inline_keyboard.length,0);
 await processTelegramTask(task('58','cb:good:'+empty.id+':0'));
 assert.equal((await prisma.collaberRequest.findUnique({where:{id:empty.id}})).feedback,null);
 const resultsData=await (await fetch(base+manager.id+'/collaber',{headers})).json();
 assert.equal('introduced' in resultsData.stats,false);assert.ok(resultsData.stats.sent>resultsData.stats.matched);assert.ok(resultsData.requests.every(r=>!['PREVIEW','DRAFT'].includes(r.status)));
 console.log('PASS private-only consent, silent empty group match, plain empty personal reply, feedback guard and meaningful owner statistics');
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id},data:{publicMentions:false}});
 await queueLiveIntro(manager.id,{message_id:703,from:{id:59,first_name:'Олег'},text:'#intro Меня зовут Олег. Предлагаю продвижение мини-приложений.',date:Math.floor(Date.now()/1000)});
 await processCollaberJobs();await processCollaberJobs();
 const oleg=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'59'}}});
 alreadyDeleted=true;await processTelegramTask(task('59','cp:'+oleg.id+':public'));alreadyDeleted=false;
 const olegConsent=await prisma.collaberTask.findUnique({where:{dedupeKey:'consent:'+manager.id+':59'}});
 assert.equal(olegConsent.payload.removed,true);
 console.log('PASS consent deletes only its prompt; both choices, deletion retry and already-deleted messages preserve consent without new messages');
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
   if(system.startsWith('Given'))return {keywords:['мореплавание']}; // Deliberately poor synonyms must not prune a small community.
   if(system.startsWith('Rank')){
     const candidate=p.candidates.find(c=>c.intro.join(' ').includes('Example ID предоставляет верификацию'));
     assert.ok(candidate,'original project capabilities must reach semantic review');
     assert.ok(!candidate.facts.some(f=>f.text.includes('верификацию')),'fixture extraction intentionally omits the capability');
     return fixtureReview(p,[candidate.id]);
   }
 };
 await ingestIntro(manager.id,provider,config.features.collaber,false,true);
 await prisma.collaberProfile.updateMany({where:{communityManagerId:manager.id,tgUserId:'810'},data:{publicMentions:true}});
 const verification=await findCandidates(manager.id,'Есть проекты с проверкой человечности?','811',config.features.collaber,true,false);
 assert.equal(verification.length,1);assert.equal(verification[0].tgUserId,'810');assert.match(verification[0].evidence,/верификацию/);
 assert.equal(verification[0].introUrl,'https://t.me/c/'+chat.tgChatId.slice(4)+'/810');
 // Legacy profiles retain permalink proof in consent even after message history expires.
 const {profileIntroLinks}=require('../dist/communityManager/collaber/sources.js');
 const legacy=await prisma.collaberProfile.findUnique({where:{id:verification[0].id}});
 const legacyFacts=legacy.facts.map(({sourceChatId,...fact})=>fact);
 await prisma.collaberProfile.update({where:{id:legacy.id},data:{facts:legacyFacts}});
 const legacyConsent=await prisma.collaberTask.create({data:{communityManagerId:manager.id,kind:'CONSENT',status:'COMPLETED',dedupeKey:'consent:'+manager.id+':810',payload:{userId:'810',sourceMessageId:810}}});
 const legacyProfile={...legacy,facts:legacyFacts};
 assert.equal((await profileIntroLinks(manager.id,chat.tgChatId,[legacyProfile])).get(legacy.id),'https://t.me/c/'+chat.tgChatId.slice(4)+'/810');
 const previouslyReviewed={...legacyProfile,reviewedAt:new Date(legacy.sourceAt.getTime()-60000)};
 assert.equal((await profileIntroLinks(manager.id,chat.tgChatId,[previouslyReviewed])).get(legacy.id),'https://t.me/c/'+chat.tgChatId.slice(4)+'/810','an earlier review must not hide a newer group intro after history retention');
 assert.equal((await profileIntroLinks(manager.id,'-100999999',[legacyProfile])).size,0);
 const reviewLog=await prisma.communityManagerAction.findFirst({where:{communityManagerId:manager.id,intent:'collaber_matching'},orderBy:{createdAt:'desc'}});
 assert.ok(reviewLog.metadata.decisions.some(d=>d.id===verification[0].id&&d.role==='provider'&&d.fit==='direct'&&d.returned));
 const beforeDiagnostic=sends;
 telegram.getChatMember=async(chat,user,token)=>{if(Number(user)!==100&&Number(user)!==200)throw new Error('Simulated membership read failure');return originalMembership(chat,user,token)};
 await assert.rejects(findCandidates(manager.id,'Ищу сервис верификации пользователей','811',config.features.collaber,true,true),/проверить участие/);
 assert.equal(sends,beforeDiagnostic);
 const diagnostic=await prisma.communityManagerAction.findFirst({where:{communityManagerId:manager.id,intent:'collaber_matching'},orderBy:{createdAt:'desc'}});
 assert.equal(diagnostic.status,'FAILED');assert.equal(diagnostic.metadata.unverified,1);assert.equal(diagnostic.metadata.semantic,1);
 telegram.getChatMember=originalMembership;
 // Private edits do not inherit a group source, even if Telegram IDs collide.
 await ingestIntro(manager.id,{...provider,id:'811',at:new Date(Date.now()+1000).toISOString(),sourceChatId:undefined},config.features.collaber,true,false);
 await prisma.collaberTask.update({where:{id:legacyConsent.id},data:{payload:{userId:'810',sourceMessageId:811}}});
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
     if(p.text==='Нужен именно готовый сервис')assert.equal(p.clarificationContext,'Сервис верификации пользователей');
     if(p.text==='Уточнение чужого запроса')assert.equal(p.clarificationContext,undefined);
     return {kind:'SEARCH',query:'Сервис верификации пользователей'};
   }
   if(system.startsWith('Given'))return {keywords:['верификация','пользователи']};
   if(system.startsWith('Rank'))return fixtureReview(p,p.candidates.filter(c=>c.intro.join(' ').includes('Example ID предоставляет')).map(c=>c.id));
   return originalInference(_manager,stage,{prompt,system});
 };
 await ingestIntro(manager.id,{...provider,id:'812',at:new Date(Date.now()+2000).toISOString()},config.features.collaber,false,true);
 const groupInput={managerId:manager.id,chatId:chat.tgChatId,userId:'811',messageId:820,eventKey:'route-test-'+tag,text:'Есть какие то проекты с проверкой человечности?',addressedToManager:true,addressedToOtherHuman:false};
 const beforeRouting=sends;
 assert.equal(await handleGroupCollaborationQuery(groupInput),true);
 assert.equal(sends,beforeRouting+1);assert.equal(routes,1);
 const routed=deliveries.at(-1);assert.equal(routed.replyId,820);assert.ok(!routed.html.includes('cover.png'));assert.ok(routed.keyboard.inline_keyboard.every(row=>row.every(b=>b.text.startsWith('Интро:'))));
 const sentRequest=await prisma.collaberRequest.findFirst({where:{communityManagerId:manager.id,tgUserId:'811',status:'SENT'},orderBy:{createdAt:'desc'}});
 const beforeLegacyClick=sends;
 await processTelegramTask(task('811','cb:i:'+sentRequest.id+':0'));
 assert.equal(sends,beforeLegacyClick,'legacy intro click must not publish a copy');
 assert.ok(markupEdits.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.url==='https://t.me/c/'+chat.tgChatId.slice(4)+'/812'));
 assert.ok(routed.keyboard.inline_keyboard.flat().some(b=>b.url==='https://t.me/c/'+chat.tgChatId.slice(4)+'/812'));
 assert.ok(!routed.keyboard.inline_keyboard.flat().some(b=>b.text.startsWith('Написать')));
 await handleGroupCollaborationQuery(groupInput);assert.equal(sends,beforeRouting+1);assert.equal(routes,1);
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'human-'+tag,addressedToOtherHuman:true}),false);assert.equal(routes,1);
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'hello-'+tag,text:'Привет!'}),false);assert.equal(sends,beforeRouting+1);
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'clarify-'+tag,text:'Найди партнёра',messageId:821}),true);
 assert.match(deliveries.at(-1).text,/Для какой задачи/);
 const clarificationAction=await prisma.communityManagerAction.findFirst({where:{communityManagerId:manager.id,intent:'collaber',status:'COMPLETED'},orderBy:{createdAt:'desc'}});
 assert.equal(await handleGroupCollaborationQuery({...groupInput,eventKey:'followup-'+tag,text:'Для верификации',messageId:822,replyToMessageId:clarificationAction.telegramMessageId}),true);
 assert.ok(deliveries.at(-1).keyboard.inline_keyboard.some(row=>row.some(b=>b.text.startsWith('Интро:'))));
 await handleGroupCollaborationQuery({...groupInput,eventKey:'self-'+tag,userId:'810',messageId:823});
 assert.equal(deliveries.at(-1).keyboard.inline_keyboard.length,0,'requester must not recommend themselves');
 const previousSearch=await prisma.collaberRequest.findFirst({where:{communityManagerId:manager.id,tgUserId:'811',status:'SENT'},orderBy:{createdAt:'desc'}});
 await handleGroupCollaborationQuery({...groupInput,eventKey:'refine-result-'+tag,text:'Нужен именно готовый сервис',messageId:824,replyToMessageId:previousSearch.telegramMessageId});
 await handleGroupCollaborationQuery({...groupInput,eventKey:'foreign-refine-'+tag,userId:'999',text:'Уточнение чужого запроса',messageId:825,replyToMessageId:previousSearch.telegramMessageId});
 ai.collaberJson=originalInference;
 console.log('PASS natural group search renders one card with verified intro link; deduplication, normal chat, human reply exclusion, clarification follow-up and self exclusion');

 // Reproduce a search being incorrectly treated as the author's intro.
 const {afterLiveIntro,sendConsentPrompt}=require('../dist/communityManager/collaber/proposals.js');
 const {processCommunityManagerJobs}=require('../dist/communityManager/engine.js');
 const agent=require('../dist/communityManager/agentRuntime.js'),originalAgent=agent.runCommunityManagerAgent;
 const beforeSearchProfile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}});
 const searchText='Ищу разработчика по созданию мини-приложения';
 const searchMessage={...intro,id:'9400',userId:'940',sourceChatId:chat.tgChatId,text:searchText,at:new Date().toISOString()};
 const beforeIntroTasks=await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'INTRO'}});
 assert.equal(await ingestIntro(manager.id,searchMessage,config.features.collaber,false,true),false);
 assert.equal(await ingestIntro(manager.id,{...searchMessage,userId:'42'},config.features.collaber,false,true),false);
 await queueLiveIntro(manager.id,{telegramMessageId:9400,tgUserId:'940',text:searchText,createdAt:new Date()});
 await afterLiveIntro(manager.id,searchMessage);
 assert.equal(await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'INTRO'}}),beforeIntroTasks);
 assert.equal(await prisma.collaberProfile.count({where:{communityManagerId:manager.id,tgUserId:'940'}}),0);
 assert.deepEqual(await prisma.collaberProfile.findUnique({where:{id:beforeSearchProfile.id}}),beforeSearchProfile);
 // A stale consent job for an already misclassified search must not send a new prompt.
 const stalePerson=await prisma.communityManagerParticipant.create({data:{communityManagerId:manager.id,tgUserId:'942',displayName:'Synthetic legacy search'}});
 const staleProfile=await prisma.collaberProfile.create({data:{communityManagerId:manager.id,participantId:stalePerson.id,tgUserId:'942',sourceText:searchText,sourceAt:new Date(),sourceMessageId:9420}});
 const staleConsent=await prisma.collaberTask.create({data:{communityManagerId:manager.id,kind:'CONSENT',status:'WAITING',dedupeKey:'consent:'+manager.id+':942',payload:{userId:'942',sourceMessageId:9420,sourceChatId:chat.tgChatId}}});
 const beforeStalePrompt=sends;await sendConsentPrompt({id:'stale-search-consent-'+tag,communityManagerId:manager.id,payload:{userId:'942',consentId:staleConsent.id}});assert.equal(sends,beforeStalePrompt);
 await prisma.collaberProfile.delete({where:{id:staleProfile.id}});
 const introOnlyNeed={...searchMessage,id:'9410',userId:'941',text:'#intro '+searchText};
 assert.equal(await ingestIntro(manager.id,introOnlyNeed,config.features.collaber,false,true),true);
 await prisma.collaberProfile.deleteMany({where:{communityManagerId:manager.id,tgUserId:'941'}});
 const ambientBefore=config.replies.ambientConversation;config.replies.ambientConversation=false;await saveConfig();
 await prisma.communityManagerConversationState.upsert({where:{communityManagerId:manager.id},create:{communityManagerId:manager.id},update:{}});
 agent.runCommunityManagerAgent=async()=>{throw new Error('Explicit searches must not fall through to the conversational agent')};
 try{
  for(const [index,text] of ['Ищу разработчика',searchText,'Ищу разработчика для моего проекта. Мой проект — Telegram Mini App.'].entries()){
   const source=await prisma.communityManagerMessage.create({data:{communityManagerId:manager.id,telegramUpdateId:'search-not-intro-'+tag+'-'+index,telegramMessageId:9401+index,tgChatId:chat.tgChatId,tgUserId:'940',text,expiresAt:new Date(Date.now()+86400000)}});
   const job=await prisma.communityManagerJob.create({data:{communityManagerId:manager.id,messageId:source.id}});
   await processCommunityManagerJobs();
   const complete=await prisma.communityManagerJob.findUnique({where:{id:job.id}});assert.equal(complete.status,'COMPLETED',complete.lastError);
   assert.ok(await prisma.collaberRequest.findFirst({where:{communityManagerId:manager.id,tgUserId:'940',sourceMessageId:source.telegramMessageId,initiative:false}}));
   assert.equal(await prisma.collaberProfile.count({where:{communityManagerId:manager.id,tgUserId:'940'}}),0);
   assert.equal(await prisma.collaberTask.count({where:{communityManagerId:manager.id,kind:'INTRO'}}),beforeIntroTasks);
   // Edits of a routed search are not a source for a profile, even with self-description words.
   assert.equal(await ingestIntro(manager.id,{...searchMessage,id:String(source.telegramMessageId),text:'Мой проект — Mini App. Ищу разработчика.',at:new Date().toISOString()},config.features.collaber,false,true),false);
  }
 }finally{agent.runCommunityManagerAgent=originalAgent;config.replies.ambientConversation=ambientBefore;await saveConfig()}
 console.log('PASS standalone and compound developer searches route before extraction, do not overwrite profiles or ask public consent; explicit tagged intros still save');


 await prisma.communityManager.update({where:{id:manager.id},data:{enabled:false}});
 await assert.rejects(createMatch({managerId:manager.id,userId:'43',chatId:chat.tgChatId,query:'маркетинг',dedupeKey:'paused-'+tag}),/выключен/);
 const beforePrivacy=sends;telegram.getChatMember=async()=>({status:'left',user:{id:44}});
 await processTelegramTask(task('44',null,'/forget'));
 assert.equal((await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'44'}}})).forgotten,true);assert.equal(sends,beforePrivacy);
 console.log('PASS manager pause blocks new matching');

 const groupPrivacy=(uid,text,id)=>({update_id:id,message:{message_id:id,chat:{id:Number(chat.tgChatId),type:'supergroup'},from:{id:Number(uid),first_name:'Fixture'},text}});
 assert.equal(await acceptCollaberUpdate(groupPrivacy('42','/hide@other_bot',8675500),{type:'SHARED',botId:100}),false);
 assert.equal(await acceptCollaberUpdate(groupPrivacy('42','/hide@fixture_bot',8675501),{type:'SHARED',botId:100}),true);
 for(let i=0;i<4;i++)await processCollaberJobs();
 assert.equal((await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:manager.id,tgUserId:'42'}}})).searchable,false);
 assert.equal(sends,beforePrivacy);
 console.log('PASS group hide works while paused and commands addressed to another bot are ignored');

}finally{
 if(httpServer)await new Promise(resolve=>httpServer.close(resolve));
 if(community)await prisma.community.delete({where:{id:community.id}});
 if(other)await prisma.community.delete({where:{id:other.id}});
 if(moderatorChat)await prisma.moderatorChat.delete({where:{id:moderatorChat.id}});
 if(user)await prisma.user.delete({where:{id:user.id}});
 globalThis.fetch=originalFetch;await prisma.$disconnect();
}
