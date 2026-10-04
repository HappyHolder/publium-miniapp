import { prisma } from '../../db';
import { groupMessageLink } from '../messageLinks';
import { factsOf } from './domain';

type ProfileSource={id:string;tgUserId:string;sourceMessageId:number|null;sourceText:string;facts:unknown};
/** A private /edit message ID must never be turned into a group permalink. */
export async function profileIntroLinks(managerId:string,chatId:string,profiles:ProfileSource[]):Promise<Map<string,string>> {
  const ids=profiles.flatMap(p=>p.sourceMessageId?[p.sourceMessageId]:[]);
  if(!ids.length)return new Map();
  const [messages,digest]=await Promise.all([
    prisma.communityManagerMessage.findMany({where:{communityManagerId:managerId,tgChatId:chatId,telegramMessageId:{in:ids}},select:{telegramMessageId:true,tgUserId:true,text:true}}),
    prisma.communityManagerDigestMessage.findMany({where:{communityManagerId:managerId,telegramMessageId:{in:ids}},select:{telegramMessageId:true,tgUserId:true,text:true}}),
  ]);
  const links=new Map<string,string>();
  for(const p of profiles){
    const proven=factsOf(p.facts).some(f=>f.sourceChatId===chatId&&f.sourceMessageId===String(p.sourceMessageId)&&p.sourceText.includes(f.evidence))||[...messages,...digest].some(m=>m.telegramMessageId===p.sourceMessageId&&m.tgUserId===p.tgUserId&&m.text===p.sourceText);
    const url=proven?groupMessageLink(chatId,p.sourceMessageId??0):null;
    if(url)links.set(p.id,url);
  }
  return links;
}
