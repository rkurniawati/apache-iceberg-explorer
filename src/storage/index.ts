/**
 * Storage Layer public API barrel.
 */

export type { StorageAdapter } from './StorageAdapter.js';
export { LocalFsAdapter } from './localFsAdapter.js';
export { S3Adapter } from './s3Adapter.js';
export { GcsAdapter } from './gcsAdapter.js';
export type { ActiveConnectionHandle, MetadataVersionEntry, S3Config, GcsConfig, DirectoryContentsResult } from './types.js';
export {
  isStorageError,
  storageError,
  mapNodeError,
  mapS3Error,
  mapGcsError,
  type StorageError,
  type ErrorClass,
} from './errors.js';

/**
 * Factory: creates the correct StorageAdapter implementation for the given connection type.
 * Import from this module to avoid direct adapter imports in consumer code (AD-3).
 */
import { LocalFsAdapter } from './localFsAdapter.js';
import { S3Adapter } from './s3Adapter.js';
import { GcsAdapter } from './gcsAdapter.js';
import type { StorageAdapter } from './StorageAdapter.js';
import type { ILogger } from '../extension.js';

export function createStorageAdapter(
  connectionType: 'local' | 's3' | 'gcs',
  logger: ILogger,
): StorageAdapter {
  switch (connectionType) {
    case 'local':
      return new LocalFsAdapter(logger);
    case 's3':
      return new S3Adapter(logger);
    case 'gcs':
      return new GcsAdapter(logger);
  }
}
