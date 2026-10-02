/**
 * Query Engine — uses @duckdb/duckdb-wasm for Parquet queries (NFR-10).
 *
 * DuckDB instance lifecycle
 * ─────────────────────────
 * One in-memory DuckDB WASM instance is created lazily on first use and shared
 * for the lifetime of the QueryEngine. Each query opens a fresh connection, runs,
 * and closes the connection. This avoids paying initialisation cost at construction
 * time while still re-using the loaded binary.
 *
 * Warm-up
 * ───────
 * `warmUp()` fires `getInstance()` as a fire-and-forget call at extension activation.
 * This loads the 37 MB WASM binary in the background Worker while the user browses
 * the tree, so the first Parquet preview or ad-hoc query incurs no perceptible delay.
 *
 * Avro parsing
 * ────────────
 * Manifest list and manifest file Avro reads use `avsc` (pure-JS), not DuckDB.
 * DuckDB WASM does not bundle the Avro scanner extension.
 *
 * Cancellation (FR-17)
 * ────────────────────
 * `cancelCurrentQuery()` calls `conn.cancelSent()` on the in-flight connection.
 * If the query promise resolves after cancelSent() but before we can check, we
 * discard the result and return a cancelled QueryError.
 *
 * Timeout watchdog (FR-16)
 * ────────────────────────
 * A 30-second `setTimeout` is armed before every DuckDB `query()` call. On
 * firing it calls `cancelCurrentQuery()` and records the reason as 'timeout'
 * so that the rejection handler can map it to the right QueryError class.
 *
 * File access
 * ───────────
 * WASM cannot open OS paths directly in SQL. Each Parquet file is read into a
 * Uint8Array, registered as a named virtual file via `db.registerFileBuffer`,
 * used in SQL by that virtual name, then dropped in the finally block.
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as avsc from 'avsc';
import * as vscode from 'vscode';
import { AsyncDuckDB, VoidLogger } from '@duckdb/duckdb-wasm';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { ILogger } from '../extension.js';
import {
  type QueryError,
  type QueryResult,
  type ManifestEntryRow,
  type DataFileRow,
  queryError,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;
const PREVIEW_LIMIT = 100;
const ADHOC_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strips internal paths, stack traces, and credentials from error messages. */
function sanitizeErrorMessage(message: string): string {
  // Strip stack traces (lines starting with 'at ')
  let cleaned = message.split('\n').filter((line) => !/^\s*at\s+/.test(line)).join('\n').trim();
  // Strip credential patterns
  cleaned = cleaned.replace(/(?:accessKey|secretKey|password|secret_access_key)\s*[:=]\s*\S+/gi, '[REDACTED]');
  // Replace temp file paths
  cleaned = cleaned.replace(/(?:\/[^\s'"\)]+)?\/tmp\/[^\s'"\)]+/g, '[temp-file]');
  // Replace virtual adhoc view name if mentioned
  cleaned = cleaned.replace(/adhoc_[a-zA-Z0-9_.-]+/g, 'data');
  return cleaned;
}

/** Maps a raw DuckDB/WASM Error to a QueryErrorClass. */
function classifyDuckDBError(raw: unknown): QueryError {
  if (raw instanceof Error) {
    const msg = raw.message.toLowerCase();
    if (
      msg.includes('file not found')
      || msg.includes('unable to open')
      || msg.includes('no such file')
      || msg.includes('io error')
    ) {
      return queryError('parse-failure', 'Could not read file for query.');
    }
    const cleanMsg = sanitizeErrorMessage(raw.message);
    return queryError('internal', cleanMsg || 'An unexpected query error occurred.');
  }
  return queryError('internal', 'An unexpected query error occurred.');
}

/** Maps an Iceberg schema type (string or nested object) to a DuckDB SQL type string. */
export function icebergTypeToDuckDB(type: unknown): string {
  if (typeof type === 'string') {
    const t = type.toLowerCase().trim();
    if (t === 'boolean') { return 'BOOLEAN'; }
    if (t === 'int' || t === 'integer') { return 'INTEGER'; }
    if (t === 'long') { return 'BIGINT'; }
    if (t === 'float') { return 'FLOAT'; }
    if (t === 'double') { return 'DOUBLE'; }
    if (t === 'date') { return 'DATE'; }
    if (t === 'time') { return 'TIME'; }
    if (t === 'timestamp' || t === 'timestamp-without-timezone') { return 'TIMESTAMP'; }
    if (t === 'timestamptz' || t === 'timestamp-with-timezone') { return 'TIMESTAMPTZ'; }
    if (t === 'string') { return 'VARCHAR'; }
    if (t === 'uuid') { return 'UUID'; }
    if (t === 'binary' || t.startsWith('fixed')) { return 'BLOB'; }
    if (t.startsWith('decimal')) { return t.toUpperCase(); }
    return 'VARCHAR';
  }
  if (typeof type === 'object' && type !== null) {
    const obj = type as Record<string, unknown>;
    if (obj['type'] === 'list' && obj['element']) {
      return `${icebergTypeToDuckDB(obj['element'])}[]`;
    }
    if (obj['type'] === 'map' && obj['key'] && obj['value']) {
      return `MAP(${icebergTypeToDuckDB(obj['key'])}, ${icebergTypeToDuckDB(obj['value'])})`;
    }
    if (obj['type'] === 'struct' && Array.isArray(obj['fields'])) {
      const inner = (obj['fields'] as Array<{ name: string; type: unknown }>)
        .map((f) => `"${String(f.name).replace(/"/g, '""')}" ${icebergTypeToDuckDB(f.type)}`)
        .join(', ');
      return `STRUCT(${inner})`;
    }
  }
  return 'VARCHAR';
}

// ---------------------------------------------------------------------------
// Avro BigInt Long Type
// ---------------------------------------------------------------------------

/**
 * Custom Avro LongType that decodes 64-bit integers into native JavaScript BigInt.
 *
 * avsc's default LongType throws "potential precision loss" for any int64 value
 * that exceeds Number.MAX_SAFE_INTEGER (2^53 - 1). Real Iceberg snapshot IDs and
 * sequence numbers routinely exceed this threshold.
 *
 * Using `avsc.types.LongType.__with(...)` plugs native BigInt decode and encode
 * (using Buffer.readBigInt64LE / writeBigInt64LE) into avsc's built-in zigzag varint
 * unpacker, avoiding precision loss and avoiding "truncated block" errors that occur
 * if schemas are improperly rewritten to "double".
 */
const BigIntLongType = avsc.types.LongType.__with({
  fromBuffer: (buf: Buffer) => buf.readBigInt64LE(),
  toBuffer: (n: bigint | number) => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(n));
    return buf;
  },
  fromJSON: (val: unknown) => BigInt(val as string | number | bigint),
  toJSON: (n: bigint) => n.toString(),
  isValid: (n: unknown) => typeof n === 'bigint' || (typeof n === 'number' && Number.isInteger(n)),
  compare: (n1: bigint, n2: bigint) => (n1 < n2 ? -1 : (n1 > n2 ? 1 : 0)),
});

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

/** Recursively converts BigInt values to Number for JSON-safe row objects. */
function normalizeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') { return Number(value); }
  if (Array.isArray(value)) { return value.map(normalizeBigInt); }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeBigInt(v)]),
    );
  }
  return value;
}

