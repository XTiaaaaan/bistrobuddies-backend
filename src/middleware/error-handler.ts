import { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError, ServerNotConfiguredError } from '../errors';
import { logger } from '../logger';

/** 404 fallback for unknown API paths. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: 'Endpoint not found.' },
  });
};

interface JsonParseError extends SyntaxError {
  body?: unknown;
}

interface PayloadTooLargeError extends Error {
  type?: string;
}

/**
 * Central error handler. Returns consistent JSON error responses and never
 * exposes stack traces or internal secrets to clients.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error instanceof ServerNotConfiguredError) {
    res.status(503).json({
      error: { code: 'server_not_configured', message: error.message },
    });
    return;
  }

  const maybeParseError = error as JsonParseError;
  if (
    maybeParseError instanceof SyntaxError &&
    maybeParseError.name === 'SyntaxError' &&
    'body' in maybeParseError
  ) {
    res.status(400).json({
      error: { code: 'invalid_json', message: 'Request body is not valid JSON.' },
    });
    return;
  }

  const maybeTooLarge = error as PayloadTooLargeError;
  if (maybeTooLarge.type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'payload_too_large', message: 'Request body is too large.' },
    });
    return;
  }

  logger.error('Unhandled request error.', {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred. Please try again.',
    },
  });
};

/** Wraps async route handlers so rejections reach the error handler. */
export function asyncHandler(
  handler: (req: import('express').Request, res: import('express').Response) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
