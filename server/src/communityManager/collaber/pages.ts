import { Prisma, type CollaberRequest } from '@prisma/client';
import { prisma } from '../../db';
import { communityManagerExecutor } from '../managedBot';
import { isQuietHour } from '../config';
import { collaberContext, candidateExposureHistory, findCandidateBatch, refreshCandidates, profileRevision, type Candidate } from './service';
import { parseCollaber, type CollaberConfig } from './config';
import { COLLABER_PAGE_SIZE, distributeDecisions } from './distribution';
import { withCollaberDeliveryLock, CollaberDeliveryBusy } from './lock';
import { deliverMessageLocked, emptyMatchText, matchPresentation } from './delivery';
import { continuationPayload, memberAccess } from './telegram';

const ids=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
const candidatesOf=(value:unknown):Candidate[]=>Array.isArray(value)?value.filter(c=>c&&typeof c.id==='string'&&typeof c.tgUserId==='string'):[];
const pagesOf=(value:unknown):string[][]=>Array.isArray(value)?value.map(ids):[];
const json=(value:unknown)=>value as Prisma.InputJsonValue;
type PagePlan={requestId:string;rootId:string;userId:string;expectedVersion:number;targetVersion:number;targetIndex:number;pages:string[][];candidates:Candidate[];hasMore:boolean;newPage:boolean;initial:boolean;config:CollaberConfig;botId:string;actionKey:string;text:string;html:string;keyboard:ReturnType<typeof matchPresentation>['keyboard']};

async function rootOf(view:CollaberRequest){
 const root=view.originRequestId?await prisma.collaberRequest.findUnique({where:{id:view.originRequestId}}):view;
 if(!root||view.originRequestId&&Date.now()-root.createdAt.getTime()>7*86400000||root.originRequestId||root.communityManagerId!==view.communityManagerId||root.tgUserId!==view.tgUserId||['CANCELLED','UNCERTAIN','DISMISSED'].includes(root.status))throw new Error('Этот подбор недоступен. Сделай новый запрос.');
 return root;
}

