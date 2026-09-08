/**
 * Query Engine public types (design.md §2.2.4, §2.2.5, §2.2.6).
 *
 * These are the shapes that cross the Query Engine boundary into the
 * Webview Panel Manager.  No DuckDB internals leak beyond this file.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type QueryErrorClass = 'parse-failure' | 'timeout' | 'cancelled' | 'internal';

export interface QueryError {
  readonly kind: 'QueryError';
  readonly class: QueryErrorClass;
  readonly message: string;
}

export function isQueryError(value: unknown): value is QueryError {
  return (
    typeof value === 'object'
    && value !== null
    && (value as QueryError).kind === 'QueryError'
  );
}

export function queryError(cls: QueryErrorClass, message: string): QueryError {
  return { kind: 'QueryError', class: cls, message };
}

// ---------------------------------------------------------------------------
// Query result (design.md §2.2.6)
// ---------------------------------------------------------------------------

export interface QueryResult {
  rows: Record<string, unknown>[];
  columnNames: string[];
  rowCount: number;
  wasCapped: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Avro manifest list row (design.md §2.2.4)
// ---------------------------------------------------------------------------

export interface ManifestEntryRow {
  manifestPath: string;
  manifestLength: number;
  partitionSpecId: number;
  content: number;
  snapshotId: number;
  addedFilesCount?: number;
  existingFilesCount?: number;
  deletedFilesCount?: number;
}

// ---------------------------------------------------------------------------
// Avro manifest file row (design.md §2.2.5)
//
// DuckDB surfaces nested Iceberg `data_file` STRUCT columns via dot notation:
//   data_file.file_path, data_file.file_format, etc. (OQ-2 resolved)
// ---------------------------------------------------------------------------

export interface DataFileRow {
  status: number;
  filePath: string;
  fileFormat: string;
  recordCount: number;
  fileSizeBytes: number;
  partitionValues?: Record<string, unknown>;
  columnSizes?: Record<string, unknown>;
}
