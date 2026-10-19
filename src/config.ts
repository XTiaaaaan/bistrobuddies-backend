import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Loads `.env` (if present) exactly once, then exposes typed configuration
 * from environment variables. Secret values are never logged.
 *
 * Node >= 20.12 provides `process.loadEnvFile()`; older Node versions are
 * not supported by this backend (see package.json engines).
 */
let envLoaded = false;
function loadEnvOnce(): void {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  try {
    if (fs.existsSync('.env')) {
      process.loadEnvFile('.env');
    }
  } catch {
    // Missing/broken .env is non-fatal: real deployments inject env vars
    // through the hosting provider instead of a file.
  }
}

loadEnvOnce();

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  return value.trim() === '1' || value.trim().toLowerCase() === 'true';
}

/**
 * Origins used by Capacitor native shells (Android uses `https://localhost`,
 * iOS uses `capacitor://localhost`). These are always allowed so setting
 * `ALLOWED_ORIGINS` for production web origins can never lock out the mobile
 * apps. They are exact origins, not wildcards.
 */
const NATIVE_APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4200',
  'http://localhost:8100',
  'http://localhost:8101',
  ...NATIVE_APP_ORIGINS,
];

/**
 * Resolves the CORS allowlist from a raw comma-separated env value.
 * Configured web origins are preserved verbatim (trimmed, deduplicated) and
 * the Capacitor native-app origins are always included.
 */
export function resolveAllowedOrigins(raw: string | undefined): string[] {
  const configured =
    raw !== undefined && raw.trim() !== ''
      ? raw
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== '' && origin !== '*')
      : DEFAULT_ALLOWED_ORIGINS;

  return [...new Set([...configured, ...NATIVE_APP_ORIGINS])];
}

/** Default upload ceiling: 5 MiB per image (see docs/API_CONTRACT.md). */
const DEFAULT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export interface BackendConfig {
  port: number;
  deliveryFee: number;
  firebaseProjectId: string;
  /** Raw service-account JSON provided as an env string (secret). */
  firebaseServiceAccountJson: string | null;
  /** Path to a service-account file (secret location). */
  googleApplicationCredentialsPath: string | null;
  allowedOrigins: string[];
  trustProxy: boolean;
  /**
   * Absolute directory for legacy locally stored images served read-only at
   * `GET /uploads/<file>`. New uploads go to Cloudinary; this directory is
   * only kept so historical local files remain readable. Never used as
   * permanent storage for new uploads.
   */
  uploadsDir: string;
  /**
   * Base URL (no trailing slash) kept for legacy local files and as a
   * fallback. New Cloudinary uploads return an absolute HTTPS `secure_url`
   * and do not use this value.
   */
  apiBaseUrl: string;
  /** Maximum accepted upload size in bytes (default 5 MiB). */
  uploadMaxBytes: number;
  /** Cloudinary cloud name (public identifier, not a secret). */
  cloudinaryCloudName: string | null;
  /** Cloudinary API key (server-side only, never returned to clients). */
  cloudinaryApiKey: string | null;
  /** Cloudinary API secret (server-side only, never returned to clients). */
  cloudinaryApiSecret: string | null;
}

export function loadConfig(): BackendConfig {
  const port = readNumber('PORT', 3001);
  const allowedOrigins = resolveAllowedOrigins(
    process.env['ALLOWED_ORIGINS']
  );
  // Trailing slashes are stripped so `/uploads/<file>` can be appended safely.
  const apiBaseUrl = readString(
    'API_BASE_URL',
    `http://localhost:${port}`
  ).replace(/\/+$/, '');
  const uploadMaxBytes = readNumber(
    'UPLOAD_MAX_BYTES',
    DEFAULT_UPLOAD_MAX_BYTES
  );

  return {
    port,
    deliveryFee: readNumber('DELIVERY_FEE', 0),
    firebaseProjectId: readString(
      'FIREBASE_PROJECT_ID',
      'bistrobuddies-4f179'
    ),
    firebaseServiceAccountJson:
      process.env['FIREBASE_SERVICE_ACCOUNT']?.trim() || null,
    googleApplicationCredentialsPath:
      process.env['GOOGLE_APPLICATION_CREDENTIALS']?.trim() || null,
    allowedOrigins,
    trustProxy: readBoolean('TRUST_PROXY', false),
    // Resolved against the working directory so the value is absolute and
    // never depends on how the process was launched.
    uploadsDir: path.resolve(readString('UPLOAD_DIR', 'uploads')),
    apiBaseUrl,
    uploadMaxBytes: uploadMaxBytes > 0 ? uploadMaxBytes : DEFAULT_UPLOAD_MAX_BYTES,
    cloudinaryCloudName:
      process.env['CLOUDINARY_CLOUD_NAME']?.trim() || null,
    cloudinaryApiKey: process.env['CLOUDINARY_API_KEY']?.trim() || null,
    cloudinaryApiSecret:
      process.env['CLOUDINARY_API_SECRET']?.trim() || null,
  };
}

export const config: BackendConfig = loadConfig();