async function preparePage(view:CollaberRequest,direction:'initial'|'next'|'back',config:CollaberConfig){
 const root=await rootOf(view),publicOnly=root.chatId.startsWith('-');
 if(await prisma.collaberTask.findFirst({where:{communityManagerId:view.communityManagerId,kind:'PAGE_PLAN',status:{in:['WAITING','RECOVERY','UNCERTAIN']},payload:{path:['rootId'],equals:root.id}},select:{id:true}}))throw new Error('Предыдущая выдача ещё проверяется. Попробуй позже или начни новый поиск.');
 let pool=candidatesOf(root.candidatePool);if(!pool.length&&!root.presentationConfig)pool=candidatesOf(root.candidates);
 // Concurrent searches may have been ranked before either card was sent. Recheck exposure
 // only before a new immediate search's first page; subsequent pages keep their saved order.
 if(direction==='initial'&&root.id===view.id&&view.status==='READY'&&!pagesOf(root.pages).length){
  const history=await candidateExposureHistory(root.communityManagerId,root.tgUserId,publicOnly);
  pool=distributeDecisions(pool.map(c=>({...c,fit:c.fit??'direct',matchQuality:c.matchQuality??'general'})),history);
 }
 let examined=ids(root.examinedIds),exhausted=root.poolExhausted;
 const seen=new Set(ids(root.seenIds));
 // Older, already delivered cards predate explicit page history.
 if(root.status==='SENT'&&!root.presentationConfig)candidatesOf(root.candidates).forEach(c=>seen.add(c.id));
 const pages=pagesOf(view.pages);
 let index=direction==='initial'?0:direction==='back'?Math.max(0,view.pageIndex-1):view.pageIndex+1;
 let newPage=pages[index]===undefined,candidates:Candidate[]=[];
 const remember=(raw:Candidate[],fresh:Candidate[])=>{
  const refreshed=new Map(fresh.map(c=>[c.id,c])),checked=new Set(raw.map(c=>c.id));
  pool=pool.map(c=>refreshed.get(c.id)??(checked.has(c.id)?{...c,unavailable:true}:c));
 };
 if(!newPage){
  const raw=pages[index].flatMap(id=>{const c=pool.find(p=>p.id===id&&!p.unavailable);return c?[c]:[]});
  candidates=await refreshCandidates(view.communityManagerId,view.tgUserId,raw,publicOnly,COLLABER_PAGE_SIZE);remember(raw,candidates);pages[index]=candidates.map(c=>c.id);
 }else{
  let checked=0,loaded=0;
  while(candidates.length<COLLABER_PAGE_SIZE&&checked<20){
   const selected=new Set(candidates.map(c=>c.id));
   const raw=pool.filter(c=>!c.unavailable&&!seen.has(c.id)&&!selected.has(c.id)).slice(0,COLLABER_PAGE_SIZE-candidates.length);
   if(!raw.length){
    if(exhausted||loaded>=1)break;
    const batch=await findCandidateBatch(root.communityManagerId,root.query,root.tgUserId,config,publicOnly,false,examined);
    examined=[...new Set([...examined,...batch.examinedIds])];exhausted=!batch.hasMore;loaded++;
    const known=new Set(pool.map(c=>c.id));pool.push(...batch.candidates.filter(c=>!known.has(c.id)));
    continue;
   }
   checked+=raw.length;
   const fresh=await refreshCandidates(view.communityManagerId,view.tgUserId,raw,publicOnly,COLLABER_PAGE_SIZE-candidates.length);
   remember(raw,fresh);candidates.push(...fresh);
  }
  const selected=new Set(candidates.map(c=>c.id));
  const remaining=!exhausted||pool.some(c=>!c.unavailable&&!seen.has(c.id)&&!selected.has(c.id));
  if(!candidates.length&&!remaining&&direction==='next'&&pages.length){
   index=view.pageIndex;newPage=false;
   const raw=pages[index].flatMap(id=>{const c=pool.find(p=>p.id===id&&!p.unavailable);return c?[c]:[]});
   candidates=await refreshCandidates(view.communityManagerId,view.tgUserId,raw,publicOnly,COLLABER_PAGE_SIZE);remember(raw,candidates);pages[index]=candidates.map(c=>c.id);
  }else pages[index]=candidates.map(c=>c.id);
 }
 const selected=new Set(candidates.map(c=>c.id));
 const hasMore=index<pages.length-1||!exhausted||pool.some(c=>!c.unavailable&&!seen.has(c.id)&&!selected.has(c.id));
 await prisma.collaberRequest.update({where:{id:root.id},data:{candidatePool:json(pool),examinedIds:examined,poolExhausted:exhausted}});
 return {root,publicOnly,candidates,pages,targetIndex:index,newPage,hasMore,allSeen:seen.size>0&&!hasMore&&!candidates.length};
}

async function assertPageEligible(view:CollaberRequest,plan:PagePlan){
 await memberAccess(view.communityManagerId,view.tgUserId);
 const current=await prisma.collaberRequest.findUnique({where:{id:view.id}}),root=await prisma.collaberRequest.findUnique({where:{id:plan.rootId}});
 if(!current||!root||current.pageVersion!==plan.expectedVersion||current.status!==(plan.initial?'SENDING':'PAGING')||['CANCELLED','UNCERTAIN'].includes(root.status))throw new Error('Состояние подбора изменилось. Повторите действие.');
 const profiles=await prisma.collaberProfile.findMany({where:{communityManagerId:view.communityManagerId,id:{in:plan.candidates.map(c=>c.id)},searchable:true,forgotten:false,membership:{not:'LEFT'},...(root.chatId.startsWith('-')?{publicMentions:true}:{})}});
 if(profiles.length!==plan.candidates.length||plan.candidates.some(c=>!profiles.some(p=>p.id===c.id&&profileRevision(p)===c.profileRevision)))throw new Error('Состав или видимость участников изменились. Повторите подбор.');
}

