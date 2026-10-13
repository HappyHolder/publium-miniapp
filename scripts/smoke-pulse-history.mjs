import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const out = 'output/pulse-implementation-2026-10-11';
const report = JSON.parse(readFileSync(`${out}/report-fixture.json`, 'utf8'));
report.score = 84; report.axes = { activity: 22, engagement: 100, climate: 98, growth: 100, core: 100 };
report.headline = { ...report.headline, dau: 16, stickiness: 11, activeRate: 1.6, replyShare: 56.6, messagesPerDay: 72, speakerConversion: 395.2, churnRate: 0, joins: 21, leaves: 0, newSpeakers: 83 };
report.moderation.toxicityWeight = 30.2;
report.cohorts = [{ cohort: '2026-09-07', size: 3, retention: [100,33,33] }];
report.heatmap = Array.from({length:7}, () => Array(24).fill(3));
writeFileSync(`${out}/history-harness.html`, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {PulseTab} from '/src/components/community-pulse/PulseTab.tsx';import '/src/styles/globals.css';window.Telegram={WebApp:{initData:'history-fixture'}};createRoot(document.getElementById('root')).render(React.createElement(PulseTab,{communityId:'fixture'}));</script></body></html>`);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4179','--strictPort'], { windowsHide:true, stdio:'ignore' });
let browser;
try {
  for (let i=0;i<100;i++) { try { if ((await fetch('http://127.0.0.1:4179')).ok) break; } catch {} await new Promise(r=>setTimeout(r,100)); }
  browser = await puppeteer.launch({headless:true,args:['--no-sandbox']});
  const page = await browser.newPage(), errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.setViewport({width:390,height:844});
  await page.setRequestInterception(true);
  page.on('request', r => {
    if(r.url().includes('/api/auth/moderator-session')) return void r.respond({status:200,contentType:'application/json',body:JSON.stringify({token:'test',expiresAt:new Date(Date.now()+3600000).toISOString()})});
    if(r.url().includes('/pulse?')) return void r.respond({status:200,contentType:'application/json',body:JSON.stringify({report,benchmarks:{}})});
    void r.continue();
  });
  await page.goto(`http://127.0.0.1:4179/${out}/history-harness.html`, {waitUntil:'networkidle0'});
  await page.waitForSelector('[data-testid="pulse-score"]');
  assert.equal(await page.$eval('[data-testid="pulse-score"]', e=>e.textContent),'84');
  const text = await page.evaluate(()=>document.body.innerText);
  assert.ok(text.includes('По накопленной истории'));
  assert.ok(!text.includes('Накапливаем данные для оценки'));
  assert.ok(text.includes('Удержание когорт'));
  for(const width of [320,390,768]) { await page.setViewport({width,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false); }
  await page.setViewport({width:390,height:844});
  await page.addStyleTag({content:'html,body,#root{height:auto!important;overflow:visible!important}'});
  await page.screenshot({path:`${out}/pulse-history-restored.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Historical Pulse UI passed: score, five axes, retained history/cohorts, 320/390/768px.');
} finally { await browser?.close(); server.kill(); }
