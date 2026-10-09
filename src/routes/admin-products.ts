import { Router } from 'express';
import { readProductId, validateProductInput } from '../lib/validation';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import {
  createProduct,
  deleteProduct,
  updateProduct,
} from '../services/products.service';

export const adminProductsRouter = Router();

const adminGuard = [
  rateLimit({ name: 'admin-products', limit: 60, windowMs: 60_000 }),
  requireAuth,
  requireAdmin,
];

/** POST /api/admin/products — create a product (admin only). */
adminProductsRouter.post(
  '/',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const input = validateProductInput(req.body, { partial: false });
    const created = await createProduct(input);
    res.status(201).json(created);
  })
);

/** PATCH /api/admin/products/:id — update a product (admin only). */
adminProductsRouter.patch(
  '/:id',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const productId = readProductId(req.params['id'] ?? '');
    const input = validateProductInput(req.body, { partial: true });
    const updated = await updateProduct(productId, input);
    res.json(updated);
  })
);

/** DELETE /api/admin/products/:id — delete a product (admin only). */
adminProductsRouter.delete(
  '/:id',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const productId = readProductId(req.params['id'] ?? '');
    const deleted = await deleteProduct(productId);
    res.json(deleted);
  })
);