async function commitPage(plan:PagePlan,taskId:string,messageId:number){
 return prisma.$transaction(async tx=>{
  const view=await tx.collaberRequest.findUnique({where:{id:plan.requestId}}),root=await tx.collaberRequest.findUnique({where:{id:plan.rootId}});
  if(!view||!root||view.communityManagerId!==root.communityManagerId||view.tgUserId!==root.tgUserId||['CANCELLED','UNCERTAIN'].includes(root.status)){
   await tx.collaberTask.update({where:{id:taskId},data:{status:'CANCELLED',payload:{},leaseUntil:null}});return false;
  }
  const claim=await tx.collaberRequest.updateMany({where:{id:view.id,pageVersion:plan.expectedVersion,status:plan.initial?'SENDING':'PAGING'},data:{status:'SENT',candidates:json(plan.candidates),pages:json(plan.pages),pageIndex:plan.targetIndex,pageVersion:plan.targetVersion,presentationConfig:json(plan.config),deliveryBotId:plan.botId,telegramMessageId:messageId,response:plan.text,error:null}});
  if(claim.count){
   await tx.collaberRequest.update({where:{id:root.id},data:{seenIds:[...new Set([...ids(root.seenIds),...plan.candidates.map(c=>c.id)])]}});
   // A return to an old page is not a new recommendation. Unique rows also protect receipt recovery.
   if(plan.newPage&&plan.candidates.length){
    const eligible=await tx.collaberProfile.findMany({where:{id:{in:plan.candidates.map(c=>c.id)},communityManagerId:view.communityManagerId,forgotten:false},select:{id:true}});
    await tx.collaberExposure.createMany({data:eligible.map(p=>({communityManagerId:view.communityManagerId,profileId:p.id,requestId:view.id,requesterId:view.tgUserId,public:view.chatId.startsWith('-')})),skipDuplicates:true});
    await tx.collaberProfile.updateMany({where:{id:{in:eligible.map(p=>p.id)}},data:{lastProposedAt:new Date()}});
   }
  }
  await tx.collaberTask.update({where:{id:taskId},data:{status:'COMPLETED',payload:{},leaseUntil:null,error:null}});return Boolean(claim.count);
 });
}

/** Repair a confirmed receipt without sending or editing anything a second time. */
export async function recoverMatchPages(managerId?:string){
 const tasks=await prisma.collaberTask.findMany({where:{kind:'PAGE_PLAN',status:{in:['WAITING','RECOVERY']},...(managerId?{communityManagerId:managerId}:{})},orderBy:{updatedAt:'asc'},take:5});
 for(const task of tasks){
  const plan=task.payload as unknown as PagePlan;
  if(!plan?.requestId||!plan.rootId||!plan.actionKey)continue;
  const action=await prisma.communityManagerAction.findFirst({where:{communityManagerId:task.communityManagerId,status:'COMPLETED',metadata:{path:['collaberKey'],equals:plan.actionKey}},orderBy:{createdAt:'desc'},select:{telegramMessageId:true}});
  if(action?.telegramMessageId){await withCollaberDeliveryLock(task.communityManagerId,()=>commitPage(plan,task.id,action.telegramMessageId!)).catch(()=>undefined)}
  else if(task.leaseUntil&&task.leaseUntil<new Date())await prisma.$transaction([
   prisma.collaberTask.updateMany({where:{id:task.id,status:task.status},data:{status:'UNCERTAIN',leaseUntil:null,error:'Проверьте доставку страницы в Telegram'}}),
   prisma.collaberRequest.updateMany({where:{id:plan.requestId,pageVersion:plan.expectedVersion,status:{in:['SENDING','PAGING']}},data:{status:'UNCERTAIN',error:'Проверьте доставку страницы в Telegram'}})
  ]);
 }
}

