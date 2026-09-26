// Offline preparation only. No database, Telegram or AI access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { parseArchive, possibleIntro, isThirdPartyIntro } = require('../dist/communityManager/collaber/domain.js');

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node scripts/prepare-collaber-archive.cjs <result.json> <new-output-directory>');
if (fs.existsSync(destination)) throw new Error('Choose a new output directory; existing results are never overwritten.');
const before = fs.statSync(source), bytes = fs.readFileSync(source), raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const after = fs.statSync(source);
assert.equal(before.size, after.size, 'Export is still being written');
assert.equal(before.mtimeMs, after.mtimeMs, 'Export is still being written');
assert.ok(Array.isArray(raw.messages), 'Expected Telegram Desktop messages array');
assert.equal(raw.type, 'private_supergroup', 'Review chat type before deriving its Telegram chat ID');
assert.match(String(raw.id), /^\d+$/);
const chatId = '-100' + raw.id;
const seen = new Set(), messages = [];
for (let i = 0; i < raw.messages.length; i += 40000) {
  const result = parseArchive({ ...raw, messages: raw.messages.slice(i, i + 40000) }, chatId);
  for (const message of result.messages) if (!seen.has(message.id)) { seen.add(message.id); messages.push(message); }
}
messages.sort((a,b) => a.at.localeCompare(b.at) || Number(a.id)-Number(b.id));
const tagged = messages.filter(m => /#(?:интро|intro)(?![\p{L}\p{N}_])/iu.test(m.text));
const candidates = messages.filter(m => possibleIntro(m.text));
const relays = messages.filter(m => isThirdPartyIntro(m.text));
const latest = new Map();
for (const m of tagged) latest.set(m.userId, m);
const cutoff = Date.now() - 90 * 86400000;
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, '.gitignore'), '*\n');
const manifest = [];
function save(name, rows) {
  const data = JSON.stringify({ name: raw.name, chatId, messages: rows });
  const size = Buffer.byteLength(data);
  assert.ok(size < 10 * 1024 * 1024 && rows.length <= 50000);
  const parsed = parseArchive(JSON.parse(data), chatId);
  assert.equal(parsed.messages.length, rows.length);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.messages, rows, 'Normalization must round-trip through production parser');
  fs.writeFileSync(path.join(destination, name), data);
  manifest.push({ name, messages: rows.length, bytes: size, sha256: crypto.createHash('sha256').update(data).digest('hex') });
}
let batch = [], size = 0, part = 1;
for (const message of messages) {
  const length = Buffer.byteLength(JSON.stringify(message)) + 1;
  if (batch.length && (size + length > 8 * 1024 * 1024 || batch.length >= 40000)) {
    save('history-' + String(part++).padStart(2,'0') + '.json', batch); batch = []; size = 0;
  }
  batch.push(message); size += length;
}
if (batch.length) save('history-' + String(part).padStart(2,'0') + '.json', batch);
save('intro-candidates.json', candidates);
const relayIds=new Set(relays.map(m=>m.id));
fs.writeFileSync(path.join(destination,'relay-review.json'),JSON.stringify({chatId,purpose:'Third-party announcements and summaries; do not import as sender profiles',messages:raw.messages.filter(m=>relayIds.has(String(m.id)))},null,2));
// A deterministic, stratified review set. Labels must be assigned by a reviewer,
// never by using these heuristics as ground truth.
const sample = [], picked = new Set();
function take(rows, count, stratum) {
  const pool = rows.filter(m => !picked.has(m.id));
  for (let i=0; i<Math.min(count,pool.length); i++) {
    const m=pool[Math.floor(i*pool.length/Math.min(count,pool.length))];
    picked.add(m.id); sample.push({ ...m, stratum, expectedFacts: null });
  }
}
for (const year of ['2024','2025','2026']) take(tagged.filter(m => m.at.startsWith(year)),10,'tagged-'+year);
take(candidates.filter(m => !/#(?:интро|intro)/iu.test(m.text)),10,'heuristic-without-tag');
take(messages.filter(m => !possibleIntro(m.text) && m.text.length>=120),10,'negative-and-missed-intro-check');
fs.writeFileSync(path.join(destination,'review-50.json'), JSON.stringify({ chatId, purpose:'Manual labels required; not an import file', samples:sample },null,2));
const years={};for(const m of tagged)years[m.at.slice(0,4)]=(years[m.at.slice(0,4)]??0)+1;
const summary = {
  preparedAt:new Date().toISOString(),source:path.resolve(source),sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
  sourceBytes:bytes.length,chatName:raw.name,chatId,firstDate:raw.messages[0]?.date,lastDate:raw.messages.at(-1)?.date,
  totalRecords:raw.messages.length,eligibleTextMessages:messages.length,skippedRecords:raw.messages.length-messages.length,
  taggedMessages:tagged.length,taggedAuthors:latest.size,taggedByYear:years,thirdPartyAnnouncements:relays.length,
  latestTaggedIntroWithin90Days:[...latest.values()].filter(m=>Date.parse(m.at)>=cutoff).length,
  heuristicCandidates:candidates.length,heuristicAuthors:new Set(candidates.map(m=>m.userId)).size,
  heuristicCandidatesWithin90Days:candidates.filter(m=>Date.parse(m.at)>=cutoff).length,
  normalizedMessagesWithUsername:messages.filter(m=>m.username).length,manualReviewSize:sample.length,files:manifest,
  notes:['Candidates are messages to review, not verified intros or profiles.','No AI, DB import, Telegram membership check, or message delivery has run.','history files and intro-candidates are alternative import sets; do not load both.','Normalized files omit service events, forwarded/empty/invalid messages and follow existing parser text limit (12000 characters). Original is untouched.']
};
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
