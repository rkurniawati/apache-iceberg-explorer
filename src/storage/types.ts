/**
 * Shared types for the Storage Layer and Connection Manager.
 * No credential strings appear anywhere in these types (AD-4, NFR-7).
 */

import type { S3Client } from '@aws-sdk/client-s3';
import type { Storage } from '@google-cloud/storage';

// ---------------------------------------------------------------------------
// Active-Connection Handle  (design.md §2.2.2)
// ---------------------------------------------------------------------------

/** S3-specific sub-object held on the active-connection handle. */
export interface S3Config {
  /** Fully initialised S3Client; credentials are held inside the SDK object, never as strings. */
  client: S3Client;
  /** Bucket name parsed from warehousePath (e.g. the "bucket" in s3://bucket/prefix). */
  bucket: string;
  /** Key prefix for the warehouse root (e.g. "prefix/" in s3://bucket/prefix). */
  keyPrefix: string;
}

/** GCS-specific sub-object held on the active-connection handle. */
export interface GcsConfig {
  /** Fully initialised Storage client; credentials are encapsulated inside the SDK instance. */
  client: Storage;
  /** Bucket name parsed from warehousePath (e.g. the "bucket" in gs://bucket/prefix). */
  bucket: string;
  /** Key prefix for the warehouse root (e.g. "prefix" in gs://bucket/prefix). */
  keyPrefix: string;
}

/** Transient runtime object constructed by ConnectionManager and passed to the Storage Layer. */
export type ActiveConnectionHandle =
  | {
      connectionType: 'local';
      /** Absolute path to the warehouse root directory. */
      warehousePath: string;
    }
  | {
      connectionType: 's3';
      /** S3 URI of the warehouse root, e.g. "s3://bucket/prefix". */
      warehousePath: string;
      s3Config: S3Config;
    }
  | {
      connectionType: 'gcs';
      /** GCS URI of the warehouse root, e.g. "gs://bucket/prefix". */
      warehousePath: string;
      gcsConfig: GcsConfig;
    };

// ---------------------------------------------------------------------------
// Metadata version entry returned by listMetadataVersions
// ---------------------------------------------------------------------------

export interface MetadataVersionEntry {
  /** Human-readable label, e.g. "v3.metadata.json". */
  label: string;
  /** Fully-qualified path (local absolute path or S3 URI). */
  resourcePath: string;
  /** Numeric sort key — higher is newer. Derived from the sequence number in the filename, or mtime. */
  sortKey: number;
}

// ---------------------------------------------------------------------------
// Directory contents result returned by listDirectoryContents
// ---------------------------------------------------------------------------

/** Filter mode for listing directory files. */
export type DirectoryFilterMode = 'iceberg-data' | 'all';

/** Options for listDirectoryContents. */
export interface ListDirectoryOptions {
  /**
   * Filter mode applied to files in the directory.
   * - 'iceberg-data' (default): only returns Iceberg data/delete files (.parquet, .orc, .avro).
   * - 'all': returns all immediate child files without extension filtering.
   */
  filter?: DirectoryFilterMode;
}

/** Standard file extensions for Apache Iceberg data and delete files. */
export const ICEBERG_DATA_FILE_EXTENSIONS = ['.parquet', '.orc', '.avro'] as const;

/** Checks whether a filename matches an Apache Iceberg data or delete file format (.parquet, .orc, .avro). */
export function isIcebergDataFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ICEBERG_DATA_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface DirectoryContentsResult {
  /** Immediate child sub-directory names (bare names, not full paths) */
  subdirectories: string[];
  /**
   * Immediate child file names (bare names), filtered according to ListDirectoryOptions.
   * By default ('iceberg-data'), only Iceberg data/delete files (.parquet, .orc, .avro) are returned.
   */
  files: string[];
}

