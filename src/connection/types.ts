/**
 * Connection Manager types (design.md §2.2.1).
 * Credentials (accessKey, secretKey) are deliberately absent from ConnectionConfig.
 */

export interface ConnectionConfig {
  /** Stable identifier used as the SecretStorage reference key. Never exposed to user. */
  id: string;
  /** Human-readable display name. */
  label: string;
  connectionType: 'local' | 's3';
  /** S3-compatible endpoint URL; absent for local connections. */
  endpointUrl?: string;
  /** AWS/S3-compatible region; absent for local connections. */
  region?: string;
  /** S3 URI (e.g. "s3://bucket/prefix") or local FS absolute path. */
  warehousePath: string;
  /** Whether to verify TLS certificates; relevant for S3 only. */
  sslVerification: boolean;
  /** Unix timestamp (ms) of last save; used for LRU ordering (FR-6b). */
  savedAt: number;
}

// Re-export ActiveConnectionHandle so Connection Manager consumers have a single import point.
export type { ActiveConnectionHandle } from '../storage/types.js';
