import { Router } from 'express';
import { firebaseReady } from '../firebase/admin';

export const healthRouter = Router();

/** Liveness/readiness check. No authentication required, no data exposed. */
healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'bistrobuddies-backend',
    firebaseConfigured: firebaseReady(),
    timestamp: new Date().toISOString(),
  });
});
