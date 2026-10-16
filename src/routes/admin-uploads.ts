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
 * POST /api/admin/uploads — store a product image in Cloudinary.
 *
 * Cloudinary storage (server-side only): validated images are uploaded with
 * the official Cloudinary SDK and the HTTPS `secure_url` is returned as
 * `imageUrl`. The response's `imageUrl` is what the admin site sends to
 * `POST/PATCH /api/admin/products`; only the URL string (plus the optional
 * `publicId`/`cloudinaryPublicId`) is written to Firestore, never the bytes.
 * Credentials (`CLOUDINARY_*`) never leave the backend.
 *
 * Limits: JPEG/PNG/WebP only (detected from magic bytes), max
 * `UPLOAD_MAX_BYTES` (default 5 MB), one file, no other form fields,
 * 30 requests/min/IP. Missing Cloudinary configuration → `503
 * server_not_configured`; Cloudinary failure → `500 upload_failed`.
 * The multipart parsing and validation are shared with the customer-facing
 * upload endpoints in `lib/image-upload.ts`.
 */
adminUploadsRouter.post(
  '/',
  rateLimit({ name: 'admin-uploads', limit: 30, windowMs: 60_000 }),
  requireAuth,
  requireAdmin,
  parseMultipartImage,
  asyncHandler(async (req, res) => {
    const saved = await saveUploadedImage(req.file);
    logger.info('Product image uploaded to Cloudinary.', {
      uid: getAuth(req).uid,
      publicId: saved.publicId,
      mimeType: saved.mimeType,
      size: saved.size,
    });

    res.status(201).json({
      imageUrl: saved.publicUrl,
      publicId: saved.publicId,
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      size: saved.size,
      uploadedAt: new Date().toISOString(),
    });
  })
);
