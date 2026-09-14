// TON deposit verification via TON Center API v3.
//
// TON Connect returns a BOC, not a simple hash. Instead of parsing it, we query
// recent incoming transactions to our receiving wallet and match one by:
//   - source  = sender's wallet
//   - value   >= expected amount
//   - recency = within MATCH_WINDOW_SEC
//   - hash    not already credited (caller checks the DB)
// Retries to allow for TON confirmation time (~5-15s).

const TONCENTER_BASE   = 'https://toncenter.com/api/v3';
const MATCH_WINDOW_SEC = 600;   // 10 minutes
const RETRY_COUNT      = 8;   // extra headroom: TonCenter 429s + indexing delay
const RETRY_DELAY_MS   = 4_000;

/** Decode a user-friendly TON address (UQ…/EQ…) to raw "workchain:hexhash". */
export function friendlyToRaw(addr: string): string | null {
  if (!addr || typeof addr !== 'string') return null;
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(addr.trim())) return addr.trim().toLowerCase();
  try {
    const b64 = addr.trim().replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 36) return null;
    const workchain = buf[1] === 0xff ? -1 : buf[1];
    const hash = buf.slice(2, 34).toString('hex');
    return `${workchain}:${hash}`;
  } catch {
    return null;
  }
}

export function addressesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const rawA = friendlyToRaw(a) || a.toLowerCase().replace(/\s/g, '');
  const rawB = friendlyToRaw(b) || b.toLowerCase().replace(/\s/g, '');
  return rawA === rawB;
}

interface TonInMsg {
  source?: string;
  value?: string;
  comment?: string;
  decoded_body?: { comment?: string };
  message_content?: { decoded?: { type?: string; comment?: string } };
}
interface TonTx { now?: number; hash?: string; in_msg?: TonInMsg; }

/** Reads the text comment attached to an incoming message, across TonCenter shapes. */
function extractComment(inMsg: TonInMsg): string | null {
  const c =
    inMsg.message_content?.decoded?.comment ??
    inMsg.decoded_body?.comment ??
    inMsg.comment ??
    null;
  return c ? c.trim() : null;
}

export interface VerifyResult {
  ok: boolean;
  txHash?: string;
  actualTon?: number;
  error?: string;
  hint?: string;
}

/**
 * Finds a recent incoming TON payment to `receivingWallet` from `senderWallet`
 * worth at least `expectedTon`. Returns the matching tx hash. The caller must
 * ensure the hash hasn't been credited before (double-spend protection).
 */
export async function verifyTonDeposit(opts: {
  expectedTon: number;
  senderWallet: string;
  receivingWallet: string;
  apiKey: string;
  isHashUsed: (hash: string) => Promise<boolean>;
  /**
   * Required text comment identifying the paying user (their Telegram id). Binds
   * the on-chain deposit to a specific account so an attacker cannot claim
   * someone else's incoming transaction by supplying their wallet address.
   */
  expectedComment?: string;
  fromDate?: Date;
  untilDate?: Date;
}): Promise<VerifyResult> {
  const { expectedTon, senderWallet, receivingWallet, apiKey, isHashUsed, expectedComment } = opts;
  const expectedNano = BigInt(Math.round(expectedTon * 1e9));
  const since = opts.fromDate ? Math.floor(opts.fromDate.getTime() / 1000) - 30 : Math.floor(Date.now() / 1000) - MATCH_WINDOW_SEC;
  const until = opts.untilDate ? Math.floor(opts.untilDate.getTime() / 1000) : Infinity;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const url =
        `${TONCENTER_BASE}/transactions` +
        `?account=${encodeURIComponent(receivingWallet)}` +
        `&start_utime=${since}&end_utime=${Number.isFinite(until) ? until : Math.floor(Date.now() / 1000)}&limit=1000&sort=desc` +
        `&api_key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        // 429 (rate limit) / transient 5xx — retry within the window rather than
        // failing instantly, so a momentary TonCenter limit doesn't lose a real payment.
        console.warn(`[tonVerify] attempt ${attempt}/${RETRY_COUNT}: TonCenter HTTP ${res.status}`);
        if (attempt < RETRY_COUNT) { await new Promise(r => setTimeout(r, RETRY_DELAY_MS)); continue; }
        return { ok: false, error: 'toncenter_api_error', hint: `HTTP ${res.status}` };
      }
      const data = await res.json() as { transactions?: TonTx[] };
      const txs = Array.isArray(data.transactions) ? data.transactions : [];

      for (const tx of txs) {
        if ((tx.now || 0) < since || (tx.now || 0) > until) continue;
        const inMsg = tx.in_msg;
        if (!inMsg) continue;
        if (!addressesMatch(inMsg.source ?? '', senderWallet)) continue;
        if (BigInt(inMsg.value || '0') < expectedNano) continue;
        // Bind the deposit to the paying user: the transfer must carry their
        // Telegram id as a text comment, otherwise it is not their payment.
        if (expectedComment && extractComment(inMsg) !== expectedComment) continue;
        const txHash = tx.hash ? Buffer.from(tx.hash.replace(/-/g, '+').replace(/_/g, '/'), /^[a-f0-9]{64}$/i.test(tx.hash) ? 'hex' : 'base64').toString('hex') : null;
        if (!txHash || !/^[a-f0-9]{64}$/.test(txHash)) continue;
        if (await isHashUsed(txHash)) continue;
        return { ok: true, txHash, actualTon: Number(BigInt(inMsg.value || '0')) / 1e9 };
      }

      if (attempt < RETRY_COUNT) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        return { ok: false, error: 'toncenter_timeout', hint: 'TON Center did not respond in 15s.' };
      }
      return { ok: false, error: 'verification_error', hint: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    error: 'transaction_not_found',
    hint: `No matching transaction from your wallet in the last ${MATCH_WINDOW_SEC / 60} min. Make sure you sent at least ${expectedTon} TON.`,
  };
}
