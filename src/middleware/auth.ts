import { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../errors';
import { DecodedIdToken, requireFirebase } from '../firebase/admin';

export interface AuthUser {
  uid: string;
  email: string | null;
  name: string | null;
}

export interface AuthedRequest extends Request {
  auth?: AuthUser;
}

/**
 * Verifies the Firebase ID token sent as `Authorization: Bearer <token>`
 * and attaches the verified identity to the request. Identity always comes
 * from the verified token — never from the request body.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing Bearer authentication token.');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw unauthorized('Missing Bearer authentication token.');
    }

    const { auth } = requireFirebase();
    let decoded: DecodedIdToken;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      // Expired/invalid/tampered tokens are all authentication failures.
      throw unauthorized('The authentication token is invalid or expired.');
    }

    (req as AuthedRequest).auth = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Reads the caller's role from Firestore. Shared by requireAdmin and by
 * handlers that grant admin-only read access (e.g. order ownership checks).
 */
export async function hasAdminRole(uid: string): Promise<boolean> {
  const { db } = requireFirebase();
  const snapshot = await db.doc(`users/${uid}`).get();
  const role = snapshot.exists
    ? (snapshot.data()?.['role'] as unknown)
    : undefined;
  return role === 'admin';
}

/**
 * Requires the authenticated user's Firestore profile to have role = 'admin'.
 * The role is read server-side from the `users` collection on every request;
 * frontend flags, local storage or route hiding are never consulted.
 */
export async function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = getAuth(req);
    if (!(await hasAdminRole(user.uid))) {
      throw forbidden('Administrator privileges are required.');
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Returns the verified auth user attached by requireAuth. */
export function getAuth(req: Request): AuthUser {
  const user = (req as AuthedRequest).auth;
  if (!user) {
    throw unauthorized();
  }
  return user;
}