async function dispatchPage(view:CollaberRequest,direction:'initial'|'next'|'back'){
 const ctx=await collaberContext(view.communityManagerId);if(!ctx?.manager.enabled||!ctx.config.features.collaber.enabled)throw new Error('Collaber на паузе');
 const executor=await communityManagerExecutor(ctx.manager.communityId);
 if(view.deliveryBotId&&view.deliveryBotId!==String(executor.botId))throw new Error('Исполнитель изменился. Сделай новый запрос.');
 const config=parseCollaber(view.presentationConfig??ctx.config.features.collaber),prepared=await preparePage(view,direction,config),initial=direction==='initial';
 if(view.initiative&&initial&&!prepared.candidates.length){
  if(!prepared.hasMore)await prisma.collaberRequest.updateMany({where:{id:view.id,status:view.status},data:{status:'NO_MATCH',candidates:[]}});
  return;
 }
 const targetVersion=initial?view.pageVersion:view.pageVersion+1;
 const privateUrl=view.chatId.startsWith('-')&&executor.username?'https://t.me/'+executor.username+'?start='+continuationPayload(view.id):undefined;
 const empty=prepared.hasMore?'В проверенной части пока нет доступных совпадений. Можно продолжить поиск.':prepared.allSeen?'Все найденные варианты этого поиска уже просмотрены. Можно уточнить задачу.':await emptyMatchText(view.communityManagerId,view.tgUserId,view.chatId.startsWith('-'));
 const presentation=matchPresentation({...view,candidates:prepared.candidates,pageIndex:prepared.targetIndex,pageVersion:targetVersion,hasPrevious:prepared.targetIndex>0,hasMore:prepared.hasMore,privateUrl},config,empty);
 const plan:PagePlan={requestId:view.id,rootId:prepared.root.id,userId:view.tgUserId,expectedVersion:view.pageVersion,targetVersion,targetIndex:prepared.targetIndex,pages:prepared.pages,candidates:prepared.candidates,hasMore:prepared.hasMore,newPage:prepared.newPage,initial,config,botId:String(executor.botId),actionKey:view.id,text:presentation.text,html:presentation.html,keyboard:presentation.keyboard};
 const task=await prisma.$transaction(async tx=>{
  const claim=await tx.collaberRequest.updateMany({where:{id:view.id,status:view.status,pageVersion:view.pageVersion},data:{status:initial?'SENDING':'PAGING',presentationConfig:json(config),deliveryBotId:String(executor.botId)}});if(!claim.count)return null;
  const row=await tx.collaberTask.upsert({where:{dedupeKey:'page-plan:'+view.id+':'+targetVersion},create:{communityManagerId:view.communityManagerId,kind:'PAGE_PLAN',status:'WAITING',dedupeKey:'page-plan:'+view.id+':'+targetVersion,payload:json(plan),leaseUntil:new Date(Date.now()+5*60000)},update:{status:'WAITING',payload:json(plan),leaseUntil:new Date(Date.now()+5*60000),error:null}});
  if(!initial){plan.actionKey=row.id;await tx.collaberTask.update({where:{id:row.id},data:{payload:json(plan)}})}return row;
 });
 if(!task)return;
 let confirmed=false;
 try{
  const ref=await deliverMessageLocked(view.communityManagerId,view.chatId,plan.text,plan.keyboard,plan.actionKey,plan.html,initial?view.sourceMessageId??undefined:undefined,initial&&view.initiative,()=>assertPageEligible(view,plan),initial?undefined:view.telegramMessageId??undefined);
  confirmed=true;await commitPage(plan,task.id,ref.messageId);
 }catch(error){
  if(confirmed){await prisma.collaberTask.update({where:{id:task.id},data:{status:'RECOVERY',error:'Подтверждённая страница ожидает сохранения'}}).catch(()=>undefined);throw error}
  const uncertain=Boolean((error as any)?.collaberDispatched),message=uncertain?'Проверьте журнал и чат перед повтором отправки':error instanceof Error?error.message:'Отправка отложена';
  await prisma.$transaction([
   prisma.collaberRequest.updateMany({where:{id:view.id,pageVersion:plan.expectedVersion,status:initial?'SENDING':'PAGING'},data:{status:uncertain?'UNCERTAIN':view.status,error:message}}),
   prisma.collaberTask.update({where:{id:task.id},data:{status:uncertain?'UNCERTAIN':'FAILED',...(uncertain?{}:{payload:{}}),leaseUntil:null,error:message}})
  ]);throw error;
 }
}

