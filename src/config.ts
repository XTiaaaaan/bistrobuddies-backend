import * as fs from 'node:fs';

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

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4200',
  'http://localhost:8100',
  'capacitor://localhost',
  'https://localhost',
];

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
}

export function loadConfig(): BackendConfig {
  const allowedOrigins = readString('ALLOWED_ORIGINS', '')
    ? readString('ALLOWED_ORIGINS', '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== '')
    : DEFAULT_ALLOWED_ORIGINS;

  return {
    port: readNumber('PORT', 3001),
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
  };
}

export const config: BackendConfig = loadConfig();
