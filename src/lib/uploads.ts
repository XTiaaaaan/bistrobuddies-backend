import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config';

/**
 * Local development image storage helpers.
 *
 * Files are written to a single flat directory (`UPLOAD_DIR`, default
 * `<repo>/uploads`) and served back at `GET /uploads/<file>`. This is
 * **development storage only** — the local disk is not durable, not backed
 * up and not shared between instances, so production must use Firebase
 * Storage instead (not implemented in this repository).
 *
 * Safety rules enforced here:
 * - the client-supplied file name is never used (a fresh UUID name is
 *   generated instead), and
 * - `resolveUploadPath` refuses any name that is not a plain file name
 *   inside the uploads root, so path traversal is impossible even if a
 *   caller later passes a user-provided name.
 */

export interface ImageType {
  /** MIME type detected from the file content (magic bytes). */
  mimeType: string;
  /** Safe extension including the leading dot, e.g. `.png`. */
  extension: string;
}

/** Accepted image kinds — used in error messages and documentation. */
export const SUPPORTED_IMAGE_TYPES: readonly ImageType[] = [
  { mimeType: 'image/jpeg', extension: '.jpg' },
  { mimeType: 'image/png', extension: '.png' },
  { mimeType: 'image/webp', extension: '.webp' },
];

/** Human-readable labels for logs and error messages. */
export const SUPPORTED_IMAGE_LABELS = 'JPEG, PNG or WebP';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => buffer[index] === byte);
}

/**
 * Detects the image type from the file content, never from the client's
 * `Content-Type` header or file name. Returns `null` for anything that is
 * not a supported image (including empty files).
 */
export function detectImageType(buffer: Buffer): ImageType | null {
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [...PNG_SIGNATURE])) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  return null;
}

/** The configured uploads root as an absolute path. */
export function uploadsDir(): string {
  return path.resolve(config.uploadsDir);
}

/** Creates the uploads directory if needed and returns its absolute path. */
export function ensureUploadsDir(): string {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolves a file name inside the uploads root, rejecting anything that
 * would escape it (`../`, absolute paths, separators, empty names).
 * Throws `Error` when the name is unsafe — callers surface that as a 400.
 */
export function resolveUploadPath(fileName: string): string {
  const dir = ensureUploadsDir();
  if (
    fileName === '' ||
    fileName.includes('\0') ||
    fileName !== path.basename(fileName) ||
    fileName === '.' ||
    fileName === '..'
  ) {
    throw new Error('Unsafe upload file name.');
  }
  const resolved = path.resolve(dir, fileName);
  if (resolved !== path.join(dir, fileName)) {
    throw new Error('Upload file name escapes the uploads directory.');
  }
  return resolved;
}

export interface SavedImage {
  /** Generated file name, e.g. `1728000000000-<uuid>.png`. */
  fileName: string;
  /** Backend-relative path, e.g. `/uploads/<fileName>`. */
  relativeUrl: string;
  /** Absolute URL built from `API_BASE_URL`, e.g. `http://localhost:3001/uploads/<fileName>`. */
  publicUrl: string;
  mimeType: string;
  size: number;
  /** Absolute path on disk (never returned to clients). */
  absolutePath: string;
}

/**
 * Writes the image bytes to the uploads directory under a freshly generated
 * unique name. `wx` fails if the name somehow already exists, so a file can
 * never be silently overwritten.
 */
export function saveImage(buffer: Buffer, type: ImageType): SavedImage {
  const fileName = `${Date.now()}-${randomUUID()}${type.extension}`;
  const absolutePath = resolveUploadPath(fileName);
  fs.writeFileSync(absolutePath, buffer, { flag: 'wx', mode: 0o644 });

  const relativeUrl = `/uploads/${fileName}`;
  return {
    fileName,
    relativeUrl,
    publicUrl: `${config.apiBaseUrl}${relativeUrl}`,
    mimeType: type.mimeType,
    size: buffer.length,
    absolutePath,
  };
}

/** Formats the configured upload limit for error messages (e.g. `5 MB`, `1 kB`). */
export function formatMaxUploadSize(bytes: number): string {
  const megabyte = 1024 * 1024;
  if (bytes >= megabyte) {
    const mb = bytes / megabyte;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}
