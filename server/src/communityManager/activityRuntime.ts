import { hydrateLinkedChannel } from './channelContext';
import { prisma } from '../db';
import { primaryTextModel } from '../lib/assistantModel';
import { sendBotMessage, setBotMessageReaction } from '../lib/telegramBot';
import { isQuietHour, parseCommunityManagerConfig } from './config';
import { communityManagerExecutor } from './managedBot';
import { normalizeCommunityManagerPunctuation } from './conversationStyle';
import { getEffectiveSubscription, reserveSubscriptionQuota, refundSubscriptionQuota, TIER_LIMITS } from '../lib/subscriptionLimits';
import { isRewardActivity, type CommunityActivityType } from './activityDirector';
import { runCommunityManagerAgent, type CommunityAgentEvent } from './agentRuntime';
import { activitySessionKey, conversationSessionKey } from './agentSession';
import { appendCmThesis, createInitiativeLocation } from './conversationCoordinator';
import { markMentionedExperts } from './participantMemory';
import { reviewContentComment } from './contentCommentPolicy';

type ActivityMeta={activityId?:string;automatic?:boolean;origin?:'MANUAL'|'DIRECTOR'|'CONTENT';context?:Record<string,unknown>;reason?:string;postId?:string;phase?:string;ignoredStreak?:number;postText?:string;sourceUrl?:string;replyToMessageId?:number;threadId?:string;segmentId?:string};

