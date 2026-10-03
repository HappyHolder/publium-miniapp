import assert from 'node:assert/strict';
import { test } from 'node:test';
import { membershipReaderToken } from './membership';

test('ordinary shared CM delegates membership reads to this community moderator',async()=>{
  const calls: Array<[string,number,string]> = [];
  const token=await membershipReaderToken('community-a','-10042','100:cm',{
    getMember:async(chat,user,token)=>{calls.push([chat,user,token]);return{status:user===200?'administrator':'member',user:{id:user,is_bot:true,first_name:'bot'}}},
    moderatorToken:async community=>{assert.equal(community,'community-a');return '200:moderator'},
  });
  assert.equal(token,'200:moderator');assert.deepEqual(calls,[['-10042',100,'100:cm'],['-10042',200,'200:moderator']]);
});
test('administrator CM reads membership without loading another bot',async()=>{
  const token=await membershipReaderToken('community-a','-10042','100:cm',{
    getMember:async(_chat,user)=>({status:'administrator',user:{id:user,is_bot:true,first_name:'bot'}}),
    moderatorToken:async()=>{throw Error('Must not query moderator')},
  });
  assert.equal(token,'100:cm');
});
test('membership fails closed when neither bot has administrator access',async()=>{
  await assert.rejects(membershipReaderToken('community-a','-10042','100:cm',{
    getMember:async(_chat,user)=>({status:'member',user:{id:user,is_bot:true,first_name:'bot'}}),
    moderatorToken:async()=> '200:moderator',
  }),/подтвердить участников/);
});
test('a wrong identity or inaccessible moderator never proves membership',async()=>{
  await assert.rejects(membershipReaderToken('community-a','-10042','100:cm',{
    getMember:async()=>({status:'administrator',user:{id:999,is_bot:true,first_name:'wrong'}}),
    moderatorToken:async()=>{throw Error('inactive custom moderator')},
  }),/подтвердить участников/);
});

test('custom non-admin moderator falls back to shared moderator verified in the same group',async()=>{
  const calls:Array<[string,number]>=[];
  const token=await membershipReaderToken('community-a','-10042','100:cm',{
    getMember:async(chat,user)=>{calls.push([chat,user]);return{status:user===300?'administrator':'member',user:{id:user,is_bot:true,first_name:'bot'}}},
    moderatorToken:async()=> '200:custom',sharedModeratorToken:()=> '300:shared',
  });
  assert.equal(token,'300:shared');assert.deepEqual(calls,[['-10042',100],['-10042',200],['-10042',300]]);
});

test('shared fallback cannot bypass missing admin rights or a mismatched bot identity',async()=>{
  for(const shared of [{status:'member',id:300},{status:'administrator',id:999}] as const){
    await assert.rejects(membershipReaderToken('community-a','-10042','100:cm',{
      getMember:async(_chat,user)=>({status:user===300?shared.status:'member',user:{id:user===300?shared.id:user,is_bot:true,first_name:'bot'}}),
      moderatorToken:async()=> '200:custom',sharedModeratorToken:()=> '300:shared',
    }),/подтвердить участников/);
  }
});
