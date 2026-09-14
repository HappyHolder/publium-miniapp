import { beginCell } from '@ton/core';
import type { TonConnectUI } from '@tonconnect/ui-react';
import { API_BASE } from './api';
import { getTelegramInitData, getTelegramUserId } from './telegram';

async function request(path: string, body: unknown) {
  const response = await fetch(`${API_BASE}/api/payments${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: getTelegramInitData(), ...body as object }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Ошибка оплаты'), { code: data.code });
  return data;
}

/** A pending order is verified again instead of sending money twice. */
export async function tonCheckout(wallet: TonConnectUI, kind: 'subscription' | 'style', productId: string) {
  const uid = getTelegramUserId();
  if (!uid) throw new Error('Откройте приложение в Telegram.');
  if (!wallet.account) { await wallet.openModal(); throw new Error('Подключите кошелёк и повторите действие.'); }
  const key = `publium-payment:${uid}:${kind}:${productId}`;
  let pending: { orderId: string; senderWallet: string } | null;
  try { pending = JSON.parse(localStorage.getItem(key) ?? 'null'); }
  catch { throw new Error('Не удалось прочитать сохранённый платёж. Обратитесь в поддержку перед новым переводом.'); }
  if (pending && (typeof pending.orderId !== 'string' || typeof pending.senderWallet !== 'string')) throw new Error('Сохранённый платёж повреждён. Обратитесь в поддержку перед новым переводом.');
  if (!pending) {
    const order = await request('/ton/orders', { kind, productId });
    pending = { orderId: order.orderId, senderWallet: wallet.account.address };
    // Persist before opening the wallet: a lost response must not trigger a second transfer.
    localStorage.setItem(key, JSON.stringify(pending));
    try {
      await wallet.sendTransaction({ validUntil: Math.min(Math.floor(Date.now() / 1000) + 600, Math.floor(new Date(order.expiresAt).getTime() / 1000)), messages: [{ address: order.address, amount: order.amountNano, payload: beginCell().storeUint(0, 32).storeStringTail(order.comment).endCell().toBoc().toString('base64') }] });
    } catch (error) {
      if (/reject|cancel|declin/i.test(String(error))) localStorage.removeItem(key);
      throw error;
    }
  }
  try {
    const result = await request(`/ton/orders/${pending.orderId}/verify`, { senderWallet: pending.senderWallet });
    localStorage.removeItem(key);
    return result;
  } catch (error) {
    if ((error as { code?: string }).code === 'ORDER_EXPIRED') localStorage.removeItem(key);
    throw error;
  }
}