async function sendPoll(chatId:string,token:string,payload:{question:string;options:string[];type:'regular'|'quiz';correctOptionIndex:number|null;explanation:string|null}){
  const body={chat_id:chatId,question:payload.question.slice(0,300),options:payload.options.slice(0,4).map(text=>({text:text.slice(0,100)})),is_anonymous:true,type:payload.type,correct_option_id:payload.type==='quiz'?payload.correctOptionIndex??0:undefined,explanation:payload.type==='quiz'?(payload.explanation??undefined):undefined};
  const response=await fetch('https://api.telegram.org/bot'+token+'/sendPoll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await response.json() as any;
  if(!data.ok)throw new Error(data.description??'sendPoll failed');return Number(data.result?.message_id);
}

const enabledFor=(config:ReturnType<typeof parseCommunityManagerConfig>,type:CommunityActivityType)=>({DISCUSSION:config.activities.discussionEnabled,POLL:config.activities.pollEnabled,QUIZ:config.activities.quizEnabled,LIGHT:config.activities.lightEnabled,HOT_NEWS:config.activities.hotNewsEnabled,DIGEST:config.activities.digestEnabled,PREDICTION:config.activities.predictionEnabled,CHALLENGE:config.activities.challengeEnabled,CONTEST:config.activities.contestEnabled,CONTENT_TEASER:config.activities.contentSupportEnabled,CONTENT_RELEASE:config.activities.contentSupportEnabled} as Record<CommunityActivityType,boolean>)[type];

export async function runActivity(managerId:string,type:CommunityActivityType,topic?:string,meta:ActivityMeta={}){
  const manager=await prisma.communityManager.findUnique({where:{id:managerId},include:{community:{include:{moderatorChat:true,chat:true,channel:true}}}});
  if(!manager?.enabled||!manager.publishedVersion||!manager.community.moderatorChat)throw new Error('CM is not active');
  await hydrateLinkedChannel(manager.community);
  const ownerUserId=manager.community.chat?.userId??manager.community.channel?.userId,channelName=manager.community.chat?.title??manager.community.channel?.name??'сообщество';if(!ownerUserId)throw new Error('Community owner not found');
  const subscription=await getEffectiveSubscription(ownerUserId);if(!TIER_LIMITS[subscription.tier].canUseCommunityManager)throw new Error('CM requires Starter or higher');
  const row=await prisma.communityManagerConfig.findUnique({where:{communityManagerId_version:{communityManagerId:manager.id,version:manager.publishedVersion}}});if(!row)throw new Error('Config not applied');
  const config=parseCommunityManagerConfig(row.config);if(isQuietHour(config))throw new Error('Quiet hours');if(!enabledFor(config,type)&&!['moderator_followup','unanswered_question'].includes(meta.reason??''))throw new Error(type+' activity is disabled');if(isRewardActivity(type)&&meta.automatic)throw new Error('Reward activities require owner action');
  const activityData={type,topic,origin:meta.origin??(meta.automatic?'DIRECTOR':'MANUAL'),sourcePostId:meta.postId,threadId:meta.threadId,segmentId:meta.segmentId,scheduledAt:new Date(),status:'RUNNING',lastError:null,result:{...(meta.context??{}),automatic:Boolean(meta.automatic),evaluated:!meta.automatic,reason:meta.reason??'manual',postId:meta.postId,phase:meta.phase,replyToMessageId:meta.replyToMessageId,ignoredStreak:meta.ignoredStreak??0,rewardMode:config.activities.rewardMode}} as const;
  const activity=meta.activityId?await prisma.communityManagerActivity.update({where:{id:meta.activityId},data:activityData}):await prisma.communityManagerActivity.create({data:{communityManagerId:manager.id,...activityData}});
  let reserved=false,sent=false,telegramMessageId:number|undefined;
  try{
    let postText=meta.postText??'',sourceUrl=meta.sourceUrl??'';
    if(meta.postId){const post=await prisma.generatedPost.findUnique({where:{id:meta.postId},include:{variants:{select:{id:true,text:true}}}});if(post){postText=post.variants.find(item=>item.id===post.selectedVariantId)?.text??post.variants[0]?.text??postText;sourceUrl=post.sourceUrl??sourceUrl}}
    const sessionKey=meta.threadId&&meta.segmentId?conversationSessionKey(meta.threadId,meta.segmentId):activitySessionKey(type,activity.id);
    const eventKind:CommunityAgentEvent['kind']=type==='CONTENT_RELEASE'?'CONTENT_POST':meta.automatic?'INITIATIVE':'MANUAL_ACTIVITY';
    const baseEvent={kind:eventKind,dedupeKey:'activity:'+manager.id+':'+activity.id,activityId:activity.id,activityType:type,topic,postText:postText.slice(0,12000),sourceUrl,replyTargetMessageId:meta.replyToMessageId};
    let result=await runCommunityManagerAgent({managerId:manager.id,communityId:manager.community.id,channelId:manager.community.channelId,channelName,chatId:manager.community.moderatorChat.tgChatId,config,sessionKey,threadId:meta.threadId,segmentId:meta.segmentId,event:baseEvent});
    let qualityIssues:string[]=[];
    if(type==='CONTENT_RELEASE'&&result.decision.action==='comment'){
      let review=reviewContentComment({decision:result.decision,postText,replyTargetMessageId:meta.replyToMessageId,sources:result.sources.length});
      if(!review.approved){
        result=await runCommunityManagerAgent({managerId:manager.id,communityId:manager.community.id,channelId:manager.community.channelId,channelName,chatId:manager.community.moderatorChat.tgChatId,config,sessionKey,threadId:meta.threadId,segmentId:meta.segmentId,event:{...baseEvent,dedupeKey:baseEvent.dedupeKey+':quality-revision',activityContext:{qualityIssues:review.issues,previousEditorialPlan:result.decision.editorialPlan}}});
        review=reviewContentComment({decision:result.decision,postText,replyTargetMessageId:meta.replyToMessageId,sources:result.sources.length});
      }
      qualityIssues=review.issues;
    }
    const decision=result.decision;
    let effectiveThreadId=meta.threadId,effectiveSegmentId=meta.segmentId;
    if(type==='CONTENT_RELEASE'&&qualityIssues.length){
      const reason='Content comment rejected: '+qualityIssues.join(', ');
      await prisma.$transaction([
        prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:'CANCELLED',lastError:reason.slice(0,500),result:{...(meta.context??{}),automatic:Boolean(meta.automatic),evaluated:true,reason,agentEventId:result.eventId,qualityIssues}}}),
        prisma.communityManagerAction.create({data:{communityManagerId:manager.id,threadId:effectiveThreadId,segmentId:effectiveSegmentId,decision:'SILENT',intent:'content_quality_rejected',reason:reason.slice(0,500),sources:result.sources as any,model:primaryTextModel(),promptVersion:'community-agent-v1',inputTokens:result.inputTokens,outputTokens:result.outputTokens,metadata:{agentEventId:result.eventId,action:decision.action,references:decision.references,qualityIssues}}}),
      ]);
      return{activityId:activity.id,status:'CANCELLED'};
    }
    if(decision.action==='no_action'||decision.action==='react'&&!meta.replyToMessageId){
      await prisma.$transaction([
        prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:'CANCELLED',lastError:decision.reason,result:{...(meta.context??{}),automatic:Boolean(meta.automatic),evaluated:true,reason:decision.reason,agentEventId:result.eventId}}}),
        prisma.communityManagerAction.create({data:{communityManagerId:manager.id,threadId:meta.threadId,segmentId:meta.segmentId,decision:'SILENT',intent:decision.intent,reason:decision.reason,sources:result.sources as any,model:primaryTextModel(),promptVersion:'community-agent-v1',inputTokens:result.inputTokens,outputTokens:result.outputTokens,metadata:{agentEventId:result.eventId,action:decision.action,references:decision.references}}}),
      ]);return{activityId:activity.id,status:'CANCELLED'};
    }
    if(type==='CONTENT_RELEASE'&&meta.activityId){
      const sendClaim=await prisma.communityManagerActivity.updateMany({where:{id:activity.id,status:'RUNNING'},data:{status:'SENDING'}});
      if(!sendClaim.count)return{activityId:activity.id,status:'CANCELLED'};
    }
    const quota=await reserveSubscriptionQuota(ownerUserId,'communityManagerActions');if(!quota.ok)throw new Error('Community Manager monthly action limit reached');reserved=true;
    const executor=await communityManagerExecutor(manager.community.id),chatId=manager.community.moderatorChat.tgChatId;
    if(decision.action==='react'){
      const supported=new Set(['👍','🔥','❤','❤️','👏','🤔','👀','😁','🤯']),emoji=supported.has(decision.reaction??'')?decision.reaction!:'👍';
      await setBotMessageReaction(chatId,meta.replyToMessageId!,emoji,executor.token);telegramMessageId=meta.replyToMessageId;
    }else if(decision.action==='poll'&&decision.poll){telegramMessageId=await sendPoll(chatId,executor.token,{question:normalizeCommunityManagerPunctuation(decision.poll.question),options:decision.poll.options.map(normalizeCommunityManagerPunctuation),type:decision.poll.type,correctOptionIndex:decision.poll.correctOptionIndex,explanation:decision.poll.explanation})}
    else{
      const message=normalizeCommunityManagerPunctuation(decision.message??'').trim().slice(0,1200);if(!message)throw new Error('Empty agent activity');telegramMessageId=(await sendBotMessage(chatId,message,executor.token,undefined,undefined,decision.targetMessageId??meta.replyToMessageId))?.messageId;
    }
    sent=true;
    const auditResponse=decision.message??decision.poll?.question??null;
    if(!effectiveThreadId&&telegramMessageId){const location=await createInitiativeLocation({managerId:manager.id,tgChatId:chatId,telegramRootMessageId:telegramMessageId,topicKey:topic??type,origin:meta.origin==='CONTENT'?'CONTENT':'DIRECTOR',sourcePostId:meta.postId});effectiveThreadId=location.threadId;effectiveSegmentId=location.segmentId}
    const sentAt=new Date(),longRunning=isRewardActivity(type),endsAt=longRunning?new Date(sentAt.getTime()+(type==='CONTEST'?7:3)*86400_000):undefined;
    await prisma.$transaction([
      prisma.communityManagerActivity.update({where:{id:activity.id},data:{threadId:effectiveThreadId,segmentId:effectiveSegmentId,status:longRunning?'ACTIVE':'COMPLETED',sentAt,telegramMessageId,scheduledAt:longRunning?new Date(sentAt.getTime()+(type==='CONTEST'?84:36)*3600_000):sentAt,result:{...(meta.context??{}),automatic:Boolean(meta.automatic),evaluated:!meta.automatic,reason:decision.reason,postId:meta.postId,phase:meta.phase,replyToMessageId:meta.replyToMessageId,ignoredStreak:meta.ignoredStreak??0,rewardMode:config.activities.rewardMode,rewardDescription:config.activities.rewardDescription,endsAt:endsAt?.toISOString(),reminderSent:false,sources:result.sources as any,agentEventId:result.eventId}}}),
      prisma.communityManager.update({where:{id:manager.id},data:{lastActionAt:sentAt,lastHealthyAt:sentAt,lastError:null}}),
      prisma.communityManagerAction.create({data:{communityManagerId:manager.id,threadId:effectiveThreadId,segmentId:effectiveSegmentId,decision:decision.action==='react'?'REACT':'ACTIVITY',intent:decision.intent,reason:decision.reason,response:auditResponse?.slice(0,5000),sources:result.sources as any,model:primaryTextModel(),promptVersion:'community-agent-v1',telegramMessageId,inputTokens:result.inputTokens,outputTokens:result.outputTokens,metadata:{agentEventId:result.eventId,action:decision.action,references:decision.references}}}),
    ]);
    if(effectiveThreadId&&effectiveSegmentId&&auditResponse)await appendCmThesis({threadId:effectiveThreadId,segmentId:effectiveSegmentId,threadVersion:0,segmentVersion:0,topicKey:decision.topicKey},auditResponse);
    if(auditResponse)await markMentionedExperts(manager.id,auditResponse);return{activityId:activity.id,telegramMessageId,status:longRunning?'ACTIVE':'COMPLETED'};
  }catch(error){
    const message=error instanceof Error?error.message.slice(0,500):'failed';if(reserved&&!sent)await refundSubscriptionQuota(ownerUserId,'communityManagerActions');
    if(sent){await prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:isRewardActivity(type)?'ACTIVE':'COMPLETED',sentAt:new Date(),telegramMessageId,lastError:'Sent; audit persistence recovered: '+message}}).catch(()=>undefined);return{activityId:activity.id,telegramMessageId,status:isRewardActivity(type)?'ACTIVE':'COMPLETED'}}
    await prisma.communityManagerActivity.update({where:{id:activity.id},data:{status:'FAILED',lastError:message}});throw error;
  }
}