export class QueryEngine {
  /** Lazily-initialised in-memory DuckDB WASM instance. */
  private instancePromise: Promise<AsyncDuckDB> | null = null;

  /** The raw worker_threads.Worker backing the DuckDB WASM instance. */
  private rawWorker: Worker | null = null;

  /** Connection currently executing a query, used by cancelCurrentQuery(). */
  private currentConnection: AsyncDuckDBConnection | null = null;

  /**
   * Set by the timeout watchdog so that the catch handler can distinguish a
   * timeout from a user-initiated cancel.
   */
  private pendingCancelReason: 'timeout' | 'cancelled' | null = null;

  constructor(
    private readonly logger: ILogger,
    private readonly extensionUri: vscode.Uri,
  ) {}

  // ─── Dispose ─────────────────────────────────────────────────────────────

  /**
   * Release resources held by this engine. Should be called on extension
   * deactivation by pushing `{ dispose: () => queryEngine.dispose() }` to
   * `context.subscriptions`.
   */
  dispose(): void {
    if (this.rawWorker) {
      void this.rawWorker.terminate();
      this.rawWorker = null;
    }
    this.instancePromise = null;
  }

  // ─── Warm-up ─────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget warm-up: starts WASM loading in the background Worker at
   * extension activation so the first Parquet query incurs no delay.
   * Logs a warning if pre-warm fails; lazy init will retry on the first real query.
   */
  warmUp(): void {
    void this.getInstance().catch((err: unknown) => {
      this.logger.warn(`DuckDB WASM warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ─── Lazy instance ───────────────────────────────────────────────────────

  private getInstance(): Promise<AsyncDuckDB> {
    if (!this.instancePromise) {
      this.instancePromise = this.initDuckDB().catch((err) => {
        this.instancePromise = null;
        throw err;
      });
    }
    return this.instancePromise;
  }

  private resolveDuckDBPaths(): { wasmPath: string; nodeWorkerScript: string; nodeWorkerMod: string } {
    const outDir = vscode.Uri.joinPath(this.extensionUri, 'out');
    const ehWasm = vscode.Uri.joinPath(outDir, 'duckdb-eh.wasm').fsPath;
    const mvpWasm = vscode.Uri.joinPath(outDir, 'duckdb-mvp.wasm').fsPath;
    const wasmPath = existsSync(ehWasm) ? ehWasm : mvpWasm;

    const nodeWorkerScript = vscode.Uri.joinPath(outDir, 'duckdb-node.cjs').fsPath;

    const ehWorkerMod = vscode.Uri.joinPath(outDir, 'duckdb-node-eh.worker.cjs').fsPath;
    const mvpWorkerMod = vscode.Uri.joinPath(outDir, 'duckdb-node-mvp.worker.cjs').fsPath;
    const nodeWorkerMod = existsSync(ehWorkerMod) ? ehWorkerMod : mvpWorkerMod;

    if (!existsSync(nodeWorkerScript) || !existsSync(nodeWorkerMod) || !existsSync(wasmPath)) {
      // Development fallback: check if @duckdb/duckdb-wasm is available in extensionUri/node_modules
      const duckdbWasmDist = path.join(
        this.extensionUri.fsPath,
        'node_modules',
        '@duckdb',
        'duckdb-wasm',
        'dist',
      );
      const fallbackEhWasm = path.join(duckdbWasmDist, 'duckdb-eh.wasm');
      const fallbackMvpWasm = path.join(duckdbWasmDist, 'duckdb-mvp.wasm');
      const fallbackWasm = existsSync(fallbackEhWasm) ? fallbackEhWasm : fallbackMvpWasm;

      const fallbackWorkerScript = path.join(duckdbWasmDist, 'duckdb-node.cjs');

      const fallbackEhWorkerMod = path.join(duckdbWasmDist, 'duckdb-node-eh.worker.cjs');
      const fallbackMvpWorkerMod = path.join(duckdbWasmDist, 'duckdb-node-mvp.worker.cjs');
      const fallbackWorkerMod = existsSync(fallbackEhWorkerMod) ? fallbackEhWorkerMod : fallbackMvpWorkerMod;

      if (existsSync(fallbackWasm) && existsSync(fallbackWorkerScript) && existsSync(fallbackWorkerMod)) {
        return { wasmPath: fallbackWasm, nodeWorkerScript: fallbackWorkerScript, nodeWorkerMod: fallbackWorkerMod };
      }
    }

    if (!existsSync(nodeWorkerScript) || !existsSync(nodeWorkerMod) || !existsSync(wasmPath)) {
      const missing = [
        !existsSync(nodeWorkerScript) ? nodeWorkerScript : null,
        !existsSync(nodeWorkerMod) ? nodeWorkerMod : null,
        !existsSync(wasmPath) ? wasmPath : null,
      ].filter(Boolean).join(', ');
      throw new Error(`DuckDB WASM files missing: ${missing}. Please run "npm run copy-wasm".`);
    }

    return { wasmPath, nodeWorkerScript, nodeWorkerMod };
  }

  private async initDuckDB(): Promise<AsyncDuckDB> {
    const { wasmPath, nodeWorkerScript, nodeWorkerMod } = this.resolveDuckDBPaths();

    return new Promise<AsyncDuckDB>((resolve, reject) => {
      let isSettled = false;
      const initTimeout = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          this.dispose();
          reject(new Error('DuckDB WASM initialization timed out after 15 seconds.'));
        }
      }, 15000);

      try {
        this.rawWorker = new Worker(nodeWorkerScript, {
          workerData: { mod: nodeWorkerMod, name: 'duckdb', type: 'commonjs' },
        });
        this.rawWorker.unref();
        const rawWorker = this.rawWorker;

        rawWorker.on('error', (err: Error) => {
          this.logger.error(`DuckDB worker error: ${err.message}`);
          if (!isSettled) {
            isSettled = true;
            clearTimeout(initTimeout);
            this.dispose();
            reject(err);
          }
        });

        rawWorker.on('exit', (code) => {
          if (!isSettled && code !== 0) {
            isSettled = true;
            clearTimeout(initTimeout);
            this.dispose();
            reject(new Error(`DuckDB worker exited prematurely with code ${code}`));
          }
        });

        const workerShim = {
          addEventListener(type: string, handler: (e: { data: unknown }) => void) {
            if (type === 'message') {
              rawWorker.on('message', (data) => handler({ data }));
            } else if (type === 'error') {
              rawWorker.on('error', handler as unknown as (err: Error) => void);
            } else if (type === 'close') {
              rawWorker.on('exit', () => (handler as () => void)());
            }
          },
          removeEventListener(_type: string, _handler: unknown) { /* no-op */ },
          postMessage(msg: unknown, transfer: unknown[]) {
            rawWorker.postMessage(msg, (transfer as ArrayBuffer[]) ?? []);
          },
          terminate() { void rawWorker.terminate(); },
        };

        const db = new AsyncDuckDB(new VoidLogger(), workerShim as unknown as Worker);
        db.instantiate(wasmPath)
          .then(async () => {
            await db.open({ path: ':memory:' });
            if (!isSettled) {
              isSettled = true;
              clearTimeout(initTimeout);
              resolve(db);
            }
          })
          .catch((err: unknown) => {
            if (!isSettled) {
              isSettled = true;
              clearTimeout(initTimeout);
              this.dispose();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
      } catch (err: unknown) {
        clearTimeout(initTimeout);
        this.dispose();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Cancellation (FR-17) ────────────────────────────────────────────────

  /** Cancel any in-flight DuckDB query. Safe to call when no query is running. */
  cancelCurrentQuery(): void {
    if (this.currentConnection) {
      if (!this.pendingCancelReason) {
        this.pendingCancelReason = 'cancelled';
      }
      try {
        void this.currentConnection.cancelSent();
      } catch {
        // cancelSent() may throw if connection is already closed; ignore.
      }
    }
  }

  // ─── Low-level query executor ─────────────────────────────────────────────

  /**
   * Executes `sql` on a fresh connection with the 30-second watchdog armed.
   * Reads the file(s) at `tempFilePath` into virtual WASM buffer(s), executes,
   * extracts Arrow result into plain JS objects, then drops the virtual file(s).
   * Closes the connection and disarms the watchdog in all code paths.
   */
  private async runQuery(
    sql: string,
    queryType: 'preview' | 'adhoc',
    tempFilePath: string | string[],
    virtualName: string,
    tableName?: string,
  ): Promise<{ rows: Record<string, unknown>[]; columnNames: string[] }> {
    const db = await this.getInstance();
    const files = Array.isArray(tempFilePath) ? tempFilePath : [tempFilePath];
    const registeredNames: string[] = [];

    // Register all file buffers; ensure they are always dropped even if connect() throws.
    try {
      for (let i = 0; i < files.length; i++) {
        const vName = files.length === 1 ? virtualName : `${virtualName}_${i}.parquet`;
        const buffer = await fs.readFile(files[i]);
        await db.registerFileBuffer(vName, new Uint8Array(buffer));
        registeredNames.push(vName);
      }

      const conn = await db.connect();
      this.currentConnection = conn;
      this.pendingCancelReason = null;

      this.logger.info(`Query started: files=${files.length} queryType=${queryType}`);

      // Arm the timeout watchdog (FR-16, QE-V4)
      let watchdogFired = false;
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        this.pendingCancelReason = 'timeout';
        this.logger.error(`Query timed out: durationMs=${TIMEOUT_MS}`);
        this.cancelCurrentQuery();
      }, TIMEOUT_MS);

      try {
        if (queryType === 'adhoc') {
          const parquetSources = registeredNames.map(n => `'${n}'`).join(', ');
          const readParquetSql = registeredNames.length === 1
            ? `read_parquet('${registeredNames[0]}')`
            : `read_parquet([${parquetSources}])`;
          await conn.query(
            `CREATE OR REPLACE TEMPORARY VIEW data AS SELECT * FROM ${readParquetSql}`,
          );
          if (tableName && tableName !== 'data') {
            await conn.query(
              `CREATE OR REPLACE TEMPORARY VIEW "${tableName}" AS SELECT * FROM data`,
            );
          }
        }

        const table = await conn.query(sql);
        clearTimeout(watchdog);

        if (watchdogFired || this.pendingCancelReason) {
          const reason = this.pendingCancelReason ?? 'cancelled';
          throw Object.assign(new Error('Query interrupted'), { _qeReason: reason });
        }

        const columnNames = table.schema.fields.map((f) => f.name);
        // toJSON() may return BigInt values for int64 columns; normalise to Number
        // so rows are JSON-safe and consistent with the previous node-api behaviour.
        const rows = table.toArray().map(
          (r) => normalizeBigInt(r.toJSON()) as Record<string, unknown>,
        );

        return { rows, columnNames };
      } finally {
        clearTimeout(watchdog);
        this.currentConnection = null;
        if (queryType === 'adhoc') {
          try { await conn.query('DROP VIEW IF EXISTS data'); } catch { /* ignore */ }
          if (tableName && tableName !== 'data') {
            try { await conn.query(`DROP VIEW IF EXISTS "${tableName}"`); } catch { /* ignore */ }
          }
        }
        try { await conn.close(); } catch { /* ignore */ }
      }
    } finally {
      // Always drop the virtual files, whether connect() succeeded or not.
      for (const vName of registeredNames) {
        try { await db.dropFile(vName); } catch { /* ignore */ }
      }
    }
  }

  // ─── Avro helper ─────────────────────────────────────────────────────────

  /**
   * Reads all records from an Avro container file using avsc (pure-JS, no DuckDB).
   * `createFileDecoder` is EventEmitter-based, so we wrap it in a Promise.
   *
   * Iceberg manifest avros embed schemas that use Avro `long` for snapshot IDs,
   * sequence numbers, and file sizes. We configure `parseHook` with `BigIntLongType`
   * via both `registry: { long: BigIntLongType }` and `typeHook` to intercept all
   * long-typed schema nodes (including object schemas and logical types).
   */
  private readAvroFile(filePath: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const records: Record<string, unknown>[] = [];
      avsc.createFileDecoder(filePath, {
        parseHook: (schema: unknown) =>
          avsc.Type.forSchema(schema as avsc.Schema, {
            typeHook: (nodeSchema: unknown) => {
              if (
                nodeSchema === 'long'
                || (typeof nodeSchema === 'object' && nodeSchema !== null && (nodeSchema as Record<string, unknown>)['type'] === 'long')
              ) {
                return BigIntLongType;
              }
            },
            registry: { long: BigIntLongType },
          }),
      })
        .on('data', (record: unknown) => records.push(record as Record<string, unknown>))
        .on('end', () => resolve(records))
        .on('error', reject);
    });
  }

  // ─── QE-V1: file existence validation ────────────────────────────────────

  private validateTempFile(tempFilePath: string): QueryError | null {
    // existsSync is a cheap guard — avoids async overhead before any real I/O
    if (!tempFilePath || !existsSync(tempFilePath)) {
      this.logger.error('Query failed: errorClass=internal');
      return queryError('internal', 'Temp file not found before query execution.');
    }
    return null;
  }

  // ─── Public methods ───────────────────────────────────────────────────────

  /**
   * Parse an Iceberg manifest list Avro file (FR-10, FR-11).
   * Returns `ManifestEntryRow[]` on success, `QueryError` on failure.
   */
  async parseManifestList(tempFilePath: string): Promise<ManifestEntryRow[] | QueryError> {
    const fileErr = this.validateTempFile(tempFilePath);
    if (fileErr) { return fileErr; }

    try {
      const rows = await this.readAvroFile(tempFilePath);

      const mapped: ManifestEntryRow[] = rows.map((row) => ({
        manifestPath:      String(row['manifest_path'] ?? row['manifestPath'] ?? ''),
        manifestLength:    Number(row['manifest_length'] ?? row['manifestLength'] ?? 0),
        partitionSpecId:   Number(row['partition_spec_id'] ?? row['partitionSpecId'] ?? 0),
        content:           Number(row['content'] ?? 0),
        snapshotId:        Number(row['added_snapshot_id'] ?? row['snapshotId'] ?? 0),
        addedFilesCount:   row['added_files_count'] != null ? Number(row['added_files_count']) : undefined,
        existingFilesCount: row['existing_files_count'] != null ? Number(row['existing_files_count']) : undefined,
        deletedFilesCount: row['deleted_files_count'] != null ? Number(row['deleted_files_count']) : undefined,
      }));

      this.logger.info(`Query completed: rows=${mapped.length} durationMs=0 capped=false`);
      return mapped;
    } catch (err: unknown) {
      this.logger.error(`Avro parse detail: ${err instanceof Error ? err.message : String(err)}`);
      return this.handleQueryError(err, true);
    }
  }

  /**
   * Parse an Iceberg manifest file Avro (FR-10, FR-11).
   * avsc surfaces nested `data_file` STRUCT columns as nested objects (OQ-2).
   * Returns `DataFileRow[]` on success, `QueryError` on failure.
   */
  async parseManifestFile(tempFilePath: string): Promise<DataFileRow[] | QueryError> {
    const fileErr = this.validateTempFile(tempFilePath);
    if (fileErr) { return fileErr; }

    try {
      const rows = await this.readAvroFile(tempFilePath);

      const mapped: DataFileRow[] = rows.map((row) => {
        // avsc returns nested `data_file` STRUCT as a nested object.
        // Keep dot-notation fallbacks for compatibility with DuckDB-serialised fixtures.
        const dataFile = row['data_file'] as Record<string, unknown> | undefined;
        const filePath    = String(
          row['data_file.file_path'] ?? dataFile?.['file_path'] ?? row['file_path'] ?? '',
        );
        const fileFormat  = String(
          row['data_file.file_format'] ?? dataFile?.['file_format'] ?? row['file_format'] ?? '',
        );
        const recordCount = Number(
          row['data_file.record_count'] ?? dataFile?.['record_count'] ?? row['record_count'] ?? 0,
        );
        const fileSizeBytes = Number(
          row['data_file.file_size_in_bytes'] ?? dataFile?.['file_size_in_bytes'] ?? row['file_size_in_bytes'] ?? 0,
        );
        const partitionValues = (row['data_file.partition'] ?? dataFile?.['partition'] ?? row['partition']) as
          | Record<string, unknown>
          | undefined;
        const columnSizes = (row['data_file.column_sizes'] ?? dataFile?.['column_sizes'] ?? row['column_sizes']) as
          | Record<string, unknown>
          | undefined;

        return {
          status: Number(row['status'] ?? 0),
          filePath,
          fileFormat,
          recordCount,
          fileSizeBytes,
          partitionValues: partitionValues ? (normalizeBigInt(partitionValues) as Record<string, unknown>) : undefined,
          columnSizes: columnSizes ? (normalizeBigInt(columnSizes) as Record<string, unknown>) : undefined,
        };
      });

      this.logger.info(`Query completed: rows=${mapped.length} durationMs=0 capped=false`);
      return mapped;
    } catch (err: unknown) {
      return this.handleQueryError(err, true);
    }
  }

  /**
   * Preview the first 100 rows of a Parquet file (FR-13).
   * Returns `QueryResult` on success, `QueryError` on failure.
   */
  async previewParquet(tempFilePath: string): Promise<QueryResult | QueryError> {
    const fileErr = this.validateTempFile(tempFilePath);
    if (fileErr) { return fileErr; }

    // Strip single-quotes from the basename to keep the SQL literal safe.
    const virtualName = `preview_${path.basename(tempFilePath).replace(/'/g, '')}`;
    const sql = `SELECT * FROM read_parquet('${virtualName}') LIMIT ${PREVIEW_LIMIT}`;
    const start = Date.now();
    try {
      const { rows, columnNames } = await this.runQuery(sql, 'preview', tempFilePath, virtualName);
      const durationMs = Date.now() - start;
      const wasCapped = rows.length === PREVIEW_LIMIT;

      this.logger.info(
        `Query completed: rows=${rows.length} durationMs=${durationMs} capped=${wasCapped}`,
      );

      return {
        rows,
        columnNames,
        rowCount: rows.length,
        wasCapped,
        durationMs,
      };
    } catch (err: unknown) {
      return this.handleQueryError(err);
    }
  }

  /**
   * Execute user-supplied ad-hoc SQL against Parquet file(s) (FR-14, FR-15).
   * Injects `LIMIT 10000` when no LIMIT clause is present (QE-V3).
   * Queries reference the Parquet data using the `data` view (e.g. `SELECT * FROM data`)
   * or the table view if tableName is provided.
   * Returns `QueryResult` on success, `QueryError` on failure.
   */
  async runAdHocQuery(
    tempFilePath: string | string[],
    sql: string,
    tableName?: string,
  ): Promise<QueryResult | QueryError> {
    // QE-V2: empty SQL guard
    if (!sql.trim()) {
      return queryError('internal', 'Query cannot be empty.');
    }

    const files = Array.isArray(tempFilePath) ? tempFilePath : [tempFilePath];
    if (files.length === 0) {
      return queryError('internal', 'No data files provided for query.');
    }

    for (const f of files) {
      const fileErr = this.validateTempFile(f);
      if (fileErr) { return fileErr; }
    }

    // Strip single-quotes from the basename to keep the SQL literal safe.
    const virtualName = `adhoc_${path.basename(files[0]).replace(/'/g, '')}`;

    // QE-V3: inject LIMIT if absent
    let finalSql = sql;
    const hasLimit = /\bLIMIT\b/i.test(finalSql);
    if (!hasLimit) {
      finalSql = `${finalSql.trim().replace(/;+\s*$/, '')}\nLIMIT ${ADHOC_LIMIT}`;
      this.logger.warn(`Row cap applied: limit=${ADHOC_LIMIT}`);
    }

    const start = Date.now();
    try {
      const { rows, columnNames } = await this.runQuery(finalSql, 'adhoc', files, virtualName, tableName);
      const durationMs = Date.now() - start;
      const wasCapped = !hasLimit && rows.length === ADHOC_LIMIT;

      this.logger.info(
        `Query completed: rows=${rows.length} durationMs=${durationMs} capped=${wasCapped}`,
      );

      return {
        rows,
        columnNames,
        rowCount: rows.length,
        wasCapped,
        durationMs,
      };
    } catch (err: unknown) {
      return this.handleQueryError(err);
    }
  }

  /**
   * Pre-flight validation of an ad-hoc SQL query against a table schema.
   * Runs in-memory with DuckDB WASM without reading or downloading any Parquet files.
   * Returns `null` if the query is valid, or `QueryError` if invalid (e.g. non-existent column, syntax error).
   */
  async validateQuery(
    sql: string,
    columns?: Array<{ name: string; type?: unknown }>,
    tableName?: string,
  ): Promise<QueryError | null> {
    if (!sql || !sql.trim()) {
      return queryError('internal', 'Query cannot be empty.');
    }

    if (!columns || columns.length === 0) {
      return null;
    }

    let finalSql = sql;
    const hasLimit = /\bLIMIT\b/i.test(finalSql);
    if (!hasLimit) {
      finalSql = `${finalSql.trim().replace(/;+\s*$/, '')}\nLIMIT ${ADHOC_LIMIT}`;
    }

    const db = await this.getInstance();
    const conn = await db.connect();
    this.currentConnection = conn;
    this.pendingCancelReason = null;

    const sanitizedTable = tableName?.replace(/[^a-zA-Z0-9_]/g, '_');

    try {
      const typedCols = columns
        .map((c) => `CAST(NULL AS ${icebergTypeToDuckDB(c.type)}) AS "${c.name.replace(/"/g, '""')}"`)
        .join(', ');

      try {
        await conn.query(`CREATE OR REPLACE TEMPORARY VIEW data AS SELECT ${typedCols} WHERE 1 = 0`);
      } catch {
        const varcharCols = columns
          .map((c) => `CAST(NULL AS VARCHAR) AS "${c.name.replace(/"/g, '""')}"`)
          .join(', ');
        await conn.query(`CREATE OR REPLACE TEMPORARY VIEW data AS SELECT ${varcharCols} WHERE 1 = 0`);
      }

      if (sanitizedTable && sanitizedTable !== 'data') {
        await conn.query(`CREATE OR REPLACE TEMPORARY VIEW "${sanitizedTable}" AS SELECT * FROM data`);
      }

      await conn.query(finalSql);
      return null;
    } catch (err: unknown) {
      return this.handleQueryError(err);
    } finally {
      this.currentConnection = null;
      try { await conn.query('DROP VIEW IF EXISTS data'); } catch { /* ignore */ }
      if (sanitizedTable && sanitizedTable !== 'data') {
        try { await conn.query(`DROP VIEW IF EXISTS "${sanitizedTable}"`); } catch { /* ignore */ }
      }
      try { await conn.close(); } catch { /* ignore */ }
    }
  }

  // ─── Error handler ────────────────────────────────────────────────────────

  private handleQueryError(err: unknown, isAvro = false): QueryError {
    // Check if this is a watchdog / cancel interruption
    if (err instanceof Error) {
      const reason = (err as Error & { _qeReason?: string })._qeReason;
      if (reason === 'timeout') {
        this.logger.error('Query failed: errorClass=timeout');
        return queryError('timeout', 'Query timed out after 30 seconds.');
      }
      if (reason === 'cancelled') {
        this.logger.error('Query failed: errorClass=cancelled');
        return queryError('cancelled', 'Operation cancelled.');
      }
    }

    // avsc errors are always parse failures — the file was readable but not a
    // valid / compatible Avro container.  classifyDuckDBError only understands
    // DuckDB message strings and must not be used for the avsc path.
    if (isAvro) {
      this.logger.error('Query failed: errorClass=parse-failure');
      return queryError('parse-failure', 'Could not parse Avro file.');
    }

    // Delegate to classifyDuckDBError for DuckDB-backed methods only.
    const qErr = classifyDuckDBError(err);
    this.logger.error(`Query failed: errorClass=${qErr.class}`);
    return qErr;
  }
}
