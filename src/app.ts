import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { config } from './config';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error-handler';
import { adminOrdersRouter } from './routes/admin-orders';
import { adminProductsRouter } from './routes/admin-products';
import { healthRouter } from './routes/health';
import { ordersRouter } from './routes/orders';
import { productsRouter } from './routes/products';

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
  api.use('/admin', adminOrdersRouter);

  app.use('/api', api);
  app.use('/', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
