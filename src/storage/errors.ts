/**
 * Storage Layer error types (design.md §2.5.1).
 *
 * All StorageAdapter methods return `T | StorageError` — they never throw
 * unhandled exceptions across the component boundary (design.md §2.5.2).
 */

export type ErrorClass =
  | 'access-denied'
  | 'not-found'
  | 'parse-failure'
  | 'internal';

export interface StorageError {
  readonly kind: 'StorageError';
  readonly class: ErrorClass;
  /** Human-safe static string — no file paths, no credentials, no raw exception text. */
  readonly message: string;
}

export function isStorageError(value: unknown): value is StorageError {
  return (
    typeof value === 'object'
    && value !== null
    && (value as StorageError).kind === 'StorageError'
  );
}

// ---------------------------------------------------------------------------
// Error factory helpers
// ---------------------------------------------------------------------------

export function storageError(errorClass: ErrorClass, message: string): StorageError {
  return { kind: 'StorageError', class: errorClass, message };
}

// ---------------------------------------------------------------------------
// Error mapper  (used by both adapters — T-04)
// ---------------------------------------------------------------------------

/**
 * Maps a raw Node.js fs error or other unknown error to a structured StorageError.
 * The `message` field of the returned error is always a human-safe static string.
 */
export function mapNodeError(raw: unknown): StorageError {
  if (isNodeError(raw)) {
    switch (raw.code) {
      case 'ENOENT':
      case 'ENOTDIR':
        return storageError('not-found', 'File or directory not found.');
      case 'EACCES':
      case 'EPERM':
        return storageError('access-denied', 'Permission denied.');
      default:
        return storageError('internal', 'An unexpected file system error occurred.');
    }
  }
  if (raw instanceof SyntaxError) {
    return storageError('parse-failure', 'Could not parse file content.');
  }
  return storageError('internal', 'An unexpected error occurred.');
}

/**
 * Maps an AWS SDK v3 S3 error to a structured StorageError.
 * HTTP 403 → access-denied; 404 / NoSuchKey → not-found; all others → internal.
 */
export function mapS3Error(raw: unknown): StorageError {
  if (isS3ServiceException(raw)) {
    if (raw.$metadata?.httpStatusCode === 403 || raw.name === 'AccessDenied') {
      return storageError('access-denied', 'Access denied.');
    }
    if (
      raw.$metadata?.httpStatusCode === 404
      || raw.name === 'NoSuchKey'
      || raw.name === 'NoSuchBucket'
    ) {
      return storageError('not-found', 'Resource not found.');
    }
    return storageError('internal', 'An unexpected storage error occurred.');
  }
  return storageError('internal', 'An unexpected error occurred.');
}

/**
 * Maps a Google Cloud Storage error to a structured StorageError.
 * HTTP 401 / 403 → access-denied; 404 → not-found; syntax/parse → parse-failure; all others → internal.
 */
export function mapGcsError(raw: unknown): StorageError {
  if (raw && typeof raw === 'object') {
    const code = (raw as { code?: number | string }).code;
    const msg = (raw as { message?: string }).message?.toLowerCase() ?? '';
    if (
      code === 401
      || code === 403
      || msg.includes('permission denied')
      || msg.includes('unauthorized')
      || msg.includes('access denied')
      || msg.includes('invalid credentials')
    ) {
      return storageError('access-denied', 'Access denied.');
    }
    if (code === 404 || msg.includes('not found') || msg.includes('no such')) {
      return storageError('not-found', 'Resource not found.');
    }
    if (raw instanceof SyntaxError || msg.includes('unexpected token') || msg.includes('parse error')) {
      return storageError('parse-failure', 'Could not parse file content.');
    }
    return storageError('internal', 'An unexpected storage error occurred.');
  }
  return storageError('internal', 'An unexpected error occurred.');
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code?: string;
}

function isNodeError(value: unknown): value is NodeError {
  return value instanceof Error;
}

interface S3ServiceException {
  readonly name: string;
  readonly $metadata?: { httpStatusCode?: number };
}

function isS3ServiceException(value: unknown): value is S3ServiceException {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as S3ServiceException).name === 'string'
    && '$metadata' in (value as object)
  );
}
