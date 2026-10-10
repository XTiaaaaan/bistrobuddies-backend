import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { ensureUploadsDir } from './lib/uploads';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error-handler';
import { logger } from './logger';
import { adminOrdersRouter } from './routes/admin-orders';
import { adminProductsRouter } from './routes/admin-products';
import { adminUploadsRouter } from './routes/admin-uploads';
import { healthRouter } from './routes/health';
import { ordersRouter } from './routes/orders';
import { productsRouter } from './routes/products';
import { profileUploadsRouter } from './routes/profile-uploads';

/**
 * Builds the Express application.
 *
 * Routes are mounted both under `/api` (documented canonical paths) and at
 * the root, so the app behaves identically whether a host forwards the full
 * `/api/...` path (local development) or a stripped path (some serverless
 * configurations). See integration-docs/API_CONTRACT.md.
 */
export function createApp(): Express {
  const app = express();

  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by');

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header = same-origin requests, native apps (Capacitor) or curl.
        if (!origin || config.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(express.json({ limit: '200kb' }));

  const api = express.Router();
  api.use(healthRouter);
  api.use(productsRouter);
  api.use(ordersRouter);
  api.use('/admin/products', adminProductsRouter);
  api.use('/admin/uploads', adminUploadsRouter);
  api.use('/admin', adminOrdersRouter);
  api.use('/profile', profileUploadsRouter);

  app.use('/api', api);
  app.use('/', api);

  // Local development image storage (see docs/API_CONTRACT.md § "Image
  // uploads"). Files live in UPLOAD_DIR and are served read-only at
  // `GET /uploads/<file>`. This is development-only storage: the local disk
  // is not persistent or production-grade — production must use Firebase
  // Storage instead. The CORP header is relaxed for this path so the admin
  // and mobile frontends can embed the images cross-origin; helmet's
  // `same-origin` default would otherwise block them in <img> tags.
  try {
    ensureUploadsDir();
  } catch (error) {
    logger.warn('Uploads directory could not be created; image uploads will fail.', {
      uploadsDir: config.uploadsDir,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  app.use(
    '/uploads',
    express.static(config.uploadsDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '1h',
      setHeaders(res) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
