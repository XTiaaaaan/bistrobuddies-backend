import { v2 as cloudinary } from 'cloudinary';
import { ApiError, ServerNotConfiguredError } from '../errors';
import { ImageType } from './uploads';

/**
 * Cloudinary image storage (server-side only).
 *
 * All Cloudinary credentials (`CLOUDINARY_CLOUD_NAME`,
 * `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`) stay on the backend — they
 * are read from environment variables and are never returned to clients.
 * Uploads use the official `cloudinary` Node.js SDK with a signed
 * server-side call, so the secret never leaves this process.
 *
 * Behaviour:
 * - New product/profile images are uploaded to Cloudinary and the HTTPS
 *   `secure_url` is returned as `imageUrl`.
 * - The local `uploads/` directory is NOT used for new uploads (it is not
 *   durable on hosts like Render). It is still served read-only at
 *   `GET /uploads/<file>` so historical local files remain readable.
 * - There is no development fallback to local disk: the existing
 *   configuration has no reliable development-vs-production signal
 *   (no `NODE_ENV`/`RENDER` handling), so silently falling back in
 *   production would risk pretending an upload succeeded while storing it
 *   ephemerally. When Cloudinary is not configured every upload fails with
 *   `503 server_not_configured`.
 */

export interface CloudinaryUploadResult {
  /** HTTPS URL of the stored image (`secure_url`). Returned as `imageUrl`. */
  secureUrl: string;
  /** Cloudinary `public_id` (stable identifier, no secrets). */
  publicId: string;
  mimeType: string;
  size: number;
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : null;
}

/**
 * Live env check (reads `process.env` on every call, not the cached config
 * snapshot) so hosting-provided variables and tests can toggle configuration
 * at runtime without a restart.
 */
export function isCloudinaryConfigured(): boolean {
  return (
    readEnv('CLOUDINARY_CLOUD_NAME') !== null &&
    readEnv('CLOUDINARY_API_KEY') !== null &&
    readEnv('CLOUDINARY_API_SECRET') !== null
  );
}

function cloudinaryCredentials(): {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
} {
  const cloudName = readEnv('CLOUDINARY_CLOUD_NAME');
  const apiKey = readEnv('CLOUDINARY_API_KEY');
  const apiSecret = readEnv('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) {
    throw new ServerNotConfiguredError(
      'Image storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on the backend.'
    );
  }
  return { cloudName, apiKey, apiSecret };
}

/**
 * Uploads an already-validated image buffer to Cloudinary.
 *
 * The buffer must already have passed magic-byte validation
 * (`detectImageType`) and the size cap — this function only stores it.
 * Throws `ServerNotConfiguredError` (→ 503) when credentials are missing
 * and `ApiError` 500 `upload_failed` when Cloudinary rejects the upload.
 * Never resolves with a local path — callers must not fall back to disk.
 */
export async function uploadToCloudinary(
  buffer: Buffer,
  type: ImageType
): Promise<CloudinaryUploadResult> {
  const { cloudName, apiKey, apiSecret } = cloudinaryCredentials();

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  const dataUri = `data:${type.mimeType};base64,${buffer.toString('base64')}`;

  let remote: { secure_url?: string; public_id?: string };
  try {
    remote = (await cloudinary.uploader.upload(dataUri, {
      folder: 'bistrobuddies',
      resource_type: 'image',
    })) as { secure_url?: string; public_id?: string };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new ApiError(
      500,
      'upload_failed',
      `Image upload failed (${reason}). Please try again.`
    );
  }

  if (!remote?.secure_url || !remote.public_id) {
    throw new ApiError(
      500,
      'upload_failed',
      'Image upload failed. Please try again.'
    );
  }

  return {
    secureUrl: remote.secure_url,
    publicId: remote.public_id,
    mimeType: type.mimeType,
    size: buffer.length,
  };
}
