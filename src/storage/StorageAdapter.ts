/**
 * StorageAdapter — common interface for S3 and local FS adapters (AD-3, design.md §2.3.1).
 *
 * Consumers hold a reference to this interface only; they never import
 * S3Adapter or LocalFsAdapter directly.
 *
 * All methods that can fail return `T | StorageError` and never throw
 * unhandled exceptions across the component boundary (design.md §2.5.2).
 */

import type {
  ActiveConnectionHandle,
  MetadataVersionEntry,
  DirectoryContentsResult,
  ListDirectoryOptions,
} from './types.js';
import type { StorageError } from './errors.js';

export interface StorageAdapter {
  /**
   * Lists schema paths at the top level of the warehouse.
   * Returns a list of fully-qualified paths (absolute FS paths or S3 URIs).
   */
  listSchemas(handle: ActiveConnectionHandle): Promise<string[] | StorageError>;

  /**
   * Lists table paths within the given schema directory/prefix.
   * Returns a list of fully-qualified paths.
   */
  listTables(
    handle: ActiveConnectionHandle,
    schemaPath: string,
  ): Promise<string[] | StorageError>;

  /**
   * Lists metadata JSON versions under <tablePath>/metadata/, newest-first.
   */
  listMetadataVersions(
    handle: ActiveConnectionHandle,
    tablePath: string,
  ): Promise<MetadataVersionEntry[] | StorageError>;

  /**
   * Fetches a metadata JSON file and returns the parsed object in-memory.
   * No temp file is written.
   */
  fetchMetadataJson(
    handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<unknown | StorageError>;

  /**
   * Downloads `filePath` to a temp file under `os.tmpdir()/iceberg-explorer/`.
   * Returns the absolute temp file path on success.
   * The caller (Webview Panel Manager) is responsible for calling `deleteTemp`
   * after the operation completes, errors, is cancelled, or the panel closes (NFR-6).
   */
  fetchFileToTemp(
    handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<string | StorageError>;

  /**
   * Deletes a previously returned temp file.  Idempotent (design.md §2.6.3):
   * if the file is already absent the call succeeds silently.
   */
  deleteTemp(filePath: string): Promise<void | StorageError>;

  /**
   * List the immediate contents (subdirectories and files) at `dirPath`.
   * By default, files are filtered to Iceberg data/delete files (.parquet, .orc, .avro).
   * Pass `{ filter: 'all' }` in `options` to return unfiltered directory files.
   * Used for table root scanning and recursive data directory drilling.
   */
  listDirectoryContents(
    handle: ActiveConnectionHandle,
    dirPath: string,
    options?: ListDirectoryOptions,
  ): Promise<DirectoryContentsResult | StorageError>;

  /**
   * Probes whether `dirPath` represents an Iceberg table in O(1) time
   * by checking for the presence of a `metadata/` directory.
   */
  isTable(
    handle: ActiveConnectionHandle,
    dirPath: string,
  ): Promise<boolean | StorageError>;
}

