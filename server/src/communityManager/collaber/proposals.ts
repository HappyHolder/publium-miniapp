import { prisma } from '../../db';
import { collaberContext, createMatch, enqueueCollaber } from './service';
import { deliverMatch, deliverMessage } from './delivery';
import { activeFacts, type IntroMessage } from './domain';

export function introQuery(facts:unknown,goals:string,fromIntro:boolean){
  const active=activeFacts(facts);
  const needs=active.filter(f=>f.kind==='need').map(f=>f.value).join('; ');
  if(needs)return needs.slice(0,500);
  if(!fromIntro||!active.length)return '';
  return `Возможное сотрудничество по интро. Цель сообщества: ${goals.slice(0,120)}. Из интро: ${active.map(f=>f.value).join('; ').slice(0,280)}`.slice(0,500);
}

export async function propose(managerId:string,userId:string,key:string,sourceMessageId?:number){
  const ctx=await collaberContext(managerId);if(!ctx||ctx.config.features.collaber.initiatives==='off')return;
  const profile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}}});
  if(!profile?.searchable||!profile.publicMentions||profile.forgotten)return;
  const query=introQuery(profile.facts,ctx.config.features.collaber.goals,Boolean(sourceMessageId));if(!query)return;
  const recent=await prisma.collaberRequest.findFirst({where:{communityManagerId:managerId,tgUserId:userId,initiative:true,createdAt:{gt:new Date(Date.now()-86400000)}}});if(recent)return;
  const request=await createMatch({managerId,userId,chatId:ctx.chatId,query,dedupeKey:managerId+':'+userId+':'+key,initiative:true,sourceMessageId});
  if(!Array.isArray(request.candidates)||!request.candidates.length){await prisma.collaberRequest.update({where:{id:request.id},data:{status:'NO_MATCH'}});return}
  if(ctx.config.features.collaber.initiatives==='auto')await deliverMatch(request.id,managerId);
}

/** One explicit public-visibility choice per participant, replying to their own intro. */
export async function afterLiveIntro(managerId:string,message:IntroMessage){
  const ctx=await collaberContext(managerId);if(!ctx||ctx.config.features.collaber.initiatives==='off')return;
  const profile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:message.userId}}});
  if(!profile?.searchable||profile.forgotten)return;
  if(profile.publicMentions){await propose(managerId,message.userId,'intro:'+message.id,Number(message.id));return}
  const dedupeKey='consent:'+managerId+':'+message.userId;
  const existing=await prisma.collaberTask.findUnique({where:{dedupeKey}});if(existing)return;
  const consent=await prisma.collaberTask.create({data:{communityManagerId:managerId,kind:'CONSENT',status:'WAITING',dedupeKey,payload:{userId:message.userId,sourceMessageId:Number(message.id)}}});
  await enqueueCollaber(managerId,'CONSENT_PROMPT','consent-prompt:'+consent.id,{userId:message.userId,consentId:consent.id});
}

export async function sendConsentPrompt(task:{id:string;communityManagerId:string;payload:unknown}){
  const managerId=task.communityManagerId,p=task.payload as {userId:string;consentId:string};
  const ctx=await collaberContext(managerId);if(!ctx||ctx.config.features.collaber.initiatives==='off')return;
  const consent=await prisma.collaberTask.findFirst({where:{id:p.consentId,communityManagerId:managerId,status:'WAITING'}});
  const profile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:p.userId}}});
  if(!consent||!profile?.searchable||profile.forgotten||profile.publicMentions)return;
  const sourceMessageId=(consent.payload as {sourceMessageId:number}).sourceMessageId;
  await deliverMessage(managerId,ctx.chatId,'Интро сохранено для личного подбора. Можно рекомендовать тебя и в группе? /hide — скрыть профиль.',{inline_keyboard:[[{text:'Да, в группе',callback_data:'cp:'+profile.id+':public'},{text:'Только лично',callback_data:'cp:'+profile.id+':private'}]]},task.id,undefined,sourceMessageId,false,async()=>{
    const current=await prisma.collaberProfile.findUnique({where:{id:profile.id}});
    if(!current?.searchable||current.forgotten)throw new Error('Участник скрыл профиль');
  });
}
