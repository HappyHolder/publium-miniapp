import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    // Lightweight DB connectivity check — no table dependency
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      ok: true,
      service: 'publium-api',
      db: 'connected',
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      service: 'publium-api',
      db: 'disconnected',
    });
  }
});

export default router;
