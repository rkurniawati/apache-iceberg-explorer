/**
 * locationResolver.ts — Loose matching and location mismatch detection for Iceberg tables.
 *
 * When an Iceberg table is copied between cloud storage (e.g. S3, GCS) and a local
 * filesystem (or between different buckets/prefixes), the metadata files retain the
 * original table location (e.g. `s3a://my-bucket/warehouse/schema/table`) in:
 *   - The table metadata `location` property
 *   - Snapshot `manifest-list` paths
 *   - Manifest file `manifest_path` entries
 *   - Data file `file_path` entries
 *
 * This module:
 *  1. Parses Iceberg table location URIs to identify their original storage provider and bucket.
 *  2. Detects mismatches between the metadata `location` and the current actual table path.
 *  3. Emits user-facing warning messages and logs when a location mismatch is detected.
 *  4. Performs loose path matching (ignoring bucket names and aligning paths starting from
 *     warehouse/schema/table names) to resolve files to the active warehouse.
 */

import * as path from 'node:path';
import * as fsSync from 'node:fs';
import * as vscode from 'vscode';
import type { ILogger } from '../extension.js';

export interface ParsedLocation {
  raw: string;
  scheme?: string;       // e.g. 's3a', 's3', 'gs', 'file'
  bucket?: string;       // e.g. 'ruthk-test'
  pathInBucket: string;  // e.g. 'ruthktest/events' (leading/trailing slashes stripped)
  segments: string[];    // e.g. ['ruthktest', 'events']
}

/**
 * Parses an Iceberg location string or cloud URI.
 */
export function parseLocation(loc: string): ParsedLocation {
  const raw = loc.trim();
  const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]+)(?:\/(.*))?$/.exec(raw);
  if (uriMatch) {
    const scheme = uriMatch[1].toLowerCase();
    const bucket = uriMatch[2];
    const pathInBucket = (uriMatch[3] || '').replace(/^\/+|\/+$/g, '');
    const segments = pathInBucket ? pathInBucket.split('/').filter(Boolean) : [];
    return { raw, scheme, bucket, pathInBucket, segments };
  }

  // File URI or plain local path
  const cleanPath = raw.replace(/^file:\/\//, '').replace(/^\/+|\/+$/g, '');
  const segments = cleanPath ? cleanPath.split('/').filter(Boolean) : [];
  return {
    raw,
    pathInBucket: cleanPath,
    segments,
  };
}

/**
 * Checks whether an Iceberg table's metadata location property differs from
 * the actual location from which it is currently being accessed.
 */
export function isLocationMismatch(
  metadataLocation: string | undefined,
  currentTablePath: string,
): boolean {
  if (!metadataLocation || !currentTablePath) return false;
  const normMeta = metadataLocation.replace(/\\/g, '/').replace(/\/$/, '').trim();
  const normCurrent = currentTablePath.replace(/\\/g, '/').replace(/\/$/, '').trim();

  if (!normMeta || normMeta.toLowerCase() === normCurrent.toLowerCase()) {
    return false;
  }

  // Cloud URI vs local filesystem path is always a mismatch
  const parsed = parseLocation(normMeta);
  if (parsed.scheme && ['s3', 's3a', 's3n', 'gs', 'gcs', 'hdfs', 'abfs', 'abfss'].includes(parsed.scheme)) {
    if (normCurrent.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(normCurrent)) {
      return true;
    }
  }

  return true;
}

export interface TableLocationMapping {
  originalLocation: string;
  tablePath: string;
  warehousePath?: string;
}

export class LocationResolver {
  private tableMappings = new Map<string, TableLocationMapping>();
  private warnedMismatchKeys = new Set<string>();

  constructor(private readonly logger?: ILogger) {}

  /**
   * Resets internal caches (useful in testing).
   */
  reset(): void {
    this.tableMappings.clear();
    this.warnedMismatchKeys.clear();
  }

