export type SanctionTarget = { tgUserId: string; action: 'WARN' | 'MUTE' | 'BAN' };

/** Multi-person conduct events must be reversed per actual recipient, never per trigger author. */
export function sanctionTargets(event: { tgUserId: string | null; action: string | null; metadata: unknown }): SanctionTarget[] {
  const m = event.metadata && typeof event.metadata === 'object' ? event.metadata as Record<string, unknown> : {};
  if (Array.isArray(m['sanctions'])) return m['sanctions'].flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const s = raw as Record<string, unknown>;
    return typeof s['tgUserId'] === 'string' && /^\d+$/.test(s['tgUserId']) && ['WARN', 'MUTE', 'BAN'].includes(String(s['action']))
      ? [{ tgUserId: s['tgUserId'], action: s['action'] as SanctionTarget['action'] }] : [];
  });
  const action = event.action ?? '';
  if (!event.tgUserId || /UNMUTE|UNBAN/.test(action)) return [];
  return /BAN|MUTE|WARN/.test(action) ? [{ tgUserId: event.tgUserId, action: action.includes('BAN') ? 'BAN' : action.includes('MUTE') ? 'MUTE' : 'WARN' }] : [];
}
