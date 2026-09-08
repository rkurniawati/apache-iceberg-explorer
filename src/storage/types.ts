/**
 * Shared types for the Storage Layer and Connection Manager.
 * No credential strings appear anywhere in these types (AD-4, NFR-7).
 */

import type { S3Client } from '@aws-sdk/client-s3';

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

export interface DirectoryContentsResult {
  /** Immediate child sub-directory names (bare names, not full paths) */
  subdirectories: string[];
  /**
   * Immediate child file names (bare names), filtered:
   * files ending in `.COMPLETE.gz` are excluded.
   */
  files: string[];
}
