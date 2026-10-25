import test from 'node:test';
import assert from 'node:assert/strict';
import {consentProvesGroupSource} from './collaber/sources';
import {parseArchive,validateFacts} from './collaber/domain';

const profile={id:'profile',tgUserId:'42',sourceMessageId:10,sourceText:'Создаю сервис проверки пользователей',facts:[],sourceAt:new Date('2026-10-19T05:00:00Z'),reviewedAt:new Date('2026-10-08T05:00:00Z')};
const consent={userId:'42',sourceMessageId:10,sourceChatId:'-100123'};
test('an older manual review does not hide a newer verified group intro',()=>{
 assert.equal(consentProvesGroupSource(profile,'-100123',consent),true);
 assert.equal(consentProvesGroupSource({...profile,reviewedAt:null},'-100123',{userId:'42',sourceMessageId:10}),true);
});
test('current private edits, other authors, chats and message IDs cannot inherit a group link',()=>{
 for(const reviewedAt of [profile.sourceAt,new Date('2026-10-20')])assert.equal(consentProvesGroupSource({...profile,reviewedAt},'-100123',consent),false);
 assert.equal(consentProvesGroupSource({...profile,sourceAt:undefined},'-100123',consent),false);
 for(const bad of [null,{}, {...consent,userId:'99'},{...consent,sourceMessageId:11},{...consent,sourceChatId:'-100999'}])assert.equal(consentProvesGroupSource(profile,'-100123',bad),false);
});
test('archive scope is stored in facts and cannot be overridden by a message',()=>{
 const raw={chatId:'-100123',messages:[{id:10,userId:'42',text:profile.sourceText,at:profile.sourceAt.toISOString(),sourceChatId:'-100999'}]};
 const message=parseArchive(raw,'-100123').messages[0];
 const [fact]=validateFacts([{kind:'project',value:message.text,evidence:message.text}],message,90);
 assert.equal(message.sourceChatId,'-100123');assert.equal(fact.sourceChatId,'-100123');
 assert.throws(()=>parseArchive(raw,'-100999'),/другому чату/);
});
