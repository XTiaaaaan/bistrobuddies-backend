import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Unique name for the limited route group (used in the bucket key). */
  name: string;
  /** Maximum requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

const MAX_TRACKED_KEYS = 5000;

/**
 * Simple fixed-window in-memory rate limiter for sensitive endpoints.
 * Suitable for a single server instance; for multi-instance deployments a
 * shared store would be required (documented as a known limitation).
 */
export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${options.name}:${req.ip ?? 'unknown'}`;

    if (buckets.size > MAX_TRACKED_KEYS) {
      for (const [bucketKey, bucket] of buckets) {
        if (now >= bucket.resetAt) {
          buckets.delete(bucketKey);
        }
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > options.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      next(
        new ApiError(
          429,
          'rate_limited',
          'Too many requests. Please wait and try again.'
        )
      );
      return;
    }

    next();
  };
}
