import { storageOwner } from './storageContext';
import { validateAndParseTelegramInitData } from './telegram';
import { prisma } from '../db';
import { env } from '../env';
import { Router as expressRouter, type RequestHandler } from 'express';

/** Express 4 does not forward rejected handler promises to error middleware. */
export function Router(...args: Parameters<typeof expressRouter>) {
  const router = expressRouter(...args);
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all'] as const) {
    const register = router[method].bind(router) as Function;
    (router as any)[method] = (path: unknown, ...handlers: RequestHandler[]) => register(path, ...handlers.flat(Infinity).map((handler: any) =>
      async (req: any, res: any, next: any) => {
        try {
          if (!req.storageOwnerId && typeof req.body?.initData === 'string') {
            let telegramId: string | undefined;
            try { telegramId = String(validateAndParseTelegramInitData(req.body.initData, env.TELEGRAM_BOT_TOKEN).user.id); } catch { /* route supplies its auth response */ }
            if (telegramId) req.storageOwnerId = (await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }))?.id;
          }
          await storageOwner.run(req.storageOwnerId, () => handler(req, res, next));
        } catch (error) { next(error); }
      }));
  }
  return router;
}
