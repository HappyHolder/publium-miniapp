import { readObject } from './storage';
import { storageOwner } from './storageContext';
import { assertStyleAccess } from './styleAccess';
import { publicFetch } from './publicFetch';

export async function templateFetch(url: string): Promise<Response> {
  const owner = storageOwner.getStore();
  if (owner) await assertStyleAccess(owner, { url });
  const local = await readObject(url);
  if (local) {
    if (local.length > 2_000_000) throw new Error('Template too large');
    return new Response(new Uint8Array(local), { headers: { 'content-type': 'text/html' } });
  }
  return publicFetch(url, { maxBytes: 2_000_000 });
}
