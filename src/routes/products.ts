import { Router } from 'express';
import { readProductId } from '../lib/validation';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { getProduct, listProducts } from '../services/products.service';

export const productsRouter = Router();

const catalogReadLimit = rateLimit({
  name: 'products-read',
  limit: 120,
  windowMs: 60_000,
});

/**
 * GET /api/products — public product catalog (no authentication required).
 *
 * Returns the standardized product payloads (name, category, description,
 * imageUrl, price, currency, available, createdAt, updatedAt) plus the
 * size-tiered prices the existing clients use for the size selector.
 */
productsRouter.get(
  '/products',
  catalogReadLimit,
  asyncHandler(async (_req, res) => {
    res.json({ products: await listProducts() });
  })
);

/** GET /api/products/:id — one catalog product (no authentication required). */
productsRouter.get(
  '/products/:id',
  catalogReadLimit,
  asyncHandler(async (req, res) => {
    const productId = readProductId(req.params['id'] ?? '');
    res.json(await getProduct(productId));
  })
);
