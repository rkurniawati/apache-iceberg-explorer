/**
 * GcsAdapter — Storage Layer adapter for Google Cloud Storage (GCS).
 *
 * Implements StorageAdapter using @google-cloud/storage.
 * The adapter receives a fully initialised Storage client from the
 * ActiveConnectionHandle.
 *
 * All methods return a value or a StorageError; they never throw unhandled
 * exceptions across the component boundary.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { StorageAdapter } from './StorageAdapter.js';
import type {
  ActiveConnectionHandle,
  MetadataVersionEntry,
  DirectoryContentsResult,
  ListDirectoryOptions,
} from './types.js';
import { isIcebergDataFile } from './types.js';
import {
  mapGcsError,
  storageError,
  isStorageError,
  type StorageError,
} from './errors.js';
import type { ILogger } from '../extension.js';

export class GcsAdapter implements StorageAdapter {
  constructor(private readonly logger: ILogger) {}

  // -------------------------------------------------------------------------
  // listSchemas — common prefixes at the warehouse root level
  // -------------------------------------------------------------------------

  async listSchemas(handle: ActiveConnectionHandle): Promise<string[] | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const prefix = normalisePrefix(gcsConfig.keyPrefix);

    const result = await this.listCommonPrefixes(handle, prefix);
    if (isStorageError(result)) return result;

    return result.map((p) => `gs://${gcsConfig.bucket}/${p.replace(/\/$/, '')}`);
  }

  // -------------------------------------------------------------------------
  // listTables — common prefixes under the given schema path
  // -------------------------------------------------------------------------

  async listTables(
    handle: ActiveConnectionHandle,
    schemaPath: string,
  ): Promise<string[] | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const keyPrefix = gcsUriToKeyPrefix(schemaPath);
    const prefix = normalisePrefix(keyPrefix);

    const result = await this.listCommonPrefixes(handle, prefix);
    if (isStorageError(result)) return result;

    return result
      .map((p) => `gs://${gcsConfig.bucket}/${p.replace(/\/$/, '')}`)
      .filter((p) => !p.endsWith('/metadata'));
  }

  // -------------------------------------------------------------------------
  // listMetadataVersions — *.metadata.json under <tablePath>/metadata/, newest-first
  // -------------------------------------------------------------------------

  async listMetadataVersions(
    handle: ActiveConnectionHandle,
    tablePath: string,
  ): Promise<MetadataVersionEntry[] | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const tableKey = gcsUriToKeyPrefix(tablePath);
    const metaPrefix = normalisePrefix(`${tableKey}/metadata`);

    try {
      const bucket = gcsConfig.client.bucket(gcsConfig.bucket);
      const [files] = await bucket.getFiles({
        prefix: metaPrefix,
        autoPaginate: true,
      });

      const metaFiles = files.filter((f) => f.name.endsWith('.metadata.json'));

      const versions: MetadataVersionEntry[] = metaFiles.map((f) => {
        const key = f.name;
        const filename = key.split('/').pop() ?? key;
        const updatedTime = f.metadata?.updated
          ? new Date(f.metadata.updated).getTime()
          : 0;
        const sortKey = extractSequenceNumber(filename) ?? updatedTime;
        return {
          label: filename,
          resourcePath: `gs://${gcsConfig.bucket}/${key}`,
          sortKey,
        };
      });

      return versions.sort((a, b) => b.sortKey - a.sortKey);
    } catch (raw) {
      const err = mapGcsError(raw);
      const name =
        raw && typeof raw === 'object' && 'name' in raw
          ? String((raw as { name: unknown }).name)
          : 'Error';
      const msg = raw instanceof Error ? raw.message : String(raw);
      this.logger.error(
        `GCS listMetadataVersions failed: bucket=${gcsConfig.bucket} prefix=${metaPrefix} errorName=${name} message=${msg}`,
      );
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // fetchMetadataJson — stream object body and JSON.parse in-memory
  // -------------------------------------------------------------------------

  async fetchMetadataJson(
    handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<unknown | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const key = gcsUriToKey(filePath);

    this.logger.info(`Fetch started: path=${filePath} source=gcs`);

    try {
      const file = gcsConfig.client.bucket(gcsConfig.bucket).file(key);
      const [bodyBytes] = await file.download();
      const isGzip = key.endsWith('.gz') || key.endsWith('.gz.metadata.json');
      const textBytes = isGzip ? await gunzipAsync(bodyBytes) : bodyBytes;
      return JSON.parse(textBytes.toString('utf-8'));
    } catch (raw) {
      const err = mapGcsError(raw);
      const name =
        raw && typeof raw === 'object' && 'name' in raw
          ? String((raw as { name: unknown }).name)
          : 'Error';
      const msg = raw instanceof Error ? raw.message : String(raw);
      this.logger.error(
        `Fetch failed: path=${filePath} errorClass=${err.class} errorName=${name} message=${msg}`,
      );
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // fetchFileToTemp — stream object body to os.tmpdir()/iceberg-explorer/<uuid>/
  // -------------------------------------------------------------------------

  async fetchFileToTemp(
    handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<string | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const key = gcsUriToKey(filePath);
    const filename = key.split('/').pop() ?? 'object';

    this.logger.info(`Fetch started: path=${filePath} source=gcs`);
    this.logger.info(`Fetch resolved: bucket=${gcsConfig.bucket} key=${key}`);

    const uuid = crypto.randomUUID();
    const destDir = path.join(os.tmpdir(), 'iceberg-explorer', uuid);
    const destFile = path.join(destDir, filename);

    try {
      await fs.mkdir(destDir, { recursive: true });

      const file = gcsConfig.client.bucket(gcsConfig.bucket).file(key);
      const readable = file.createReadStream();
      const writeStream = await fs.open(destFile, 'w');
      const writable = writeStream.createWriteStream();
      await pipeline(readable, writable);
      await writeStream.close();

      this.logger.info(`Temp file written: ${destFile}`);
      return destFile;
    } catch (raw) {
      // Best-effort cleanup of the dest dir on failure
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
      const err = mapGcsError(raw);
      const name =
        raw && typeof raw === 'object' && 'name' in raw
          ? String((raw as { name: unknown }).name)
          : 'Error';
      const msg = raw instanceof Error ? raw.message : String(raw);
      this.logger.error(
        `Fetch failed: path=${filePath} errorClass=${err.class} errorName=${name} message=${msg}`,
      );
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // listDirectoryContents — immediate contents of an arbitrary directory
  // -------------------------------------------------------------------------

  async listDirectoryContents(
    handle: ActiveConnectionHandle,
    dirPath: string,
    options?: ListDirectoryOptions,
  ): Promise<DirectoryContentsResult | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;

    this.logger.info(`Listing directory: path=${dirPath} source=gcs`);

    const keyPath = gcsUriToKeyPrefix(dirPath);
    const prefix = normalisePrefix(keyPath);
    const filterMode = options?.filter ?? 'iceberg-data';

    const subdirectories: string[] = [];
    const files: string[] = [];
    let pageToken: string | undefined;

    try {
      const bucket = gcsConfig.client.bucket(gcsConfig.bucket);
      do {
        const query: { prefix: string; delimiter: string; autoPaginate: boolean; pageToken?: string } = {
          prefix,
          delimiter: '/',
          autoPaginate: false,
        };
        if (pageToken) query.pageToken = pageToken;

        const [fileObjs, nextQuery, apiResponse] = await bucket.getFiles(query);

        // Extract sub-directory names from apiResponse.prefixes
        const resp = apiResponse as { prefixes?: string[] } | undefined;
        const commonPrefixes: string[] = Array.isArray(resp?.prefixes) ? resp!.prefixes! : [];
        for (const cp of commonPrefixes) {
          const bareName = cp.slice(prefix.length).replace(/\/$/, '');
          if (bareName) subdirectories.push(bareName);
        }

        // Extract file names from fileObjs
        for (const obj of fileObjs) {
          const key = obj.name;
          if (!key || key === prefix) continue; // skip directory marker
          const bareName = key.slice(prefix.length);
          if (!bareName) continue;
          if (filterMode === 'iceberg-data' && !isIcebergDataFile(bareName)) continue;
          files.push(bareName);
        }

        pageToken = (nextQuery as { pageToken?: string } | null)?.pageToken;
      } while (pageToken);

      return { subdirectories, files };
    } catch (raw) {
      const err = mapGcsError(raw);
      const name =
        raw && typeof raw === 'object' && 'name' in raw
          ? String((raw as { name: unknown }).name)
          : 'Error';
      const msg = raw instanceof Error ? raw.message : String(raw);
      this.logger.error(
        `GCS listDirectoryContents failed: bucket=${gcsConfig.bucket} prefix=${prefix} errorName=${name} message=${msg}`,
      );
      return err;
    }
  }

  async deleteTemp(filePath: string): Promise<void | StorageError> {
    try {
      await fs.rm(filePath, { recursive: true, force: true });
    } catch {
      this.logger.warn(`Temp file deletion failed (already absent): ${filePath}`);
    }
  }

  // -------------------------------------------------------------------------
  // isTable — probes if <dirPath>/metadata/ exists in O(1)
  // -------------------------------------------------------------------------

  async isTable(
    handle: ActiveConnectionHandle,
    dirPath: string,
  ): Promise<boolean | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const keyPrefix = gcsUriToKeyPrefix(dirPath);
    const prefix = normalisePrefix(`${keyPrefix}/metadata`);

    try {
      const bucket = gcsConfig.client.bucket(gcsConfig.bucket);
      const [files] = await bucket.getFiles({
        prefix,
        maxResults: 10,
        autoPaginate: false,
      });
      return files.some((f) => {
        const name = f.name;
        if (!name) return false;
        if (name === prefix || name === prefix.replace(/\/$/, '') || name.endsWith('/')) {
          return false;
        }
        return true;
      });
    } catch (raw) {
      const err = mapGcsError(raw);
      const name =
        raw && typeof raw === 'object' && 'name' in raw
          ? String((raw as { name: unknown }).name)
          : 'Error';
      const msg = raw instanceof Error ? raw.message : String(raw);
      this.logger.error(
        `GCS isTable probe failed: bucket=${gcsConfig.bucket} prefix=${prefix} errorName=${name} message=${msg}`,
      );
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Lists all CommonPrefixes for a given prefix/delimiter pair. Handles pagination. */
  private async listCommonPrefixes(
    handle: ActiveConnectionHandle,
    prefix: string,
  ): Promise<string[] | StorageError> {
    if (handle.connectionType !== 'gcs') {
      return storageError('internal', 'GcsAdapter requires a GCS connection handle.');
    }
    const { gcsConfig } = handle;
    const prefixes: string[] = [];
    let pageToken: string | undefined;

    try {
      const bucket = gcsConfig.client.bucket(gcsConfig.bucket);
      do {
        const query: { prefix: string; delimiter: string; autoPaginate: boolean; pageToken?: string } = {
          prefix,
          delimiter: '/',
          autoPaginate: false,
        };
        if (pageToken) query.pageToken = pageToken;

        const [, nextQuery, apiResponse] = await bucket.getFiles(query);
        const resp = apiResponse as { prefixes?: string[] } | undefined;
        const commonPrefixes: string[] = Array.isArray(resp?.prefixes) ? resp!.prefixes! : [];
        for (const cp of commonPrefixes) {
          prefixes.push(cp);
        }
        pageToken = (nextQuery as { pageToken?: string } | null)?.pageToken;
      } while (pageToken);

      return prefixes;
    } catch (raw) {
      const err = mapGcsError(raw);
      const name =
        raw && typeof raw === 'object' && 'name' in raw
          ? String((raw as { name: unknown }).name)
          : 'Error';
      const msg = raw instanceof Error ? raw.message : String(raw);
      this.logger.error(
        `GCS listCommonPrefixes failed: bucket=${gcsConfig.bucket} prefix=${prefix} errorName=${name} message=${msg}`,
      );
      return err;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Ensures a prefix ends with "/" (delimiter convention).
 *  An empty prefix stays empty — getFiles with prefix="" lists all keys. */
function normalisePrefix(prefix: string): string {
  if (prefix === '') return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * Parses a cloud storage URI or relative path and returns the object key.
 * Supports gs://, gcs://, s3://, s3a://, s3n:// schemes (e.g. when tables
 * are created via GCS S3 interoperability or migrated between clouds)
 * as well as plain keys.
 * e.g. "gs://bucket/prefix/key"  → "prefix/key"
 *      "s3a://bucket/prefix/key" → "prefix/key"
 *      "s3://bucket/prefix/key"  → "prefix/key"
 */
function gcsUriToKey(uri: string): string {
  const match = /^(?:gs|gcs|s3[an]?):\/\/[^/]+(?:\/(.*))?$/.exec(uri);
  if (match) {
    return match[1] !== undefined ? match[1] : '';
  }
  const withoutFile = uri.replace(/^file:\/\//, '');
  return withoutFile.replace(/^\/+/, '');
}

/**
 * Returns the key portion of a GCS URI as a prefix (with trailing slash stripped).
 */
function gcsUriToKeyPrefix(uri: string): string {
  return gcsUriToKey(uri).replace(/\/+$/, '');
}

/**
 * Extracts the leading numeric sequence from a metadata filename.
 * e.g. "00003-abc.metadata.json" → 3; "v3.metadata.json" → 3
 */
function extractSequenceNumber(filename: string): number | undefined {
  const match = /^(?:v?(\d+)|(\d+)-)/.exec(filename);
  if (!match) return undefined;
  const num = match[1] ?? match[2];
  return num !== undefined ? parseInt(num, 10) : undefined;
}

const gunzipAsync = promisify(zlib.gunzip);
