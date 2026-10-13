// Real PulseTab + real styles; only API responses are fixtures. No production UI route.
import puppeteer from 'puppeteer'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = join(process.cwd(), 'output/pulse-implementation-2026-10-11')
mkdirSync(out, { recursive: true })
const fixture = JSON.parse(readFileSync(join(out, 'report-fixture.json'), 'utf8'))
writeFileSync(join(out, 'ui-harness.html'), `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PulseTab} from '/src/components/community-pulse/PulseTab.tsx';
import '/src/styles/globals.css';
window.Telegram={WebApp:{initData:'pulse-local-fixture'}};
createRoot(document.getElementById('root')).render(React.createElement(PulseTab,{communityId:'fixture'}));
</script></body></html>`)
const port = 4178, base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', browser
server.stdout.on('data', chunk => { logs += chunk })
server.stderr.on('data', chunk => { logs += chunk })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  let ready = false
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) { ready = true; break } } catch {} await sleep(100) }
  assert.ok(ready, 'Vite started')
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.setRequestInterception(true)
  let yearFails = true
  page.on('request', request => {
    void (async () => {
      const url = new URL(request.url())
      if (url.pathname === '/api/auth/moderator-session') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'test', expiresAt: new Date(Date.now() + 3600_000).toISOString() }) })
      if (!url.pathname.endsWith('/pulse')) return request.continue()
      const days = Number(url.searchParams.get('days'))
      if (days === 365 && yearFails) return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Проверка ошибки загрузки' }) })
      const report = structuredClone(fixture)
      report.period.days = days
      if (days === 7) { await sleep(700); report.score = 17 }
      if (days === 90) { report.score = 63; report.axes.climate = null; report.model.status = 'preliminary'; report.model.availableAxes = report.model.availableAxes.filter(k => k !== 'climate'); report.scoreDelta = null }
      if (days === 365) { report.score = null; report.axes = { activity: null, engagement: null, climate: null, growth: null, core: null }; report.model.status = 'insufficient'; report.model.availableAxes = []; report.model.scoredDays = 0; report.scoreDelta = null }
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ report }) })
    })().catch(error => { if (!request.isInterceptResolutionHandled()) void request.abort().catch(() => {}); if (!String(error).includes('Invalid InterceptionId')) errors.push(String(error)) })
  })
  await page.goto(`${base}/output/pulse-implementation-2026-10-11/ui-harness.html`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="pulse-score"]')
  await page.addStyleTag({ content: 'html, body, #root { height: auto !important; overflow: visible !important; }' })
  assert.equal(await page.$eval('[data-testid="pulse-score"]', el => el.textContent), String(fixture.score))
  for (const width of [320, 390, 768]) {
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no overflow at ${width}`)
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.screenshot({ path: join(out, 'pulse-complete.png'), fullPage: true })
  await page.evaluate(() => [...document.querySelectorAll('summary')].find(el => el.textContent.includes('Как получился'))?.click())
  assert.ok(await page.evaluate(() => document.body.innerText.includes('Пульс = 100')))
  const clickPeriod = label => page.evaluate(label => [...document.querySelectorAll('[role="tab"]')].find(el => el.textContent === label)?.click(), label)
  await clickPeriod('Неделя'); await sleep(100); await clickPeriod('Месяц'); await sleep(950)
  assert.equal(await page.$eval('[data-testid="pulse-score"]', el => el.textContent), String(fixture.score), 'late week response cannot overwrite month')
  await clickPeriod('Квартал'); await page.waitForFunction(() => document.body.innerText.includes('Предварительный Пульс'))
  await sleep(250)
  assert.equal(await page.$eval('[data-testid="pulse-score"]', el => el.textContent), '63')
  await page.screenshot({ path: join(out, 'pulse-preliminary.png') })
  await clickPeriod('Год'); await page.waitForSelector('[role="alert"]')
  assert.equal(await page.$('[data-testid="pulse-score"]'), null, 'old score is hidden on fetch error')
  yearFails = false
  await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent.includes('Повторить'))?.click())
  await page.waitForFunction(() => document.body.innerText.includes('Накапливаем данные'))
  assert.equal(await page.$eval('[data-testid="pulse-score"]', el => el.textContent), '—')
  assert.ok(await page.$('svg[aria-label="Радар по пяти осям"]'), 'radar remains present with insufficient data')
  await page.screenshot({ path: join(out, 'pulse-insufficient.png') })
  assert.deepEqual(errors, [])
  console.log('Pulse UI passed: 320/390/768px, complete/preliminary/insufficient, explanations, stale-response protection, error and retry.')
} catch (error) { console.error(logs); throw error }
finally { await browser?.close(); server.kill() }
