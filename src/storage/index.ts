/**
 * Storage Layer public API barrel.
 */

export type { StorageAdapter } from './StorageAdapter.js';
export { LocalFsAdapter } from './localFsAdapter.js';
export { S3Adapter } from './s3Adapter.js';
export type { ActiveConnectionHandle, MetadataVersionEntry, S3Config, DirectoryContentsResult } from './types.js';
export {
  isStorageError,
  storageError,
  mapNodeError,
  mapS3Error,
  type StorageError,
  type ErrorClass,
} from './errors.js';

/**
 * Factory: creates the correct StorageAdapter implementation for the given connection type.
 * Import from this module to avoid direct adapter imports in consumer code (AD-3).
 */
import { LocalFsAdapter } from './localFsAdapter.js';
import { S3Adapter } from './s3Adapter.js';
import type { StorageAdapter } from './StorageAdapter.js';
import type { ILogger } from '../extension.js';

export function createStorageAdapter(
  connectionType: 'local' | 's3',
  logger: ILogger,
): StorageAdapter {
  return connectionType === 'local'
    ? new LocalFsAdapter(logger)
    : new S3Adapter(logger);
}
