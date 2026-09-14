import { prisma } from '../db';
import { isQuietHour, parseCommunityManagerConfig } from './config';
import { runActivity } from './activityRuntime';
import { createInitiativeLocation } from './conversationCoordinator';

const DEFAULT_SILENCE_MINUTES=20;
const ROOT_RETRY_MINUTES=2;
const ROOT_GRACE_MINUTES=10;
export type ContentTriggerResult={
  automatic?:boolean;reason?:string;postId?:string;phase?:string;channelId?:string;
  channelMessageId?:number;discussionChatId?:string;discussionMessageId?:number;
  postText?:string;sourceUrl?:string;publishedAt?:string;rootWaits?:number;
};
export type TelegramChannelMirror={
  message_id:number;is_automatic_forward?:boolean;sender_chat?:{id:number};
  forward_from_message_id?:number;
  forward_origin?:{type?:string;chat?:{id:number};message_id?:number};
};
const resultOf=(value:unknown):ContentTriggerResult=>value&&typeof value==='object'?value as ContentTriggerResult:{};
const key=(managerId:string,channelMessageId:number)=>'content-release:'+managerId+':'+channelMessageId;

export const contentReleaseDueAt=(publishedAt:Date,silenceMinutes=DEFAULT_SILENCE_MINUTES)=>new Date(publishedAt.getTime()+silenceMinutes*60_000);
export const contentRootDeadlineAt=(publishedAt:Date,silenceMinutes=DEFAULT_SILENCE_MINUTES)=>new Date(publishedAt.getTime()+(silenceMinutes+ROOT_GRACE_MINUTES)*60_000);
export function automaticChannelMirror(message:TelegramChannelMirror){
  const origin=message.forward_origin,sourceChatId=origin?.chat?.id??message.sender_chat?.id;
  const channelMessageId=origin?.message_id??message.forward_from_message_id;
  if(!message.is_automatic_forward)return null;
  if(!sourceChatId||!channelMessageId)return null;
  return{sourceChatId,channelMessageId,discussionMessageId:message.message_id};
}
export function contentThreadMatchesMessage(result:ContentTriggerResult,message:{replyToMessageId?:number|null;messageThreadId?:number|null}){
  const root=result.discussionMessageId;
  return Boolean(root&&(message.replyToMessageId===root||message.messageThreadId===root));
}

async function publishedConfig(managerId:string){
  const manager=await prisma.communityManager.findUnique({where:{id:managerId},select:{enabled:true,mode:true,publishedVersion:true}});
  if(!manager?.enabled||manager.mode!=='AUTOPILOT'||!manager.publishedVersion)return null;
  const row=await prisma.communityManagerConfig.findUnique({where:{communityManagerId_version:{communityManagerId:managerId,version:manager.publishedVersion}}});
  if(!row)return null;
  const config=parseCommunityManagerConfig(row.config);
  return config.activities.enabled&&!config.activities.requireApproval&&config.activities.contentSupportEnabled?config:null;
}

async function mergeRelease(managerId:string,channelMessageId:number,patch:ContentTriggerResult,topic?:string){
  const dedupeKey=key(managerId,channelMessageId),existing=await prisma.communityManagerActivity.findUnique({where:{dedupeKey}});
  const merged={...resultOf(existing?.result),...patch,automatic:true,reason:'content_silence',phase:'release',channelMessageId};
  const config=await publishedConfig(managerId);if(!config)return null;
  const publishedAt=merged.publishedAt?new Date(merged.publishedAt):new Date(),scheduledAt=contentReleaseDueAt(publishedAt,config.activities.contentSilenceMinutes);
  if(existing){
    const mergedTopic=patch.postId?(topic??existing.topic):(existing.topic??topic);
    return prisma.communityManagerActivity.update({where:{id:existing.id},data:{topic:mergedTopic,result:merged,scheduledAt,origin:'CONTENT',sourcePostId:merged.postId,...(['CANCELLED','COMPLETED'].includes(existing.status)?{}:{status:'WAITING'})}});
  }
  return prisma.communityManagerActivity.create({data:{communityManagerId:managerId,type:'CONTENT_RELEASE',origin:'CONTENT',sourcePostId:merged.postId,topic,dedupeKey,status:'WAITING',scheduledAt,result:merged}});
}

export async function queuePublishedPostContentSupport(postId:string){
  const post=await prisma.generatedPost.findUnique({where:{id:postId},include:{variants:true}});
  if(!post?.tgMessageId||!post.publishedAt)return null;
  const links=await prisma.channelChatLink.findMany({where:{channelId:post.channelId,isPrimary:true},include:{chat:{include:{community:{include:{communityManager:true}}}}}});
  const text=post.variants.find(item=>item.id===post.selectedVariantId)?.text??post.variants[0]?.text??'';
  for(const link of links){const manager=link.chat.community?.communityManager;if(manager)await mergeRelease(manager.id,post.tgMessageId,{postId:post.id,channelId:post.channelId,postText:text.slice(0,12000),sourceUrl:post.sourceUrl??undefined,publishedAt:post.publishedAt.toISOString()},post.title);}
  return null;
}

