import {
  App,
  AppOptions,
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import { Auth, DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { config } from '../config';
import { ServerNotConfiguredError } from '../errors';
import { logger } from '../logger';

export interface FirebaseRuntime {
  auth: Auth;
  db: Firestore;
}

export type { DecodedIdToken };

let runtime: FirebaseRuntime | null = null;
let initAttempted = false;
let initFailure: string | null = null;

function hasCredentialSource(): boolean {
  return Boolean(
    config.firebaseServiceAccountJson ||
      config.googleApplicationCredentialsPath
  );
}

function ensureInitialized(): FirebaseRuntime | null {
  if (runtime) {
    return runtime;
  }
  if (initAttempted) {
    return null;
  }
  initAttempted = true;

  if (!hasCredentialSource()) {
    initFailure = 'no_credentials_source';
    logger.warn(
      'Firebase Admin credentials not configured; privileged endpoints will return 503.'
    );
    return null;
  }

  try {
    const existing = getApps();
    let app: App | undefined = existing[0];
    if (!app) {
      const options: AppOptions = {
        projectId: config.firebaseProjectId,
      };
      if (config.firebaseServiceAccountJson) {
        const serviceAccount = JSON.parse(config.firebaseServiceAccountJson) as {
          project_id?: string;
        };
        if (
          serviceAccount.project_id &&
          serviceAccount.project_id !== config.firebaseProjectId
        ) {
          logger.warn(
            'Service account project_id differs from FIREBASE_PROJECT_ID.',
            {
              serviceAccountProject: serviceAccount.project_id,
              configuredProject: config.firebaseProjectId,
            }
          );
        }
        options.credential = cert(JSON.parse(config.firebaseServiceAccountJson));
      } else {
        options.credential = applicationDefault();
      }
      app = initializeApp(options);
    }
    runtime = { auth: getAuth(app), db: getFirestore(app) };
    initFailure = null;
    logger.info('Firebase Admin initialized.', {
      projectId: config.firebaseProjectId,
    });
    return runtime;
  } catch (error) {
    initFailure = error instanceof Error ? error.message : 'init_failed';
    logger.error('Firebase Admin initialization failed.', { reason: initFailure });
    return null;
  }
}

/** True when a credential source is present (used by the health endpoint). */
export function firebaseReady(): boolean {
  return ensureInitialized() !== null;
}

/** Returns the Firebase Admin runtime or throws ServerNotConfiguredError. */
export function requireFirebase(): FirebaseRuntime {
  const resolved = ensureInitialized();
  if (!resolved) {
    throw new ServerNotConfiguredError(
      initFailure === 'no_credentials_source'
        ? 'Server credentials are not configured (set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT).'
        : 'Server credentials could not be loaded.'
    );
  }
  return resolved;
}

/** Test hook: forget any previous initialization state. */
export function resetFirebaseForTests(): void {
  runtime = null;
  initAttempted = false;
  initFailure = null;
}
