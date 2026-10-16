import { Router } from 'express';
import { parseMultipartImage, saveUploadedImage } from '../lib/image-upload';
import { getAuth, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { logger } from '../logger';

export const profileUploadsRouter = Router();

/**
 * POST /api/profile/photo — store the caller's profile picture in Cloudinary
 * (same storage as `POST /api/admin/uploads`, see `docs/API_CONTRACT.md` §6).
 *
 * Any signed-in user may upload their own photo — there is no admin check,
 * because the picture always belongs to the verified token's identity. The
 * endpoint only returns the URL; writing `users/{uid}.photoUrl` stays with
 * the client's Firestore write, so the byte payload never touches Firestore.
 *
 * Limits: JPEG/PNG/WebP only (detected from magic bytes), max
 * `UPLOAD_MAX_BYTES` (default 5 MB), one file, no other form fields,
 * 30 requests/min/IP.
 */
profileUploadsRouter.post(
  '/photo',
  rateLimit({ name: 'profile-photo', limit: 30, windowMs: 60_000 }),
  requireAuth,
  parseMultipartImage,
  asyncHandler(async (req, res) => {
    const saved = await saveUploadedImage(req.file);
    logger.info('Profile photo uploaded to Cloudinary.', {
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
