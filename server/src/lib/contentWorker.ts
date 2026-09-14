import { randomUUID } from 'node:crypto';
import { refundItem } from './contentPlanQuota';
import { storageOwner } from './storageContext';
/**
 * contentWorker.ts
 *
 * Runs a confirmed ContentPlan: for each item, deep-researches the topic,
 * generates a post (text + cover by the plan's rubric + rich blocks) via
 * createDraftPostForChannel, and schedules it into Отложка at the item's slot.
 *
 * STRICTLY SEQUENTIAL — one item at a time, one plan at a time per process.
 * Cover rendering spins up Chromium/image models that must not run in parallel
 * on the small prod box. A per-process queue + in-flight flag enforce this.
 * A failed item becomes SKIPPED and the plan continues. GENERATING plans are
 * resumed on boot. See docs/content-manager-plan.md.
 */

import { prisma } from '../db';
import { research } from './researchEngine';
import { createDraftPostForChannel } from './draftGenerator';

// ─── Single-flight queue (one plan at a time per process) ────────────────────
const queue: string[] = [];
let processing = false;

/** Enqueues a plan for generation and kicks the queue if idle. */
export function enqueueContentPlan(planId: string): void {
  if (!queue.includes(planId)) queue.push(planId);
  void pump();
}

async function pump(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const planId = queue.shift()!;
      try {
        await runContentPlan(planId);
      } catch (err) {
        console.error(`[contentWorker] plan ${planId} crashed:`, (err as Error).message);
        await prisma.contentPlan.update({
          where: { id: planId },
          data:  { errorMessage: (err as Error).message.slice(0, 500) },
        }).catch(() => {});
      }
    }
  } finally {
    processing = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Loads project-doc text for research grounding (uploads/both sources). */
async function loadPlanDocContext(channelId: string): Promise<string> {
  const docs = await prisma.projectDoc
    .findMany({ where: { channelId }, orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, text: true } })
    .catch(() => []);
  if (docs.length === 0) return '';
  return docs.map(d => `### ${d.name}\n${d.text.slice(0, 2500)}`).join('\n\n').slice(0, 10_000);
}

/** Builds the createDraftPostForChannel `input` from the item + research brief.
 *  Anchors the current date so the post writer uses present-day facts, not its
 *  training-cutoff view (which drifts to 2024/2025). */
