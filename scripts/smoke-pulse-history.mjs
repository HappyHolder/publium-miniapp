import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const out = 'output/pulse-implementation-2026-10-11';
const fixture = JSON.parse(readFileSync(`${out}/transition-fixture.json`, 'utf8'));
fixture.score = 84; fixture.axes = { activity: 22, engagement: 100, climate: 98, growth: 100, core: 100 };
fixture.headline.speakerConversion=395.2;
fixture.headline.churnRate=0;
const harness=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {PulseTab} from '/src/components/community-pulse/PulseTab.tsx';import '/src/styles/globals.css';window.Telegram={WebApp:{initData:'history-fixture'}};createRoot(document.getElementById('root')).render(React.createElement(PulseTab,{communityId:'fixture'}));</script></body></html>`;
writeFileSync(`${out}/history-harness.html`,harness);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4179','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser, mode='history';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4179')).ok)break}catch{}await sleep(100)}
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:390,height:844});
  await page.setRequestInterception(true);
  page.on('request',request=>{void(async()=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/auth/moderator-session')return request.respond({status:200,contentType:'application/json',body:JSON.stringify({token:'test',expiresAt:new Date(Date.now()+3600000).toISOString()})});
    if(!url.pathname.endsWith('/pulse'))return request.continue();
    const days=Number(url.searchParams.get('days'));
    if(mode==='error')return request.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'Проверка ошибки загрузки'})});
    const report=structuredClone(fixture);report.period.days=days;
    if(days===7){await sleep(700);report.score=17}
    if(mode==='unavailable')report.transition={status:'unavailable',primary:'legacy',reason:'Новый расчёт временно недоступен. История сохранена.'};
    if(mode==='old-api')delete report.transition;
    if(mode==='partial'||mode==='complete'){
      const m=report.transition.model;m.score=63;m.status=mode==='partial'?'preliminary':'complete';m.scoredDays=30;m.scoredFrom=report.transition.period.from;
      m.axes={activity:40,engagement:70,climate:mode==='partial'?null:85,growth:50,core:75};m.availableAxes=Object.keys(m.axes).filter(k=>m.axes[k]!=null);
    }
    return request.respond({status:200,contentType:'application/json',body:JSON.stringify({report})});
  })().catch(e=>{if(!request.isInterceptResolutionHandled())void request.abort().catch(()=>{});if(!String(e).includes('Invalid InterceptionId'))errors.push(String(e))})});
  const open=async()=>{
    await page.goto(`http://127.0.0.1:4179/${out}/history-harness.html`,{waitUntil:'networkidle0'});
    await page.waitForSelector('[data-testid="pulse-score"]');
    await page.addStyleTag({content:'html,body,#root{height:auto!important;overflow:visible!important}'});
  };
  await open();
  assert.equal(await page.$eval('[data-testid="pulse-score"]',e=>e.textContent),'84');
  const text=await page.evaluate(()=>document.body.innerText);
  assert.ok(text.includes('По накопленной истории'));assert.ok(text.includes('Что удалось пересчитать из истории'));
  assert.ok(text.includes('Удержание когорт'));assert.ok(text.includes('Когда чат живой'));
  assert.ok(!text.includes('395.2%'));assert.ok(!text.includes('норма <5%'));assert.ok(!text.includes('Наблюдатели'));
  assert.equal(await page.$$eval('[data-testid^="pulse-v2-"]',els=>els.filter(e=>e.tagName==='DETAILS').length),5);
  for(const width of [320,390,768]){await page.setViewport({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`overflow ${width}`)}
  await page.setViewport({width:390,height:844});
  await page.screenshot({path:`${out}/pulse-compatible-history.png`,fullPage:true});
  const clickPeriod=label=>page.evaluate(label=>[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent===label)?.click(),label);
  await clickPeriod('Неделя');await sleep(100);await clickPeriod('Месяц');await sleep(950);
  assert.equal(await page.$eval('[data-testid="pulse-score"]',e=>e.textContent),'84');
  for(const next of ['partial','complete','unavailable','old-api']){
    mode=next;await open();assert.equal(await page.$eval('[data-testid="pulse-score"]',e=>e.textContent),'84');
    assert.ok(await page.evaluate(()=>document.body.innerText.includes('Удержание когорт')));
    if(next==='partial'||next==='complete')assert.equal(await page.$eval('[data-testid="pulse-v2-score"]',e=>e.textContent),'63');
    else assert.equal(await page.$('[data-testid="pulse-v2-score"]'),null);
  }
  mode='error';await clickPeriod('Год');await page.waitForSelector('[role="alert"]');assert.equal(await page.$('[data-testid="pulse-score"]'),null);
  mode='history';await page.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Повторить'))?.click());await page.waitForSelector('[data-testid="pulse-score"]');
  assert.equal(await page.$eval('[data-testid="pulse-score"]',e=>e.textContent),'84');
  assert.deepEqual(errors,[]);
  console.log('Compatible Pulse UI passed: history-only, partial/full v2, preview failure, old API, 320/390/768px, stale responses and retry.');
} finally {await browser?.close();server.kill()}
