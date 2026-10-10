import { Router } from 'express';
import {
  parseMultipartImage,
  saveUploadedImage,
} from '../lib/image-upload';
import { getAuth, requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { logger } from '../logger';

export const adminUploadsRouter = Router();

/**
 * POST /api/admin/uploads — store a product image on the local disk.
 *
 * Development-only storage: files land in `UPLOAD_DIR` (default `uploads/`,
 * git-ignored) and are served from `GET /uploads/<file>`. The response's
 * `imageUrl` is what the admin site sends to `POST/PATCH /api/admin/products`;
 * only the URL string is written to Firestore, never the bytes.
 *
 * Limits: JPEG/PNG/WebP only (detected from magic bytes), max
 * `UPLOAD_MAX_BYTES` (default 5 MB), one file, no other form fields,
 * 30 requests/min/IP. The multipart parsing and validation are shared with
 * the customer-facing upload endpoints in `lib/image-upload.ts`.
 */
adminUploadsRouter.post(
  '/',
  rateLimit({ name: 'admin-uploads', limit: 30, windowMs: 60_000 }),
  requireAuth,
  requireAdmin,
  parseMultipartImage,
  asyncHandler(async (req, res) => {
    const saved = saveUploadedImage(req.file);
    logger.info('Product image uploaded.', {
      uid: getAuth(req).uid,
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      size: saved.size,
    });

    res.status(201).json({
      imageUrl: saved.publicUrl,
      path: saved.relativeUrl,
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      size: saved.size,
      uploadedAt: new Date().toISOString(),
    });
  })
);
