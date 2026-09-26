import { prisma } from '../../db';
import { collaberContext, createMatch, ingestIntro } from './service';
import { activeFacts, preferenceCommand, type IntroMessage } from './domain';
import { processTelegramTask } from './telegram';
import { deliverMatch } from './delivery';

let running=false, lastPeriodic=0;
export async function processCollaberJobs(){
  if(running)return;running=true;
  try{
    const now=new Date();
    await prisma.collaberTask.updateMany({where:{status:'PROCESSING',leaseUntil:{lt:now}},data:{status:'PENDING',leaseUntil:null}});
    await prisma.collaberImport.updateMany({where:{status:'PROCESSING',leaseUntil:{lt:now}},data:{status:'PENDING',leaseUntil:null}});
    await prisma.collaberRequest.updateMany({where:{status:'SENDING',updatedAt:{lt:new Date(Date.now()-10*60000)}},data:{status:'UNCERTAIN',error:'Обработка прервалась. Проверьте доставку.'}});
    await prisma.collaberInvite.updateMany({where:{status:'WAITING',expiresAt:{lt:now}},data:{status:'EXPIRED'}});
    const task=await prisma.collaberTask.findFirst({where:{status:'PENDING',runAfter:{lte:now}},orderBy:{createdAt:'asc'}});
    if(task){
      const claim=await prisma.collaberTask.updateMany({where:{id:task.id,status:'PENDING'},data:{status:'PROCESSING',attempts:{increment:1},leaseUntil:new Date(Date.now()+5*60000)}});
      if(claim.count)try{
        const ctx=await collaberContext(task.communityManagerId);
        const privacyCommand=task.kind==='TELEGRAM'&&preferenceCommand(String((task.payload as any).text??''));
        if(!ctx||(!privacyCommand&&(!ctx.manager.enabled||!ctx.config.features.collaber.enabled))){await prisma.collaberTask.update({where:{id:task.id},data:{status:'CANCELLED',payload:{},leaseUntil:null}});return}
        // A crash after dispatch must not replay an uncertain Telegram send.
        const previous=await prisma.communityManagerAction.findFirst({where:{communityManagerId:task.communityManagerId,status:{in:['SENDING','COMPLETED','UNCERTAIN']},metadata:{path:['collaberKey'],equals:task.id}}});
        if(previous){await prisma.collaberTask.update({where:{id:task.id},data:{status:'UNCERTAIN',payload:{},leaseUntil:null}});return}
        if(task.kind==='TELEGRAM')await processTelegramTask(task);
        else if(task.kind==='INTRO'){
          const m=(task.payload as any).message as IntroMessage;
          const after=(task.payload as any).moderationAfter;
          if(after){
            const event=await prisma.moderationEvent.findFirst({where:{communityId:ctx.manager.communityId,telegramMessageId:Number(m.id),eventType:'MESSAGE_DISPOSITION',createdAt:{gte:new Date(after)}},orderBy:{createdAt:'desc'}});
            if(!event)throw new Error('Ожидание проверки исправленного сообщения модератором');
            if(event.action!=='ALLOW'){await prisma.collaberTask.update({where:{id:task.id},data:{status:'CANCELLED',payload:{},leaseUntil:null}});return}
          }
          if(preferenceCommand(m.text)||(ctx.config.features.collaber.collectIntros&&ctx.config.replies.conversationMemory)){
            if(await ingestIntro(task.communityManagerId,m,ctx.config.features.collaber,false,true))await propose(task.communityManagerId,m.userId,'intro:'+task.id);
          }
        }
        await prisma.collaberTask.updateMany({where:{id:task.id,status:'PROCESSING'},data:{status:'COMPLETED',payload:{},leaseUntil:null,error:null}});
      }catch(error){
        const sent=await prisma.communityManagerAction.findFirst({where:{communityManagerId:task.communityManagerId,status:{in:['SENDING','COMPLETED','UNCERTAIN']},metadata:{path:['collaberKey'],equals:task.id}}});
        await prisma.collaberTask.updateMany({where:{id:task.id,status:'PROCESSING'},data:{status:sent?'UNCERTAIN':task.attempts>=2?'FAILED':'PENDING',runAfter:new Date(Date.now()+60000),leaseUntil:null,error:error instanceof Error?error.message.slice(0,300):'Ошибка обработки'}});
      }
      return;
    }
    const batch=await prisma.collaberImport.findFirst({where:{status:'PENDING'},orderBy:{createdAt:'asc'}});
    if(batch){
      const claim=await prisma.collaberImport.updateMany({where:{id:batch.id,status:'PENDING'},data:{status:'PROCESSING',leaseUntil:new Date(Date.now()+5*60000)}});if(!claim.count)return;
      try{
        const ctx=await collaberContext(batch.communityManagerId,true);if(!ctx)throw new Error('Настройки не найдены');
        const messages=batch.messages as unknown as IntroMessage[];let processed=batch.processed,profiles=batch.profiles;
        for(const message of messages.slice(processed,processed+5)){
          const active=await prisma.collaberImport.findFirst({where:{id:batch.id,status:'PROCESSING'}});if(!active)return;
          if(await ingestIntro(batch.communityManagerId,message,ctx.config.features.collaber))profiles++;
          processed++;
          await prisma.collaberImport.updateMany({where:{id:batch.id,status:'PROCESSING'},data:{processed,profiles}});
        }
        await prisma.collaberImport.updateMany({where:{id:batch.id,status:'PROCESSING'},data:{status:processed>=messages.length?'COMPLETED':'PENDING',leaseUntil:null,error:null,attempts:0,...(processed>=messages.length?{messages:[]}: {})}});
      }catch(error){await prisma.collaberImport.updateMany({where:{id:batch.id,status:'PROCESSING'},data:{status:batch.attempts>=2?'FAILED':'PENDING',attempts:{increment:1},leaseUntil:null,error:error instanceof Error?error.message.slice(0,300):'Ошибка импорта'}})}
      return;
    }
    if(Date.now()-lastPeriodic>3600000){lastPeriodic=Date.now();
      const managers=await prisma.communityManager.findMany({where:{enabled:true,publishedVersion:{not:null}},select:{id:true}});
      for(const m of managers){
        const ctx=await collaberContext(m.id);if(!ctx?.config.features.collaber.enabled)continue;
        const cfg=ctx.config.features.collaber;if(cfg.initiatives==='off'||!cfg.periodicDays)continue;
        if(cfg.initiatives==='auto'){
          const waiting=await prisma.collaberRequest.findFirst({where:{communityManagerId:m.id,initiative:true,status:'DRAFT',createdAt:{gte:new Date(Date.now()-7*86400000)}},orderBy:{createdAt:'asc'}});
          if(waiting){await deliverMatch(waiting.id,m.id).catch(()=>undefined);continue}
        }
        const profiles=await prisma.collaberProfile.findMany({where:{communityManagerId:m.id,searchable:true,publicMentions:true,forgotten:false,sourceAt:{gte:new Date(Date.now()-cfg.freshnessDays*86400000)},OR:[{lastProposedAt:null},{lastProposedAt:{lt:new Date(Date.now()-cfg.periodicDays*86400000)}}]},orderBy:{sourceAt:'desc'},take:100});
        const profile=profiles.find(p=>activeFacts(p.facts).some(f=>f.kind==='need'));
        if(profile)await propose(m.id,profile.tgUserId,'periodic:'+Math.floor(Date.now()/(cfg.periodicDays*86400000)));
      }
    }
    await prisma.collaberImport.updateMany({where:{createdAt:{lt:new Date(Date.now()-7*86400000)},status:{in:['PREVIEW','FAILED','CANCELLED']}},data:{messages:[],status:'EXPIRED'}});
    await prisma.collaberTask.deleteMany({where:{kind:{not:'SUPPRESSION'},createdAt:{lt:new Date(Date.now()-30*86400000)},status:{in:['COMPLETED','CANCELLED','FAILED']}}});
  }finally{running=false}
}
async function propose(managerId:string,userId:string,key:string){
  const ctx=await collaberContext(managerId);if(!ctx||ctx.config.features.collaber.initiatives==='off')return;
  const profile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}}});
  if(!profile?.searchable||!profile.publicMentions||profile.forgotten)return;
  const facts=activeFacts(profile.facts),query=facts.filter(f=>f.kind==='need').map(f=>f.value).join('; ').slice(0,500);if(!query)return;
  const recent=await prisma.collaberRequest.findFirst({where:{communityManagerId:managerId,tgUserId:userId,initiative:true,createdAt:{gt:new Date(Date.now()-86400000)}}});if(recent)return;
  const request=await createMatch({managerId,userId,chatId:ctx.chatId,query,dedupeKey:managerId+':'+userId+':'+key,initiative:true});
  if(ctx.config.features.collaber.initiatives==='auto')await deliverMatch(request.id,managerId);
}
