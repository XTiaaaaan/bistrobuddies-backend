import { Request, Response, Router } from 'express';
import {
  validateDeviceTokenRegistration,
  validateDeviceTokenRemoval,
} from '../lib/validation';
import { getAuth, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import {
  registerDeviceToken,
  removeDeviceToken,
} from '../services/notifications.service';

export const notificationsRouter = Router();

const deviceLimit = rateLimit({
  name: 'notifications-devices',
  limit: 60,
  windowMs: 60_000,
});

/**
 * POST /api/notifications/devices — register an FCM device token (any
 * authenticated user).
 *
 * Body: `{ "token": "<fcm registration token>", "platform": "android" |
 * "ios" | "web" | "unknown" }`. The owning uid is always taken from the
 * verified Firebase ID token; a user may register multiple devices and
 * re-registering a token simply refreshes it.
 */
notificationsRouter.post(
  '/notifications/devices',
  deviceLimit,
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    const input = validateDeviceTokenRegistration(req.body);
    const result = await registerDeviceToken(user, input);
    res.status(201).json({ id: result.id, platform: result.platform });
  })
);

/**
 * DELETE /api/notifications/devices — remove the caller's device token.
 *
 * Body: `{ "token": "<fcm registration token>" }`. Only the owner can remove
 * a token; a token owned by another user is reported as `removed: false` and
 * left untouched. `POST /api/notifications/devices/remove` is an equivalent
 * alias for clients that cannot send a DELETE body.
 */
async function removeHandler(req: Request, res: Response): Promise<void> {
  const user = getAuth(req);
  const input = validateDeviceTokenRemoval(req.body);
  const result = await removeDeviceToken(user, input.token);
  res.json(result);
}

notificationsRouter.delete(
  '/notifications/devices',
  deviceLimit,
  requireAuth,
  asyncHandler(removeHandler)
);

notificationsRouter.post(
  '/notifications/devices/remove',
  deviceLimit,
  requireAuth,
  asyncHandler(removeHandler)
);
