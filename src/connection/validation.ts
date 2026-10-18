/**
 * Connection Manager input validation (design.md §2.4.1, CM-V1 through CM-V5).
 */

import type { ConnectionConfig } from './types.js';
import type { ActiveConnectionHandle } from '../storage/types.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { isStorageError } from '../storage/errors.js';

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
  existingConfigs?: ConnectionConfig[],
): ValidationResult {
  const errors: FieldError[] = [];

  // Connection label must be non-empty and unique
  if (!config.label || config.label.trim() === '') {
    errors.push({
      field: 'label',
      message: 'Connection name is required.',
    });
  } else if (existingConfigs) {
    const trimmedLabel = config.label.trim().toLowerCase();
    const isDuplicate = existingConfigs.some(
      (c) => c.id !== config.id && c.label.trim().toLowerCase() === trimmedLabel,
    );
    if (isDuplicate) {
      errors.push({
        field: 'label',
        message: `A connection with the name "${config.label.trim()}" already exists.`,
      });
    }
  }

  // CM-V1 — connectionType must be "s3", "gcs", or "local"
  if (config.connectionType !== 's3' && config.connectionType !== 'local' && config.connectionType !== 'gcs') {
    errors.push({
      field: 'connectionType',
      message: 'Connection type must be "s3", "gcs", or "local".',
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

    // CM-V5b — warehousePath must be non-empty and a valid S3 URI
    if (!config.warehousePath || config.warehousePath.trim() === '') {
      errors.push({ field: 'warehousePath', message: 'Warehouse path is required for S3 connections.' });
    } else if (!/^s3[an]?:\/\/[^/]+/i.test(config.warehousePath.trim())) {
      errors.push({
        field: 'warehousePath',
        message: 'Warehouse path must be a valid S3 URI (e.g. s3://bucket/warehouse-path).',
      });
    }
  }

  if (config.connectionType === 'gcs') {
    // Warehouse path must be non-empty and a valid GCS URI
    if (!config.warehousePath || config.warehousePath.trim() === '') {
      errors.push({ field: 'warehousePath', message: 'Warehouse path is required for GCS connections.' });
    } else if (!/^(?:gs|gcs):\/\/[^/]+/i.test(config.warehousePath.trim())) {
      errors.push({
        field: 'warehousePath',
        message: 'Warehouse path must be a valid GCS URI (e.g. gs://bucket/warehouse-path).',
      });
    }

    if (config.gcsAuthType === 'serviceAccountKey') {
      if (!credentials.secretKey || credentials.secretKey.trim() === '') {
        errors.push({
          field: 'secretKey',
          message: 'Service account key JSON or file path is required when using Service Account authentication.',
        });
      }
    }
  }

  if (config.connectionType === 'local') {
    // CM-V5 — warehousePath must be non-empty and absolute (POSIX / or Windows drive C:\)
    if (!config.warehousePath || config.warehousePath.trim() === '') {
      errors.push({ field: 'warehousePath', message: 'Warehouse path is required.' });
    } else if (!isAbsoluteLocalPath(config.warehousePath)) {
      errors.push({
        field: 'warehousePath',
        message: 'Warehouse path must be an absolute path (starting with / or a drive letter like C:\\).',
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Checks whether a string is an absolute filesystem path.
 * Supports POSIX paths (/path/to/dir), Windows drive paths (C:\dir or C:/dir),
 * and Windows UNC paths (\\server\share).
 */
export function isAbsoluteLocalPath(p: string): boolean {
  if (!p) return false;
  return /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(p.trim());
}

/**
 * Validates that the warehouse path contains at least one schema directory with a table directly under it.
 * Rejects paths that are too high (e.g. bucket root where schemas are nested) or too deep (e.g. table directory).
 */
export async function validateWarehouseStructure(
  handle: ActiveConnectionHandle,
  adapter: StorageAdapter,
): Promise<ValidationResult> {
  const schemas = await adapter.listSchemas(handle);
  if (isStorageError(schemas)) {
    return {
      valid: false,
      errors: [
        {
          field: 'warehousePath',
          message: `Could not access warehouse path: ${schemas.message}`,
        },
      ],
    };
  }

  const example =
    handle.connectionType === 'gcs'
      ? 'gs://warehouse-path/<schema>/<table>/'
      : handle.connectionType === 's3'
        ? 's3://warehouse-path/<schema>/<table>/'
        : '/warehouse-path/<schema>/<table>/';

  if (schemas.length === 0) {
    return {
      valid: false,
      errors: [
        {
          field: 'warehousePath',
          message:
            `No schemas found in warehouse path. Iceberg Explorer expects schemas and tables directly under warehousePath (e.g. ${example}).`,
        },
      ],
    };
  }

  let foundTable = false;
  for (const schemaPath of schemas) {
    const tables = await adapter.listTables(handle, schemaPath);
    if (isStorageError(tables)) {
      continue;
    }
    for (const tableCandidate of tables) {
      const isTab = await adapter.isTable(handle, tableCandidate);
      if (!isStorageError(isTab) && isTab === true) {
        foundTable = true;
        break;
      }
    }
    if (foundTable) {
      break;
    }
  }

  if (!foundTable) {
    return {
      valid: false,
      errors: [
        {
          field: 'warehousePath',
          message:
            `No Iceberg tables found under any schema directory. Iceberg Explorer expects schemas and tables directly under warehousePath (e.g. ${example}).`,
        },
      ],
    };
  }

  return { valid: true };
}
