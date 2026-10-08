import { prisma } from '../../db';
import { groupMessageLink } from '../messageLinks';
import { factsOf } from './domain';

type ProfileSource={id:string;tgUserId:string;sourceMessageId:number|null;sourceText:string;facts:unknown;reviewedAt?:Date|null};
/** A private /edit message ID must never be turned into a group permalink. */
export async function profileIntroLinks(managerId:string,chatId:string,profiles:ProfileSource[]):Promise<Map<string,string>> {
  const ids=profiles.flatMap(p=>p.sourceMessageId?[p.sourceMessageId]:[]);
  if(!ids.length)return new Map();
  const [messages,digest,consents]=await Promise.all([
    prisma.communityManagerMessage.findMany({where:{communityManagerId:managerId,tgChatId:chatId,telegramMessageId:{in:ids}},select:{telegramMessageId:true,tgUserId:true,text:true}}),
    prisma.communityManagerDigestMessage.findMany({where:{communityManagerId:managerId,telegramMessageId:{in:ids}},select:{telegramMessageId:true,tgUserId:true,text:true}}),
    // Consent records survive conversation retention and prove a live group intro.
    prisma.collaberTask.findMany({where:{communityManagerId:managerId,manager:{community:{moderatorChat:{tgChatId:chatId}}},kind:'CONSENT',status:{in:['WAITING','COMPLETED']},dedupeKey:{in:profiles.map(p=>'consent:'+managerId+':'+p.tgUserId)}},select:{payload:true}}),
  ]);
  const links=new Map<string,string>();
  for(const p of profiles){
    const consentProof=p.reviewedAt===null&&consents.some(c=>{
      const s=c.payload as {userId?:string;sourceMessageId?:number;sourceChatId?:string};
      return s.userId===p.tgUserId&&s.sourceMessageId===p.sourceMessageId&&(!s.sourceChatId||s.sourceChatId===chatId);
    });
    const proven=consentProof||factsOf(p.facts).some(f=>f.sourceChatId===chatId&&f.sourceMessageId===String(p.sourceMessageId)&&p.sourceText.includes(f.evidence))||[...messages,...digest].some(m=>m.telegramMessageId===p.sourceMessageId&&m.tgUserId===p.tgUserId&&m.text===p.sourceText);
    const url=proven?groupMessageLink(chatId,p.sourceMessageId??0):null;
    if(url)links.set(p.id,url);
  }
  return links;
}
