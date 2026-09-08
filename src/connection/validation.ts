/**
 * Connection Manager input validation (design.md §2.4.1, CM-V1 through CM-V5).
 */

import type { ConnectionConfig } from './types.js';

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: FieldError[] };

export function validateConnectionInput(
  config: ConnectionConfig,
  credentials: { accessKey: string; secretKey: string },
): ValidationResult {
  const errors: FieldError[] = [];

  // CM-V1 — connectionType must be "s3" or "local"
  if (config.connectionType !== 's3' && config.connectionType !== 'local') {
    errors.push({
      field: 'connectionType',
      message: 'Connection type must be "s3" or "local".',
    });
    // Short-circuit: remaining rules depend on connectionType
    return { valid: false, errors };
  }

  if (config.connectionType === 's3') {
    // CM-V2 — endpointUrl (if provided) must be a parseable URL with http or https scheme
    if (config.endpointUrl && config.endpointUrl.trim() !== '') {
      let parsed: URL | undefined;
      try {
        parsed = new URL(config.endpointUrl.trim());
      } catch {
        errors.push({ field: 'endpointUrl', message: 'Endpoint URL is not a valid URL.' });
      }
      if (parsed && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        errors.push({
          field: 'endpointUrl',
          message: 'Endpoint URL must use the https or http scheme.',
        });
      }
    }

    // CM-V3 — region must be non-empty
    if (!config.region || config.region.trim() === '') {
      errors.push({ field: 'region', message: 'Region is required for S3 connections.' });
    }

    // CM-V4 — accessKey and secretKey must be non-empty
    if (!credentials.accessKey || credentials.accessKey.trim() === '') {
      errors.push({ field: 'accessKey', message: 'Access key is required for S3 connections.' });
    }
    if (!credentials.secretKey || credentials.secretKey.trim() === '') {
      errors.push({ field: 'secretKey', message: 'Secret key is required for S3 connections.' });
    }
  }

  if (config.connectionType === 'local') {
    // CM-V5 — warehousePath must be non-empty and absolute (starts with "/" on macOS)
    if (!config.warehousePath || config.warehousePath.trim() === '') {
      errors.push({ field: 'warehousePath', message: 'Warehouse path is required.' });
    } else if (!config.warehousePath.startsWith('/')) {
      errors.push({
        field: 'warehousePath',
        message: 'Warehouse path must be an absolute path (starting with /).',
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
