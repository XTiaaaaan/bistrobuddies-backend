/** Structured API errors. The error handler maps these to HTTP responses. */

export interface FieldIssue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown> | FieldIssue[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised when server-side Firebase credentials are missing or unusable. */
export class ServerNotConfiguredError extends Error {
  constructor(
    message = 'The server is missing Firebase credentials and cannot process this request.'
  ) {
    super(message);
    this.name = 'ServerNotConfiguredError';
  }
}

export function badRequest(
  message: string,
  details?: Record<string, unknown> | FieldIssue[]
): ApiError {
  return new ApiError(400, 'invalid_request', message, details);
}

export function unauthorized(message = 'Authentication is required.'): ApiError {
  return new ApiError(401, 'unauthorized', message);
}

export function forbidden(
  message = 'You are not allowed to perform this action.'
): ApiError {
  return new ApiError(403, 'forbidden', message);
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}