function composeInput(workingTitle: string, angle: string, material: string): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const year = today.slice(0, 4);
  const parts = [
    `Сегодня ${today} (текущий год ${year}). Пиши актуальный на сейчас пост — опирайся на свежие факты из материала ниже; НЕ привязывай к ${Number(year) - 1}/${Number(year) - 2} годам и не выдавай устаревшие данные за актуальные.`,
    `Тема поста: ${workingTitle}`,
  ];
  if (angle) parts.push(`Угол подачи: ${angle}`);
  if (material) parts.push(`\nМатериал для поста (факты из ресёрча — используй как фактическую основу, не копируй дословно):\n${material}`);
  return parts.join('\n');
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Generates every not-yet-done item of a plan, sequentially, and marks the plan
 * SCHEDULED on completion (FAILED only if it can't start). Safe to call on a
 * partially-done plan (resume): DONE/SKIPPED items are left untouched.
 */
export async function runContentPlan(planId: string): Promise<void> {
  const leaseOwner = randomUUID();
  const claimed = await prisma.contentPlan.updateMany({ where: { id: planId, status: 'GENERATING', OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseOwner, leaseUntil: new Date(Date.now() + 300_000) } });
  if (!claimed.count) return;
  const timer = setInterval(() => { void prisma.contentPlan.updateMany({ where: { id: planId, leaseOwner }, data: { leaseUntil: new Date(Date.now() + 300_000) } }).catch(error => console.error('[contentWorker] lease renewal failed', error.message)); }, 60_000);
  try { await runClaimedPlan(planId, leaseOwner); }
  finally { clearInterval(timer); await prisma.contentPlan.updateMany({ where: { id: planId, leaseOwner }, data: { leaseUntil: null, leaseOwner: null } }); }
}
async function runClaimedPlan(planId: string, leaseOwner: string): Promise<void> {
  const plan = await prisma.contentPlan.findUnique({
    where:   { id: planId },
    include: { items: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!plan) { console.warn(`[contentWorker] plan ${planId} not found`); return; }
  if (plan.status === 'CANCELLED') return;

  const channel = await prisma.channel.findUnique({
    where: { id: plan.channelId }, select: { userId: true },
  });
  if (!channel) throw new Error('Content plan channel not found');
  const docContext = (plan.source === 'uploads' || plan.source === 'both')
    ? await loadPlanDocContext(plan.channelId)
    : '';

  console.log(`[contentWorker] plan ${planId}: ${plan.items.length} item(s), generateVisuals=${plan.generateVisuals}`);

  for (const item of plan.items) {
    if (item.status === 'DONE' || item.status === 'SKIPPED') continue;

    // Re-check cancellation before each item — cancel just flips the plan status.
    const fresh = await prisma.contentPlan.findUnique({ where: { id: planId } });
    if (fresh?.status !== 'GENERATING' || fresh.leaseOwner !== leaseOwner) return;

    try {
      // 1. Research ------------------------------------------------------------
      await prisma.contentPlanItem.update({ where: { id: item.id }, data: { status: 'RESEARCHING' } });
      const r = await research(item.searchQuery, docContext ? { extraContext: docContext } : {});
      const afterResearch = await prisma.contentPlan.findUnique({ where: { id: planId } });
      if (afterResearch?.status !== 'GENERATING' || afterResearch.leaseOwner !== leaseOwner) return;

      // 2. Generate (text + cover by rubric + rich blocks) ---------------------
      await prisma.contentPlanItem.update({ where: { id: item.id }, data: { status: 'GENERATING' } });
      const draft = await storageOwner.run(channel.userId, () => createDraftPostForChannel({
        channelId:   plan.channelId,
        input:       composeInput(item.workingTitle, item.angle, r.text),
        sourceType:  'plan',
        sourceUrl:   null,
        useBrandKit: true,
        allowHtmlCovers: plan.generateVisuals,
        generateVisual: plan.generateVisuals,
        forcedRubric: item.rubricId ? { id: item.rubricId, name: item.rubricName ?? '' } : undefined,
      }));

      // Lock the same plan row as cancellation. Record the post and item together.
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ContentPlan" WHERE id = ${planId} FOR UPDATE`;
        const current = await tx.contentPlan.findUniqueOrThrow({ where: { id: planId } });
        // A replacement worker owns the item now. Keep this result as a draft.
        if (current.leaseOwner !== leaseOwner) return;
        const canSchedule = current.status === 'GENERATING' && current.leaseOwner === leaseOwner;
        await tx.generatedPost.update({ where: { id: draft.id }, data: { status: canSchedule ? 'SCHEDULED' : 'NEW', scheduledAt: canSchedule ? item.scheduledAt : null, sourceType: 'plan' } });
        if (!canSchedule) await refundItem(tx, item.id, channel.userId);
        await tx.contentPlanItem.update({ where: { id: item.id }, data: { status: canSchedule ? 'DONE' : 'SKIPPED', generatedPostId: draft.id, contentReserved: false, visualReserved: false, errorMessage: canSchedule ? null : 'План отменён; результат сохранён в черновиках.' } });
      });

      console.log(`[contentWorker] plan ${planId} item ${item.orderIndex + 1}/${plan.items.length} → scheduled ${draft.id}`);
    } catch (err) {
      // A single bad item never sinks the plan — mark SKIPPED and move on.
      console.error(`[contentWorker] plan ${planId} item ${item.id} failed:`, (err as Error).message);
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ContentPlan" WHERE id = ${planId} FOR UPDATE`;
        const current = await tx.contentPlan.findUnique({ where: { id: planId } });
        if (current?.leaseOwner !== leaseOwner) return;
        await refundItem(tx, item.id, channel.userId);
        await tx.contentPlanItem.update({ where: { id: item.id }, data: { status: 'SKIPPED', errorMessage: (err as Error).message.slice(0, 500) } });
      });
    }
  }

  // Final cancellation check before flipping to SCHEDULED.
  const done = await prisma.contentPlan.findUnique({ where: { id: planId }, select: { status: true } });
  if (done?.status === 'CANCELLED') return;
  await prisma.contentPlan.updateMany({ where: { id: planId, status: 'GENERATING', leaseOwner }, data: { status: 'SCHEDULED' } });
  console.log(`[contentWorker] plan ${planId} complete → SCHEDULED`);
}

/**
 * On boot, re-enqueue any plans left mid-generation by a restart. Called from
 * the server bootstrap alongside the scheduler.
 */
export async function resumeGeneratingPlans(): Promise<void> {
  const stuck = await prisma.contentPlan
    .findMany({ where: { status: 'GENERATING' }, select: { id: true } })
    .catch(() => []);
  if (stuck.length === 0) return;
  console.log(`[contentWorker] resuming ${stuck.length} interrupted plan(s)`);
  for (const p of stuck) enqueueContentPlan(p.id);
}