  /**
   * Registers a known table path and its metadata `location` property.
   */
  registerTable(tablePath: string, originalLocation?: string, warehousePath?: string): void {
    if (!tablePath || !originalLocation) return;
    const normTable = path.resolve(tablePath);
    this.tableMappings.set(normTable, {
      originalLocation,
      tablePath: normTable,
      warehousePath: warehousePath ? path.resolve(warehousePath) : undefined,
    });
  }

  /**
   * Returns the registered original location for a given table path, if any.
   */
  getOriginalLocation(tablePath: string): string | undefined {
    const normTable = path.resolve(tablePath);
    return this.tableMappings.get(normTable)?.originalLocation;
  }

  /**
   * Detects if metadata location mismatches current table location and triggers
   * a warning message to the user once per mismatch pair.
   */
  detectAndWarnMismatch(
    metadataLocation?: string,
    currentTablePath?: string,
    warehousePath?: string,
    tableName?: string,
  ): boolean {
    if (!metadataLocation || !currentTablePath) return false;
    if (!isLocationMismatch(metadataLocation, currentTablePath)) return false;

    const key = `${metadataLocation}::${path.resolve(currentTablePath)}`;
    if (this.warnedMismatchKeys.has(key)) return true;
    this.warnedMismatchKeys.add(key);

    const parsed = parseLocation(metadataLocation);
    const originDesc = parsed.scheme && parsed.bucket
      ? `${parsed.scheme.toUpperCase()} bucket "${parsed.bucket}"`
      : `"${metadataLocation}"`;

    const name = tableName || path.basename(currentTablePath);
    const targetParsed = parseLocation(currentTablePath);
    const targetDesc = targetParsed.scheme && targetParsed.bucket
      ? `${targetParsed.scheme.toUpperCase()} bucket "${targetParsed.bucket}"`
      : 'the local warehouse';

    const logMsg = `Iceberg table location mismatch: table "${name}" metadata specifies location ${originDesc} (${metadataLocation}), but is accessed from ${targetDesc} ("${currentTablePath}"). Loose path matching is enabled.`;

    if (this.logger) {
      this.logger.warn(`[LocationMismatch] ${logMsg}`);
    }

    try {
      if (vscode.window && typeof vscode.window.showWarningMessage === 'function') {
        void vscode.window.showWarningMessage(
          `Table "${name}" was copied from ${originDesc}. Loose matching will resolve metadata and data files from ${targetDesc}.`
        );
      }
    } catch {
      // vscode not available in unit test environments
    }

    // Register mapping for future path resolutions
    this.registerTable(currentTablePath, metadataLocation, warehousePath);
    return true;
  }

  /**
   * Resolves a target path (which may be an S3/GCS URI like `s3a://bucket/schema/table/metadata/snap-...avro`)
   * to an actual local file path under the warehouse/table directory using loose matching.
   *
   * Loose matching algorithm:
   *  1. If already a local absolute path that exists, return as-is.
   *  2. Strip URI scheme (`s3a://`, `s3://`, `gs://`, `file://`, etc.).
   *  3. Ignore the bucket name (the first segment in the URI).
   *  4. Extract the path segments (e.g. `['schema', 'table', 'metadata', 'snap-...avro']`).
   *  5. If `tablePath` is known:
   *     - Match against table directory name and append subpath.
   *  6. If `warehousePath` is known:
   *     - Check candidate paths matching from schema name or warehouse folder name.
   *     - Check `fs.existsSync` for candidate paths.
   *  7. Fall back to best structural match under `warehousePath` or `tablePath`.
   */
  resolvePath(targetPath: string, warehousePath?: string, tablePath?: string): string {
    if (!targetPath) return targetPath;

    // Normalise Windows separators and decode URI characters if necessary
    const rawClean = targetPath.replace(/\\/g, '/');

    // If targetPath already starts with warehousePath (e.g. in S3 or local), return as-is
    if (warehousePath) {
      const cleanWh = warehousePath.replace(/\\/g, '/');
      if (rawClean === cleanWh || rawClean.startsWith(cleanWh.endsWith('/') ? cleanWh : cleanWh + '/')) {
        return targetPath;
      }
      const whParsed = parseLocation(warehousePath);
      if (whParsed.scheme && whParsed.scheme !== 'file') {
        return targetPath;
      }
    }

    if (tablePath) {
      const tpParsed = parseLocation(tablePath);
      if (tpParsed.scheme && tpParsed.scheme !== 'file') {
        return targetPath;
      }
    }

    // 1. If it's already an existing local path, return it directly
    if (path.isAbsolute(rawClean) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawClean)) {
      if (fsSync.existsSync(rawClean)) {
        return rawClean;
      }
    }