export async function deliverInitialMatch(requestId:string,managerId:string,approved=false){
 await recoverMatchPages(managerId);
 try{return await withCollaberDeliveryLock(managerId,async()=>{
  const request=await prisma.collaberRequest.findFirst({where:{id:requestId,communityManagerId:managerId}});if(!request||!['READY','DRAFT'].includes(request.status))return;
  const ctx=await collaberContext(managerId);if(!ctx?.manager.enabled||!ctx.config.features.collaber.enabled)throw new Error('Collaber на паузе');
  const cfg=ctx.config.features.collaber;
  if(request.initiative){
   if(cfg.initiatives==='off'||(!approved&&cfg.initiatives!=='auto'))return;
   const count=await prisma.collaberRequest.count({where:{communityManagerId:managerId,initiative:true,status:{in:['SENDING','SENT','UNCERTAIN']},updatedAt:{gte:new Date(Date.now()-86400000)}}});
   if(count>=cfg.maxInitiativesPerDay||isQuietHour(ctx.config))return;
   const state=await prisma.communityManagerConversationState.findUnique({where:{communityManagerId:managerId}});
   if(!request.sourceMessageId&&state?.lastHumanAt&&state.lastHumanAt>new Date(Date.now()-ctx.config.replies.ambientCooldownMinutes*60000))return;
   if(state?.pendingModeratorAt&&state.pendingModeratorAt>new Date(Date.now()-30*60000))return;
   if(await prisma.communityManagerActivity.findFirst({where:{communityManagerId:managerId,status:{in:['PROCESSING','RUNNING','SENDING','ACTIVE']}}}))return;
  }else if(!cfg.onDemand)return;
  await dispatchPage(request,'initial');
 },requestId)}catch(error){if(error instanceof CollaberDeliveryBusy&&error.owner===requestId)return;throw error}
}

export async function navigateMatch(managerId:string,requestId:string,userId:string,chatId:string,messageId:number,version:number,direction:'next'|'back'){
 await recoverMatchPages(managerId);
 try{return await withCollaberDeliveryLock(managerId,async()=>{
  const request=await prisma.collaberRequest.findFirst({where:{id:requestId,communityManagerId:managerId,tgUserId:userId,chatId,status:'SENT',telegramMessageId:messageId,createdAt:{gt:new Date(Date.now()-7*86400000)}}});
  if(!request||request.pageVersion!==version)return;
  if(direction==='back'&&request.pageIndex===0)return;
  const ctx=await collaberContext(managerId);if(!ctx?.config.features.collaber.onDemand)throw new Error('Поиск сейчас выключен');
  await dispatchPage(request,direction);
 },requestId)}catch(error){if(error instanceof CollaberDeliveryBusy&&error.owner===requestId)return;throw error}
}

export async function continueMatchInPrivate(managerId:string,sourceId:string,userId:string,botId:string){
 await recoverMatchPages(managerId);
 const child=await withCollaberDeliveryLock(managerId,async()=>{
 const source=await prisma.collaberRequest.findFirst({where:{id:sourceId,communityManagerId:managerId,tgUserId:userId,status:'SENT',chatId:{startsWith:'-'},createdAt:{gt:new Date(Date.now()-7*86400000)}}});
 if(!source||source.originRequestId||source.deliveryBotId&&source.deliveryBotId!==botId)throw new Error('Этот подбор недоступен. Сделай новый запрос.');
 return prisma.collaberRequest.upsert({where:{dedupeKey:'private-view:'+source.id},create:{communityManagerId:managerId,tgUserId:userId,chatId:userId,query:source.query,originRequestId:source.id,dedupeKey:'private-view:'+source.id,presentationConfig:source.presentationConfig??Prisma.JsonNull,deliveryBotId:botId,status:'READY'},update:{}});
 });
 await deliverInitialMatch(child.id,managerId);
 return child;
}
