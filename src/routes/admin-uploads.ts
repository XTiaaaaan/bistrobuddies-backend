import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { config } from '../config';
import { ApiError, badRequest, FieldIssue } from '../errors';
import {
  detectImageType,
  formatMaxUploadSize,
  saveImage,
  SUPPORTED_IMAGE_LABELS,
} from '../lib/uploads';
import { getAuth, requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { logger } from '../logger';

export const adminUploadsRouter = Router();

/** Field name the client must use in the multipart form. */
export const UPLOAD_FIELD_NAME = 'file';

const receiveImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploadMaxBytes,
    files: 1,
    fields: 0,
  },
});

interface MulterLikeError extends Error {
  code?: string;
}

/**
 * Maps multipart-parser failures onto the API error envelope. Anything the
 * client can trigger (oversized file, wrong field, stray form fields) gets a
 * clear 4xx instead of a generic 500.
 */
function mapUploadError(error: unknown): unknown {
  if (error instanceof ApiError) {
    return error;
  }
  const candidate = error as MulterLikeError;
  if (candidate?.name !== 'MulterError' || typeof candidate.code !== 'string') {
    return error;
  }

  const limit = formatMaxUploadSize(config.uploadMaxBytes);
  switch (candidate.code) {
    case 'LIMIT_FILE_SIZE':
      return new ApiError(
        413,
        'file_too_large',
        `The image is larger than the ${limit} upload limit.`,
        [{ field: UPLOAD_FIELD_NAME, message: `Maximum size is ${limit}.` }]
      );
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return badRequest(
        `Send exactly one image in the multipart field named "${UPLOAD_FIELD_NAME}".`,
        [{ field: UPLOAD_FIELD_NAME, message: 'Expected a single image file.' }]
      );
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_PART_COUNT':
      return badRequest(
        `Unexpected form field. Only the "${UPLOAD_FIELD_NAME}" file field is accepted.`
      );
    default:
      return badRequest('The multipart upload could not be read.');
  }
}

/** Parses the multipart body only after authentication succeeded. */
function parseMultipartImage(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  receiveImage.single(UPLOAD_FIELD_NAME)(req, res, (error: unknown) => {
    next(mapUploadError(error));
  });
}

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
 * 30 requests/min/IP.
 */
adminUploadsRouter.post(
  '/',
  rateLimit({ name: 'admin-uploads', limit: 30, windowMs: 60_000 }),
  requireAuth,
  requireAdmin,
  parseMultipartImage,
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw badRequest(
        `Attach the image as multipart/form-data in a field named "${UPLOAD_FIELD_NAME}".`,
        [{ field: UPLOAD_FIELD_NAME, message: 'An image file is required.' }]
      );
    }
    if (file.size === 0) {
      throw badRequest('The uploaded image is empty.', [
        { field: UPLOAD_FIELD_NAME, message: 'The file has no content.' },
      ]);
    }

    const type = detectImageType(file.buffer);
    if (!type) {
      const issues: FieldIssue[] = [
        {
          field: UPLOAD_FIELD_NAME,
          message: `Upload a ${SUPPORTED_IMAGE_LABELS} image (max ${formatMaxUploadSize(config.uploadMaxBytes)}).`,
        },
      ];
      throw new ApiError(
        415,
        'unsupported_media_type',
        `Unsupported image type. Upload a ${SUPPORTED_IMAGE_LABELS} image (max ${formatMaxUploadSize(config.uploadMaxBytes)}).`,
        issues
      );
    }

    const saved = saveImage(file.buffer, type);
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