    // 2. Parse URI to extract scheme, bucket, and segments
    const parsed = parseLocation(rawClean);

    // If no URI scheme and no bucket, and starts with /
    if (!parsed.scheme && rawClean.startsWith('/')) {
      if (warehousePath && !rawClean.startsWith(warehousePath)) {
        // Might be a stripped path like /ruthktest/events/metadata/...
        const candidate = path.join(warehousePath, rawClean.replace(/^\/+/, ''));
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }
      return rawClean;
    }

    const segments = parsed.segments;
    if (segments.length === 0) {
      return targetPath;
    }

    // 3. Try registered table mappings first
    if (!tablePath) {
      for (const mapping of this.tableMappings.values()) {
        const origParsed = parseLocation(mapping.originalLocation);
        if (parsed.pathInBucket.startsWith(origParsed.pathInBucket)) {
          const suffix = parsed.pathInBucket.slice(origParsed.pathInBucket.length).replace(/^\/+/, '');
          const candidate = path.join(mapping.tablePath, suffix);
          if (fsSync.existsSync(candidate)) {
            return candidate;
          }
          // If candidate doesn't physically exist yet (e.g. mock test), hold as strong candidate
          tablePath = mapping.tablePath;
          break;
        }
      }
    }

    // 4. Candidate matching with known tablePath
    if (tablePath) {
      const normTable = path.resolve(tablePath);
      const tableName = path.basename(normTable);
      const tableIdx = segments.lastIndexOf(tableName);
      if (tableIdx >= 0) {
        const subSegments = segments.slice(tableIdx + 1);
        const candidate = path.join(normTable, ...subSegments);
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // 5. Candidate matching with warehousePath
    if (warehousePath) {
      const normWarehouse = path.resolve(warehousePath);
      const warehouseBase = path.basename(normWarehouse);

      // Candidate A: segments contains warehouseBase (e.g. ['warehouse', 'schema', 'table', ...])
      const whIdx = segments.indexOf(warehouseBase);
      if (whIdx >= 0) {
        const candidate = path.join(normWarehouse, ...segments.slice(whIdx + 1));
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }

      // Candidate B: test each slice from index 0 to segments.length - 2
      // e.g. segments = ['ruthktest', 'events', 'metadata', 'snap.avro']
      // i = 0: warehousePath/ruthktest/events/metadata/snap.avro
      for (let i = 0; i < segments.length; i++) {
        const candidate = path.join(normWarehouse, ...segments.slice(i));
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }

      // 6. Structural fallback if no file exists on disk (e.g. unit test or missing file)
      if (tablePath) {
        const normTable = path.resolve(tablePath);
        const tableName = path.basename(normTable);
        const tableIdx = segments.lastIndexOf(tableName);
        if (tableIdx >= 0) {
          return path.join(normTable, ...segments.slice(tableIdx + 1));
        }
      }

      // Check if segments[0] is the warehouse folder name
      if (segments[0] === warehouseBase) {
        return path.join(normWarehouse, ...segments.slice(1));
      }

      // Align from first segment after bucket (schema name)
      return path.join(normWarehouse, ...segments);
    }

    return targetPath;
  }
}

/**
 * Global singleton location resolver.
 */
export const globalLocationResolver = new LocationResolver();
