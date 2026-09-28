/**
 * Connection Manager types (design.md §2.2.1).
 * Credentials (accessKey, secretKey) are deliberately absent from ConnectionConfig.
 */

export interface ConnectionConfig {
  /** Stable identifier used as the SecretStorage reference key. Never exposed to user. */
  id: string;
  /** Human-readable display name. */
  label: string;
  connectionType: 'local' | 's3' | 'gcs';
  /** S3-compatible endpoint URL; absent for local / standard GCS connections. */
  endpointUrl?: string;
  /** AWS/S3-compatible region; absent for local / standard GCS connections. */
  region?: string;
  /** S3 URI ("s3://..."), GCS URI ("gs://..."), or local FS absolute path. */
  warehousePath: string;
  /** Whether to verify TLS certificates; relevant for S3 only. */
  sslVerification: boolean;
  /** Unix timestamp (ms) of last save; used for LRU ordering (FR-6b). */
  savedAt: number;
  /** GCS authentication mode: 'adc' (Application Default Credentials) or 'serviceAccountKey'. */
  gcsAuthType?: 'adc' | 'serviceAccountKey';
  /** GCP Project ID (optional). */
  projectId?: string;
}

// Re-export ActiveConnectionHandle so Connection Manager consumers have a single import point.
export type { ActiveConnectionHandle } from '../storage/types.js';
