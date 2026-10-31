import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRouteGroupSearch, parseCollaborationRoute, explicitCollaborationSearch } from './collaber/routing';

test('group routing requires direct address, enabled feature and autopilot',()=>{
 const eligible={enabled:true,onDemand:true,autopilot:true,addressedToManager:true,addressedToOtherHuman:false,userId:'42',text:'Есть проекты с проверкой человечности?'};
 assert.equal(canRouteGroupSearch(eligible),true);
 for(const key of ['enabled','onDemand','autopilot','addressedToManager'])assert.equal(canRouteGroupSearch({...eligible,[key]:false}),false);
 assert.equal(canRouteGroupSearch({...eligible,addressedToOtherHuman:true}),false);
 assert.equal(canRouteGroupSearch({...eligible,userId:null}),false);
 assert.equal(canRouteGroupSearch({...eligible,text:'#intro Я разрабатываю приложения и ищу партнёров'}),false);
 assert.equal(canRouteGroupSearch({...eligible,text:'Привет! #интро Мой проект ищет разработчика'}),false);
});

test('invalid routing cannot silently fall back to a conversational answer',()=>{
 assert.deepEqual(parseCollaborationRoute({kind:'SEARCH',query:' Сервис верификации пользователей '}),{kind:'SEARCH',query:'Сервис верификации пользователей'});
 assert.deepEqual(parseCollaborationRoute({kind:'NONE',query:'ignored'}),{kind:'NONE',query:''});
 assert.deepEqual(parseCollaborationRoute({kind:'CLARIFY',query:''}),{kind:'CLARIFY',query:''});
 for(const raw of [null,{}, {kind:'OTHER',query:''},{kind:'SEARCH',query:''},{kind:'SEARCH',query:'x'.repeat(501)}])assert.throws(()=>parseCollaborationRoute(raw));
});

test('an explicit search can address the community without a bot mention or a detailed brief',()=>{
 const eligible={enabled:true,onDemand:true,autopilot:true,addressedToManager:false,addressedToOtherHuman:false,userId:'42',text:'Ищу разработчика'};
 for(const text of ['Ищу разработчика','Ищу разработчика по созданию мини-приложения','Ищу маркетолога','Looking for a Mini App developer']){
  assert.equal(explicitCollaborationSearch(text),true);assert.equal(canRouteGroupSearch({...eligible,text}),true);
 }
 assert.equal(canRouteGroupSearch({...eligible,addressedToOtherHuman:true}),false);
 for(const key of ['enabled','onDemand','autopilot'])assert.equal(canRouteGroupSearch({...eligible,[key]:false}),false);
 for(const text of ['#intro Ищу разработчика для проекта','Привет! Я разработчик и ищу партнёров','Как работает Telegram Mini App?'])assert.equal(explicitCollaborationSearch(text),false);
});
