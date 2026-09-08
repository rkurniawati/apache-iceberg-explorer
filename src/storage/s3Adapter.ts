/**
 * S3Adapter — Storage Layer adapter for S3-compatible object storage (AD-3, FR-4).
 *
 * Implements StorageAdapter using @aws-sdk/client-s3.
 * The adapter never instantiates or configures S3 credentials — it receives a
 * fully initialised S3Client from the ActiveConnectionHandle (AD-4, NFR-7).
 *
 * All methods return a value or a StorageError; they never throw (design.md §2.5.2).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';

import type { StorageAdapter } from './StorageAdapter.js';
import type { ActiveConnectionHandle, MetadataVersionEntry, DirectoryContentsResult } from './types.js';
import { mapS3Error, storageError, isStorageError, type StorageError } from './errors.js';
import type { ILogger } from '../extension.js';

export class S3Adapter implements StorageAdapter {
  constructor(private readonly logger: ILogger) {}

  // -------------------------------------------------------------------------
  // listSchemas — common prefixes at the warehouse root level
  // -------------------------------------------------------------------------

  async listSchemas(handle: ActiveConnectionHandle): Promise<string[] | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const prefix = normalisePrefix(s3Config.keyPrefix);

    const result = await this.listCommonPrefixes(handle, prefix);
    if (isStorageError(result)) return result;

    return result.map((p) => `s3://${s3Config.bucket}/${p.replace(/\/$/, '')}`);
  }

  // -------------------------------------------------------------------------
  // listTables — common prefixes under the given schema path
  // -------------------------------------------------------------------------

  async listTables(
    handle: ActiveConnectionHandle,
    schemaPath: string,
  ): Promise<string[] | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const keyPrefix = s3UriToKeyPrefix(schemaPath);
    const prefix = normalisePrefix(keyPrefix);

    const result = await this.listCommonPrefixes(handle, prefix);
    if (isStorageError(result)) return result;

    return result.map((p) => `s3://${s3Config.bucket}/${p.replace(/\/$/, '')}`);
  }

  // -------------------------------------------------------------------------
  // listMetadataVersions — *.metadata.json under <tablePath>/metadata/, newest-first
  // -------------------------------------------------------------------------

  async listMetadataVersions(
    handle: ActiveConnectionHandle,
    tablePath: string,
  ): Promise<MetadataVersionEntry[] | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const tableKey = s3UriToKeyPrefix(tablePath);
    const metaPrefix = normalisePrefix(`${tableKey}/metadata`);

    try {
      const output = await s3Config.client.send(
        new ListObjectsV2Command({
          Bucket: s3Config.bucket,
          Prefix: metaPrefix,
        }),
      );

      const objects = (output as ListObjectsV2CommandOutput).Contents ?? [];
      const metaFiles = objects.filter((o) =>
        o.Key?.endsWith('.metadata.json'),
      );

      const versions: MetadataVersionEntry[] = metaFiles.map((o) => {
        const key = o.Key!;
        const filename = key.split('/').pop() ?? key;
        const sortKey =
          extractSequenceNumber(filename) ?? (o.LastModified?.getTime() ?? 0);
        return {
          label: filename,
          resourcePath: `s3://${s3Config.bucket}/${key}`,
          sortKey,
        };
      });

      return versions.sort((a, b) => b.sortKey - a.sortKey);
    } catch (raw) {
      const err = mapS3Error(raw);
      const name = (raw && typeof raw === 'object' && 'name' in raw) ? String((raw as { name: unknown }).name) : 'Error';
      const msg = (raw instanceof Error) ? raw.message : String(raw);
      this.logger.error(`S3 listMetadataVersions failed: bucket=${s3Config.bucket} prefix=${metaPrefix} errorName=${name} message=${msg}`);
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // fetchMetadataJson — stream object body and JSON.parse in-memory
  // -------------------------------------------------------------------------

  async fetchMetadataJson(
    handle: ActiveConnectionHandle,
    s3Path: string,
  ): Promise<unknown | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const key = s3UriToKey(s3Path);

    this.logger.info(`Fetch started: path=${s3Path} source=s3`);

    try {
      const output = await s3Config.client.send(
        new GetObjectCommand({ Bucket: s3Config.bucket, Key: key }),
      );
      const bodyBytes = await streamToBuffer(output.Body as NodeJS.ReadableStream);
      const isGzip = key.endsWith('.gz') || key.endsWith('.gz.metadata.json');
      const textBytes = isGzip ? await gunzipAsync(bodyBytes) : bodyBytes;
      return JSON.parse(textBytes.toString('utf-8'));
    } catch (raw) {
      const err = mapS3Error(raw);
      const name = (raw && typeof raw === 'object' && 'name' in raw) ? String((raw as { name: unknown }).name) : 'Error';
      const msg = (raw instanceof Error) ? raw.message : String(raw);
      this.logger.error(`Fetch failed: path=${s3Path} errorClass=${err.class} errorName=${name} message=${msg}`);
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // fetchFileToTemp — stream object body to os.tmpdir()/iceberg-explorer/<uuid>/
  // -------------------------------------------------------------------------

  async fetchFileToTemp(
    handle: ActiveConnectionHandle,
    s3Path: string,
  ): Promise<string | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const key = s3UriToKey(s3Path);
    const filename = key.split('/').pop() ?? 'object';

    this.logger.info(`Fetch started: path=${s3Path} source=s3`);
    this.logger.info(`Fetch resolved: bucket=${s3Config.bucket} key=${key}`);

    const uuid = crypto.randomUUID();
    const destDir = path.join(os.tmpdir(), 'iceberg-explorer', uuid);
    const destFile = path.join(destDir, filename);

    try {
      await fs.mkdir(destDir, { recursive: true });

      const output = await s3Config.client.send(
        new GetObjectCommand({ Bucket: s3Config.bucket, Key: key }),
      );

      const readable = Readable.from(output.Body as AsyncIterable<Uint8Array>);
      const writeStream = await fs.open(destFile, 'w');
      const writable = writeStream.createWriteStream();
      await pipeline(readable, writable);
      await writeStream.close();

      this.logger.info(`Temp file written: ${destFile}`);
      return destFile;
    } catch (raw) {
      // Best-effort cleanup of the dest dir on failure
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
      const err = mapS3Error(raw);
      const name = (raw && typeof raw === 'object' && 'name' in raw) ? String((raw as { name: unknown }).name) : 'Error';
      const msg = (raw instanceof Error) ? raw.message : String(raw);
      this.logger.error(`Fetch failed: path=${s3Path} errorClass=${err.class} errorName=${name} message=${msg}`);
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // listDirectoryContents — immediate contents of an arbitrary directory
  // -------------------------------------------------------------------------

  async listDirectoryContents(
    handle: ActiveConnectionHandle,
    dirPath: string,
  ): Promise<DirectoryContentsResult | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;

    this.logger.info(`Listing directory: path=${dirPath} source=s3`);

    // Convert S3 URI to a raw key prefix, then normalise to end with '/'
    const keyPath = s3UriToKeyPrefix(dirPath);
    const prefix = normalisePrefix(keyPath);

    const subdirectories: string[] = [];
    const files: string[] = [];
    let continuationToken: string | undefined;

    try {
      do {
        const output: ListObjectsV2CommandOutput = await s3Config.client.send(
          new ListObjectsV2Command({
            Bucket: s3Config.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: continuationToken,
          }),
        );

        // Extract sub-directory names from CommonPrefixes
        for (const cp of output.CommonPrefixes ?? []) {
          if (cp.Prefix) {
            // Strip the leading key prefix and trailing '/' to get bare name
            const bareName = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
            if (bareName) subdirectories.push(bareName);
          }
        }

        // Extract file names from Contents
        for (const obj of output.Contents ?? []) {
          const key = obj.Key;
          if (!key || key === prefix) continue; // skip the directory marker
          const bareName = key.slice(prefix.length);
          if (!bareName) continue;
          if (bareName.endsWith('.COMPLETE.gz')) continue;
          files.push(bareName);
        }

        continuationToken = output.NextContinuationToken;
      } while (continuationToken);

      return { subdirectories, files };
    } catch (raw) {
      const err = mapS3Error(raw);
      const name = (raw && typeof raw === 'object' && 'name' in raw) ? String((raw as { name: unknown }).name) : 'Error';
      const msg = (raw instanceof Error) ? raw.message : String(raw);
      this.logger.error(`S3 listDirectoryContents failed: bucket=${s3Config.bucket} prefix=${prefix} errorName=${name} message=${msg}`);
      return err;
    }
  }

  async deleteTemp(filePath: string): Promise<void | StorageError> {
    try {
      await fs.rm(filePath, { recursive: true, force: true });
    } catch {
      this.logger.warn(`Temp file deletion failed (already absent): ${filePath}`);
      // Do not surface to caller — deletion is always best-effort (design.md §2.6.3)
    }
  }

  // -------------------------------------------------------------------------
  // isTable — probes if <dirPath>/metadata/ exists using MaxKeys: 1 in O(1)
  // -------------------------------------------------------------------------

  async isTable(
    handle: ActiveConnectionHandle,
    dirPath: string,
  ): Promise<boolean | StorageError> {
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const keyPrefix = s3UriToKeyPrefix(dirPath);
    const prefix = normalisePrefix(`${keyPrefix}/metadata`);

    try {
      const output: ListObjectsV2CommandOutput = await s3Config.client.send(
        new ListObjectsV2Command({
          Bucket: s3Config.bucket,
          Prefix: prefix,
          MaxKeys: 1,
        }),
      );
      const hasKeys = (output.KeyCount ?? 0) > 0 || (output.Contents && output.Contents.length > 0);
      return Boolean(hasKeys);
    } catch (raw) {
      const err = mapS3Error(raw);
      const name = (raw && typeof raw === 'object' && 'name' in raw) ? String((raw as { name: unknown }).name) : 'Error';
      const msg = (raw instanceof Error) ? raw.message : String(raw);
      this.logger.error(`S3 isTable probe failed: bucket=${s3Config.bucket} prefix=${prefix} errorName=${name} message=${msg}`);
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
    if (handle.connectionType !== 's3') {
      return storageError('internal', 'S3Adapter requires an S3 connection handle.');
    }
    const { s3Config } = handle;
    const prefixes: string[] = [];
    let continuationToken: string | undefined;

    try {
      do {
        const output: ListObjectsV2CommandOutput = await s3Config.client.send(
          new ListObjectsV2Command({
            Bucket: s3Config.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: continuationToken,
          }),
        );
        for (const cp of output.CommonPrefixes ?? []) {
          if (cp.Prefix) prefixes.push(cp.Prefix);
        }
        continuationToken = output.NextContinuationToken;
      } while (continuationToken);

      return prefixes;
    } catch (raw) {
      const err = mapS3Error(raw);
      const name = (raw && typeof raw === 'object' && 'name' in raw) ? String((raw as { name: unknown }).name) : 'Error';
      const msg = (raw instanceof Error) ? raw.message : String(raw);
      this.logger.error(`S3 listCommonPrefixes failed: bucket=${s3Config.bucket} prefix=${prefix} errorName=${name} message=${msg}`);
      return err;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Ensures a prefix ends with "/" (S3 ListObjectsV2 convention).
 *  An empty prefix stays empty — ListObjectsV2 with Prefix="" lists all keys. */
function normalisePrefix(prefix: string): string {
  if (prefix === '') return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * Parses an S3 URI and returns the key portion.
 * Normalises s3a:// and s3n:// (Hadoop-style schemes written by Trino/Spark)
 * to s3:// before stripping the scheme+bucket prefix.
 * e.g. "s3a://bucket/prefix/key" → "prefix/key"
 *      "s3://bucket/prefix/key"  → "prefix/key"
 */
function s3UriToKey(uri: string): string {
  const normalised = uri.replace(/^s3[an]:\/\//, 's3://');
  const withoutScheme = normalised.replace(/^s3:\/\/[^/]+\//, '');
  return withoutScheme;
}

/**
 * Returns the key portion of an S3 URI as a prefix (with trailing slash stripped).
 */
function s3UriToKeyPrefix(uri: string): string {
  return s3UriToKey(uri).replace(/\/$/, '');
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

/** Reads a Node.js readable stream into a Buffer. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
