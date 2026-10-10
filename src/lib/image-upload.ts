import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { config } from '../config';
import { ApiError, badRequest, FieldIssue } from '../errors';
import {
  detectImageType,
  formatMaxUploadSize,
  saveImage,
  SavedImage,
  SUPPORTED_IMAGE_LABELS,
} from './uploads';

/**
 * Shared multipart image-upload machinery used by every upload endpoint
 * (product images for admins, profile photos for signed-in customers).
 *
 * All of these endpoints share the same contract: `multipart/form-data` with
 * exactly one file field named `file`, JPEG/PNG/WebP only (detected from
 * magic bytes, never from the client's file name or `Content-Type`), at most
 * `UPLOAD_MAX_BYTES`, and no other form fields. See
 * `docs/API_CONTRACT.md` §6.
 */

/** Field name the client must use in the multipart form. */
export const UPLOAD_FIELD_NAME = 'file';

export const receiveImage = multer({
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
export function mapUploadError(error: unknown): unknown {
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
export function parseMultipartImage(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  receiveImage.single(UPLOAD_FIELD_NAME)(req, res, (error: unknown) => {
    next(mapUploadError(error));
  });
}

/**
 * Validates a parsed upload and writes it to the local uploads directory.
 *
 * Throws the API errors the endpoint should answer with:
 * `400 invalid_request` for a missing or empty file and
 * `415 unsupported_media_type` for anything that is not a JPEG/PNG/WebP by
 * content. Oversized files never reach this point — multer rejects them
 * while parsing (413, see {@link mapUploadError}).
 */
export function saveUploadedImage(file: Express.Multer.File | undefined): SavedImage {
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

  return saveImage(file.buffer, type);
}
