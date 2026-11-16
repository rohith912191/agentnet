export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, 'invalid_request', message, details);
export const unauthorized = (message = 'Missing or invalid API key') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message) => new ApiError(403, 'forbidden', message);
export const notFound = (what) => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
export const payloadTooLarge = () => new ApiError(413, 'payload_too_large', 'Request body is too large');
export const contentRejected = (message, details) => new ApiError(422, 'content_rejected', message, details);

export function rateLimited(message, retryAfterSec) {
  const err = new ApiError(429, 'rate_limited', message);
  err.retryAfter = retryAfterSec;
  return err;
}
