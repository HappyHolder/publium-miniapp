import { hydrateLinkedChannel } from './channelContext';
import { prisma } from '../db';
import { primaryTextModel } from '../lib/assistantModel';
import { sendBotMessage } from '../lib/telegramBot';
import { parseCommunityManagerConfig } from './config';
import { communityManagerExecutor } from './managedBot';
import { normalizeCommunityManagerPunctuation } from './conversationStyle';
import { runCommunityManagerAgent } from './agentRuntime';
import { activitySessionKey } from './agentSession';
import { refundSubscriptionQuota, reserveSubscriptionQuota } from '../lib/subscriptionLimits';

type State={endsAt?:string;reminderSent?:boolean;rewardDescription?:string;rewardMode?:string;[key:string]:unknown};
const stateOf=(value:unknown):State=>value&&typeof value==='object'?value as State:{};

export async function advanceActiveActivities(now=new Date()){
  const rows=await prisma.communityManagerActivity.findMany({where:{status:'ACTIVE',scheduledAt:{lte:now}},orderBy:{scheduledAt:'asc'},take:30,include:{communityManager:{include:{community:{include:{moderatorChat:true,chat:true,channel:true}}}}}});
  for(const activity of rows){
    const claim=await prisma.communityManagerActivity.updateMany({where:{id:activity.id,status:'ACTIVE',scheduledAt:{lte:now}},data:{status:'PROCESSING'}});if(!claim.count)continue;
    let reserved=false,sent=false;
    try{
      await hydrateLinkedChannel(activity.communityManager.community);
      const manager=activity.communityManager,state=stateOf(activity.result),endsAt=state.endsAt?new Date(state.endsAt):null,ownerUserId=manager.community.chat?.userId??manager.community.channel?.userId,channelName=manager.community.chat?.title??manager.community.channel?.name??'сообщество';
      if(!manager.enabled||!manager.publishedVersion||!manager.community.moderatorChat||!endsAt){await prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:'CANCELLED'}});continue}
      const row=await prisma.communityManagerConfig.findUnique({where:{communityManagerId_version:{communityManagerId:manager.id,version:manager.publishedVersion}}});if(!row){await prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:'CANCELLED',lastError:'Config not applied'}});continue}
      const config=parseCommunityManagerConfig(row.config),finished=endsAt<=now,recent=await prisma.communityManagerMessage.findMany({where:{communityManagerId:manager.id,createdAt:{gte:activity.sentAt??activity.createdAt}},orderBy:{createdAt:'asc'},take:100,select:{telegramMessageId:true,tgUserId:true,text:true,createdAt:true}});
      if(!ownerUserId)throw new Error('Community owner not found');const phase=finished?'finish':'reminder',agent=await runCommunityManagerAgent({managerId:manager.id,communityId:manager.community.id,channelId:manager.community.channelId,channelName,chatId:manager.community.moderatorChat.tgChatId,config,sessionKey:activitySessionKey(activity.type,activity.id),event:{kind:'MANUAL_ACTIVITY',dedupeKey:'activity-lifecycle:'+manager.id+':'+activity.id+':'+phase,activityId:activity.id,activityType:activity.type,topic:activity.topic??undefined,activityContext:{phase,rewardDescription:state.rewardDescription??null,endsAt:endsAt.toISOString(),rules:finished?'Close the existing activity without inventing winners, names, results or payments.':'A midpoint reminder is optional. Never restart the activity, change its rules, pressure people, or invent participation.',messages:recent.map(message=>({reference:'msg:'+message.telegramMessageId,authorId:message.tgUserId,text:message.text,createdAt:message.createdAt.toISOString()}))}}});
      const message=agent.decision.message?normalizeCommunityManagerPunctuation(agent.decision.message).trim().slice(0,1000):'';
      if(message){
        const quota=await reserveSubscriptionQuota(ownerUserId,'communityManagerActions');if(!quota.ok)throw new Error('Community Manager monthly action limit reached');reserved=true;
        const executor=await communityManagerExecutor(manager.community.id),telegram=await sendBotMessage(manager.community.moderatorChat.tgChatId,message,executor.token);sent=true;
        await prisma.communityManagerAction.create({data:{communityManagerId:manager.id,decision:'ACTIVITY',intent:(activity.type+'_'+phase).toLowerCase(),reason:agent.decision.reason,response:message,sources:agent.sources as any,model:primaryTextModel(),promptVersion:'community-agent-v1',telegramMessageId:telegram?.messageId,inputTokens:agent.inputTokens,outputTokens:agent.outputTokens,metadata:{agentEventId:agent.eventId,references:agent.decision.references}}});
      }
      await prisma.communityManagerActivity.update({where:{id:activity.id},data:finished?{status:'COMPLETED',scheduledAt:now,result:{...state,reminderSent:Boolean(state.reminderSent),finishedAt:now.toISOString(),evaluated:true}}:{status:'ACTIVE',scheduledAt:endsAt,result:{...state,reminderSent:true,remindedAt:now.toISOString()}}});
    }catch(error){
      const ownerUserId=activity.communityManager.community.chat?.userId??activity.communityManager.community.channel?.userId;if(reserved&&!sent&&ownerUserId)await refundSubscriptionQuota(ownerUserId,'communityManagerActions');
      const retryAt=new Date(now.getTime()+15*60_000),message=error instanceof Error?error.message.slice(0,500):'Activity lifecycle failed';
      await prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:'ACTIVE',scheduledAt:retryAt,lastError:message}}).catch(()=>undefined);
      await prisma.communityManager.update({where:{id:activity.communityManagerId},data:{lastError:message}}).catch(()=>undefined);
    }
  }
}
