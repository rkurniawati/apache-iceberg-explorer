/**
 * LocalFsAdapter — Storage Layer adapter for local file system warehouses (AD-3, FR-5).
 *
 * Implements StorageAdapter using Node.js `fs/promises`.
 * All methods return a value or a StorageError; they never throw (design.md §2.5.2).
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(zlib.gunzip);

import type { StorageAdapter } from './StorageAdapter.js';
import type { ActiveConnectionHandle, MetadataVersionEntry, DirectoryContentsResult } from './types.js';
import { mapNodeError, storageError, type StorageError } from './errors.js';
import type { ILogger } from '../extension.js';

export class LocalFsAdapter implements StorageAdapter {
  constructor(private readonly logger: ILogger) {}

  // -------------------------------------------------------------------------
  // listSchemas — top-level directories under warehousePath
  // -------------------------------------------------------------------------

  async listSchemas(handle: ActiveConnectionHandle): Promise<string[] | StorageError> {
    const warehousePath = handle.warehousePath;
    try {
      const entries = await fs.readdir(warehousePath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(warehousePath, e.name));
    } catch (raw) {
      return mapNodeError(raw);
    }
  }

  // -------------------------------------------------------------------------
  // listTables — directories under the given schema path
  // -------------------------------------------------------------------------

  async listTables(
    handle: ActiveConnectionHandle,
    schemaPath: string,
  ): Promise<string[] | StorageError> {
    const guard = this.pathGuard(handle.warehousePath, schemaPath);
    if (guard) return guard;

    try {
      const entries = await fs.readdir(schemaPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(schemaPath, e.name));
    } catch (raw) {
      return mapNodeError(raw);
    }
  }

  // -------------------------------------------------------------------------
  // listMetadataVersions — *.metadata.json under <tablePath>/metadata/, newest-first
  // -------------------------------------------------------------------------

  async listMetadataVersions(
    handle: ActiveConnectionHandle,
    tablePath: string,
  ): Promise<MetadataVersionEntry[] | StorageError> {
    const guard = this.pathGuard(handle.warehousePath, tablePath);
    if (guard) return guard;

    const metaDir = path.join(tablePath, 'metadata');
    const metaDirGuard = this.pathGuard(handle.warehousePath, metaDir);
    if (metaDirGuard) return metaDirGuard;

    try {
      const entries = await fs.readdir(metaDir, { withFileTypes: true });
      const jsonFiles = entries.filter(
        (e) => e.isFile() && e.name.endsWith('.metadata.json'),
      );

      const versions: MetadataVersionEntry[] = await Promise.all(
        jsonFiles.map(async (e): Promise<MetadataVersionEntry> => {
          const resourcePath = path.join(metaDir, e.name);
          const sortKey = extractSequenceNumber(e.name)
            ?? (await fileMtime(resourcePath));
          return { label: e.name, resourcePath, sortKey };
        }),
      );

      // newest-first (higher sortKey = newer)
      return versions.sort((a, b) => b.sortKey - a.sortKey);
    } catch (raw) {
      return mapNodeError(raw);
    }
  }

  // -------------------------------------------------------------------------
  // fetchMetadataJson — read and JSON.parse in-memory (no temp file)
  // -------------------------------------------------------------------------

  async fetchMetadataJson(
    handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<unknown | StorageError> {
    const guard = this.pathGuard(handle.warehousePath, filePath);
    if (guard) return guard;

    this.logger.info(`Fetch started: path=${filePath} source=local`);

    try {
      const buffer = await fs.readFile(filePath);
      const isGzip = filePath.endsWith('.gz') || filePath.endsWith('.gz.metadata.json') || (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
      const text = isGzip ? (await gunzipAsync(buffer)).toString('utf-8') : buffer.toString('utf-8');
      return JSON.parse(text);
    } catch (raw) {
      const err = mapNodeError(raw);
      this.logger.error(`Fetch failed: path=${filePath} errorClass=${err.class}`);
      return err;
    }
  }

  // -------------------------------------------------------------------------
  // fetchFileToTemp — copy file to os.tmpdir()/iceberg-explorer/<uuid>/<filename>
  // -------------------------------------------------------------------------

  async fetchFileToTemp(
    handle: ActiveConnectionHandle,
    filePath: string,
  ): Promise<string | StorageError> {
    const guard = this.pathGuard(handle.warehousePath, filePath);
    if (guard) return guard;

    // SL-V5: verify tmpdir is writable
    const tmpWritable = await checkTmpDirWritable();
    if (tmpWritable) return tmpWritable;

    this.logger.info(`Fetch started: path=${filePath} source=local`);

    const uuid = crypto.randomUUID();
    const destDir = path.join(os.tmpdir(), 'iceberg-explorer', uuid);
    const destFile = path.join(destDir, path.basename(filePath));

    try {
      await fs.mkdir(destDir, { recursive: true });
      await fs.copyFile(filePath, destFile);
      this.logger.info(`Temp file written: ${destFile}`);
      return destFile;
    } catch (raw) {
      const err = mapNodeError(raw);
      this.logger.error(`Fetch failed: path=${filePath} errorClass=${err.class}`);
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
    const guard = this.pathGuard(handle.warehousePath, dirPath);
    if (guard) return guard;

    this.logger.info(`Listing directory: path=${dirPath} source=local`);

    const resolvedPath = path.resolve(dirPath);

    try {
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const subdirectories: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          subdirectories.push(entry.name);
        } else if (!entry.name.endsWith('.COMPLETE.gz')) {
          files.push(entry.name);
        }
      }

      return { subdirectories, files };
    } catch (raw: unknown) {
      // ENOENT: directory does not exist — return empty result (Note 7: not an error)
      if (
        typeof raw === 'object' &&
        raw !== null &&
        (raw as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return { subdirectories: [], files: [] };
      }
      return mapNodeError(raw);
    }
  }

  async deleteTemp(filePath: string): Promise<void | StorageError> {
    try {
      await fs.rm(filePath, { recursive: true, force: true });
    } catch (raw) {
      // `force: true` suppresses ENOENT; anything else is an OS anomaly — log and ignore
      const err = mapNodeError(raw);
      this.logger.warn(`Temp file deletion failed (already absent): ${filePath}`);
      // Return void — do not surface to caller per design.md §2.6.3
      void err;
    }
  }

  // -------------------------------------------------------------------------
  // isTable — probes if <dirPath>/metadata exists and is a directory in O(1)
  // -------------------------------------------------------------------------

  async isTable(handle: ActiveConnectionHandle, dirPath: string): Promise<boolean | StorageError> {
    const metaDir = path.join(dirPath, 'metadata');
    const guard = this.pathGuard(handle.warehousePath, metaDir);
    if (guard) return guard;

    try {
      const stat = await fs.stat(metaDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }


  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Path traversal guard (SL-V4).
   * Returns an access-denied StorageError if `targetPath` escapes `warehouseRoot`.
   */
  private pathGuard(warehouseRoot: string, targetPath: string): StorageError | undefined {
    const resolvedRoot = path.resolve(warehouseRoot);
    const resolvedTarget = path.resolve(targetPath);
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
      return storageError(
        'access-denied',
        'Path traversal detected: access denied.',
      );
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the leading numeric sequence from a metadata filename.
 * e.g. "00003-abc.metadata.json" → 3; "v3.metadata.json" → 3; "metadata.json" → undefined.
 */
function extractSequenceNumber(filename: string): number | undefined {
  const match = /^(?:v?(\d+)|(\d+)-)/.exec(filename);
  if (!match) return undefined;
  const num = match[1] ?? match[2];
  return num !== undefined ? parseInt(num, 10) : undefined;
}

/** Returns the mtime of the file as a Unix timestamp in ms, or 0 on error. */
async function fileMtime(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * SL-V5: verifies os.tmpdir() is writable.
 * Returns a StorageError if not writable, undefined if writable.
 */
async function checkTmpDirWritable(): Promise<StorageError | undefined> {
  const tmpDir = os.tmpdir();
  try {
    await fs.access(tmpDir, fsSync.constants.W_OK);
    return undefined;
  } catch {
    return storageError('internal', 'Temp directory is not writable.');
  }
}