export async function captureAutomaticChannelPost(managerId:string,input:{channelId?:string;channelMessageId:number;discussionChatId:string;discussionMessageId:number;text:string;publishedAt:Date}){
  const text=input.text.trim();
  return mergeRelease(managerId,input.channelMessageId,{channelId:input.channelId,discussionChatId:input.discussionChatId,discussionMessageId:input.discussionMessageId,...(text?{postText:text.slice(0,12000)}:{}),publishedAt:input.publishedAt.toISOString()},text?text.replace(/\s+/g,' ').slice(0,160):undefined);
}

export async function cancelSilentContentRelease(managerId:string,message:{replyToMessageId?:number|null;messageThreadId?:number|null}){
  if(!message.replyToMessageId&&!message.messageThreadId)return false;
  const waiting=await prisma.communityManagerActivity.findMany({where:{communityManagerId:managerId,type:'CONTENT_RELEASE',origin:'CONTENT',status:{in:['WAITING','PROCESSING','RUNNING']}},orderBy:{createdAt:'desc'},take:20});
  const matched=waiting.filter(row=>contentThreadMatchesMessage(resultOf(row.result),message)).map(row=>row.id);
  if(!matched.length)return false;
  await prisma.communityManagerActivity.updateMany({where:{id:{in:matched},status:{in:['WAITING','PROCESSING','RUNNING']}},data:{status:'CANCELLED',lastError:'Human discussion started'}});
  return true;
}

async function contentCommentAllowed(managerId:string,now:Date){const [recent,fresh]=await Promise.all([prisma.communityManagerActivity.count({where:{communityManagerId:managerId,type:'CONTENT_RELEASE',status:'COMPLETED',sentAt:{gte:new Date(now.getTime()-24*3600_000)}}}),prisma.communityManagerActivity.findFirst({where:{communityManagerId:managerId,type:'CONTENT_RELEASE',status:'COMPLETED',sentAt:{gte:new Date(now.getTime()-4*3600_000)}},select:{id:true}})]);return recent<3&&!fresh}

export async function processSilentContentReleases(now=new Date()){
  for(let index=0;index<10;index++){
    const release=await prisma.communityManagerActivity.findFirst({where:{type:'CONTENT_RELEASE',origin:'CONTENT',status:'WAITING',scheduledAt:{lte:now}},orderBy:{scheduledAt:'asc'}});
    if(!release)break;
    const claim=await prisma.communityManagerActivity.updateMany({where:{id:release.id,status:'WAITING'},data:{status:'PROCESSING'}});if(!claim.count)continue;
    const result=resultOf(release.result);
    try{
      const config=await publishedConfig(release.communityManagerId);
      if(!config){await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'CANCELLED',lastError:'Content support disabled'}});continue}
      if(isQuietHour(config,now)){await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'WAITING',scheduledAt:new Date(now.getTime()+15*60_000)}});continue}
      if(!await contentCommentAllowed(release.communityManagerId,now)){await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'CANCELLED',lastError:'Content comment frequency gate'}});continue}
      if(!result.discussionMessageId||!result.discussionChatId){
        const publishedAt=result.publishedAt?new Date(result.publishedAt):release.createdAt;
        if(now<contentRootDeadlineAt(publishedAt,config.activities.contentSilenceMinutes)){
          await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'WAITING',scheduledAt:new Date(now.getTime()+ROOT_RETRY_MINUTES*60_000),lastError:'Waiting for Telegram discussion root',result:{...result,rootWaits:(result.rootWaits??0)+1}}});
        }else{
          await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'FAILED',lastError:'Telegram discussion root was not captured; standalone comment was not sent',result:{...result,rootWaits:(result.rootWaits??0)+1}}});
        }
        continue;
      }
      const humanReply=result.discussionMessageId?await prisma.communityManagerDigestMessage.findFirst({where:{communityManagerId:release.communityManagerId,createdAt:{gte:result.publishedAt?new Date(result.publishedAt):release.createdAt},OR:[{replyToMessageId:result.discussionMessageId},{messageThreadId:result.discussionMessageId}],tgUserId:{not:null}},select:{id:true}}):null;
      if(humanReply){await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'CANCELLED',lastError:'Human discussion started'}});continue}
      const location=await createInitiativeLocation({managerId:release.communityManagerId,tgChatId:result.discussionChatId!,telegramRootMessageId:result.discussionMessageId!,topicKey:release.topic??'content_release',origin:'CONTENT',sourcePostId:result.postId});
      await runActivity(release.communityManagerId,'CONTENT_RELEASE',release.topic??undefined,{activityId:release.id,automatic:true,origin:'CONTENT',context:result,reason:'content_silence',postId:result.postId,phase:'release',postText:result.postText,sourceUrl:result.sourceUrl,replyToMessageId:result.discussionMessageId,threadId:location.threadId,segmentId:location.segmentId});
    }catch(error){
      const message=error instanceof Error?error.message:'Content release failed';
      await prisma.communityManagerActivity.update({where:{id:release.id},data:{status:'FAILED',lastError:message.slice(0,500),result}});
    }
  }
}
