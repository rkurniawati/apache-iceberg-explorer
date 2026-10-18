/**
 * Connection Manager — persists connection configs and credentials, constructs
 * the active-connection handle (FR-1 through FR-6c, AD-4, NFR-7).
 *
 * This is the ONLY component that touches VS Code SecretStorage.
 * Credentials never appear in logs, globalState, or workspace files.
 */

import * as vscode from 'vscode';
import { Agent } from 'node:https';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Storage, type StorageOptions } from '@google-cloud/storage';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ILogger } from '../extension.js';
import type { ConnectionConfig } from './types.js';
import type { ActiveConnectionHandle, S3Config, GcsConfig } from '../storage/types.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { validateConnectionInput, validateWarehouseStructure } from './validation.js';
import { findCandidateWarehouseRoots } from './discovery.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of connection configs kept in globalState (FR-6b). */
const MAX_CONFIGS = 5;

/** Key used to store the ordered list of configs in globalState. */
const GLOBAL_STATE_KEY = 'icebergExplorer.connections';

/** Prefix for SecretStorage keys. Full key = <PREFIX><config.id> */
const SECRET_KEY_PREFIX = 'icebergExplorer.credentials.';

// ---------------------------------------------------------------------------
// Credential shapes stored in SecretStorage (NFR-7)
// ---------------------------------------------------------------------------

/**
 * The value stored under a SecretStorage key.
 * Serialised as JSON; the field names are deliberately opaque.
 */
interface StoredCredential {
  ak: string;  // accessKey
  sk: string;  // secretKey
}

/**
 * Checks whether a credential value is a masked placeholder (e.g. asterisks or bullets)
 * or empty.
 */
export function isMaskedCredential(val?: string): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  if (trimmed === '' || trimmed === '••••••••' || trimmed === '********') {
    return true;
  }
  return /^[\u2022*]+$/.test(trimmed);
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private readonly _globalState: vscode.Memento;
  private readonly _secrets: vscode.SecretStorage;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _logger: ILogger,
  ) {
    this._globalState = _context.globalState;
    this._secrets = _context.secrets;
    this._logger.info('ConnectionManager initialised');
  }

  /**
   * Checks whether credentials exist in SecretStorage for the given connection ID.
   */
  async hasCredential(id: string): Promise<boolean> {
    const configs = this._readConfigs();
    const config = configs.find((c) => c.id === id);
    if (config?.connectionType === 'gcs' && (config.gcsAuthType === 'adc' || !config.gcsAuthType)) {
      return true;
    }
    const cred = await this._loadCredential(id);
    return cred !== undefined;
  }

  // -------------------------------------------------------------------------
  // T-08 / T-09: Save (create or update) a connection configuration
  // -------------------------------------------------------------------------

  /**
   * Validates and persists a connection configuration.
   * - Validates all fields against CM-V1 through CM-V5 and unique connection names.
   * - For S3 connections, credentials are saved to SecretStorage under
   *   `icebergExplorer.credentials.<id>` (T-08). If editing an existing connection
   *   and masked or empty credentials are provided, existing stored credentials
   *   are preserved.
   * - Non-secret config is appended to globalState array under `icebergExplorer.connections`.
   * - Enforces LRU cap of 5 connections (T-09).
   *
   * @param config    - Non-credential connection fields. `id` may be omitted for new connections;
   *                    if present the existing entry is updated.
   * @param credentials - accessKey and secretKey (only ever used for S3; ignored for local).
   * @returns The id of the saved connection, or an Error if validation fails.
   */
  async saveConnection(
    config: Omit<ConnectionConfig, 'id' | 'savedAt'> & { id?: string },
    credentials: { accessKey?: string; secretKey?: string },
    adapter?: StorageAdapter,
  ): Promise<string | Error> {
    const fullConfig: ConnectionConfig = {
      ...config,
      label: config.label.trim(),
      id: config.id ?? crypto.randomUUID(),
      savedAt: Date.now(),
    };

    const configs = this._readConfigs();

    let effectiveAccessKey = credentials.accessKey ? credentials.accessKey.trim() : '';
    let effectiveSecretKey = credentials.secretKey ? credentials.secretKey.trim() : '';

    if (fullConfig.connectionType === 's3' || fullConfig.connectionType === 'gcs') {
      const existingCred = fullConfig.id ? await this._loadCredential(fullConfig.id) : undefined;
      if (isMaskedCredential(effectiveAccessKey)) {
        effectiveAccessKey = existingCred?.ak ?? '';
      }
      if (isMaskedCredential(effectiveSecretKey)) {
        effectiveSecretKey = existingCred?.sk ?? '';
      }
    }

    const effectiveCreds = {
      accessKey: effectiveAccessKey,
      secretKey: effectiveSecretKey,
    };

    // CM-V1 through CM-V5 and unique connection name validation
    const validation = validateConnectionInput(fullConfig, effectiveCreds, configs);
    if (!validation.valid) {
      const msg = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      this._logger.warn(`ConnectionManager.saveConnection: validation failed — ${msg}`);
      return new Error(`Validation failed: ${msg}`);
    }

    if (adapter) {
      let handle: ActiveConnectionHandle;
      if (fullConfig.connectionType === 's3') {
        const s3Config = buildS3Config(fullConfig, {
          ak: effectiveCreds.accessKey.trim(),
          sk: effectiveCreds.secretKey.trim(),
        });
        handle = {
          connectionType: 's3',
          warehousePath: fullConfig.warehousePath,
          s3Config,
        };
      } else if (fullConfig.connectionType === 'gcs') {
        const gcsConfig = buildGcsConfig(fullConfig, {
          ak: 'gcs',
          sk: effectiveCreds.secretKey.trim(),
        });
        handle = {
          connectionType: 'gcs',
          warehousePath: fullConfig.warehousePath,
          gcsConfig,
        };
      } else {
        handle = {
          connectionType: 'local',
          warehousePath: fullConfig.warehousePath,
        };
      }
      const structureValidation = await validateWarehouseStructure(handle, adapter);
      if (!structureValidation.valid) {
        let suggestedWarehousePath: string | undefined;
        try {
          const candidates = await findCandidateWarehouseRoots(handle, adapter);
          if (candidates.length > 0) {
            suggestedWarehousePath = candidates[0];
          }
        } catch (autoErr) {
          this._logger.warn(`Auto-detect failed: ${autoErr instanceof Error ? autoErr.message : String(autoErr)}`);
        }
        let msg = structureValidation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
        if (suggestedWarehousePath) {
          msg += ` Detected Iceberg warehouse at: ${suggestedWarehousePath}`;
        }
        this._logger.warn(`ConnectionManager.saveConnection: warehouse structure validation failed — ${msg}`);
        const err = new Error(`Validation failed: ${msg}`);
        if (suggestedWarehousePath) {
          (err as any).suggestedWarehousePath = suggestedWarehousePath;
        }
        return err;
      }
    }

    const credsChanged = !isMaskedCredential(credentials.accessKey) || !isMaskedCredential(credentials.secretKey);

    // Persist credentials to SecretStorage BEFORE updating globalState so that
    // if the SecretStorage write fails we don't leave a dangling config entry (T-08).
    // Only write to SecretStorage if credentials were provided or changed, avoiding
    // redundant OS Keychain/SecretStorage writes when editing other connection settings.
    if (fullConfig.connectionType === 's3' && credsChanged) {
      const stored: StoredCredential = {
        ak: effectiveCreds.accessKey.trim(),
        sk: effectiveCreds.secretKey.trim(),
      };
      await this._secrets.store(
        `${SECRET_KEY_PREFIX}${fullConfig.id}`,
        JSON.stringify(stored),
      );
      this._logger.info(
        `Credentials stored in SecretStorage: id=${fullConfig.id}`,
      );
    } else if (fullConfig.connectionType === 'gcs' && fullConfig.gcsAuthType === 'serviceAccountKey' && credsChanged) {
      let keyToStore = effectiveCreds.secretKey.trim();
      try {
        const parsedKey = parseServiceAccountKeyInput(keyToStore);
        if (parsedKey.credentials && !parsedKey.keyFilename) {
          keyToStore = JSON.stringify(parsedKey.credentials);
        } else if (parsedKey.keyFilename) {
          keyToStore = parsedKey.keyFilename;
        }
      } catch {
        // Fall back to trimmed raw input if parsing had issues
      }
      const stored: StoredCredential = {
        ak: 'gcs',
        sk: keyToStore,
      };
      await this._secrets.store(
        `${SECRET_KEY_PREFIX}${fullConfig.id}`,
        JSON.stringify(stored),
      );
      this._logger.info(
        `GCS service account key stored in SecretStorage: id=${fullConfig.id}`,
      );
    }

    // Persist non-secret config to globalState
    const existingIndex = configs.findIndex((c) => c.id === fullConfig.id);
    if (existingIndex >= 0) {
      configs[existingIndex] = fullConfig;
    } else {
      configs.push(fullConfig);
    }

    const trimmed = applyLruCap(configs, MAX_CONFIGS);
    await this._globalState.update(GLOBAL_STATE_KEY, trimmed);
    this._logger.info(
      `Connection saved to globalState: id=${fullConfig.id} type=${fullConfig.connectionType}`,
    );

    // If LRU eviction removed a config, delete its credentials from SecretStorage
    const removedIds = configs
      .filter((c) => !trimmed.some((t) => t.id === c.id))
      .map((c) => c.id);
    for (const evictedId of removedIds) {
      await this._secrets.delete(`${SECRET_KEY_PREFIX}${evictedId}`);
      this._logger.info(
        `Evicted connection (LRU cap): id=${evictedId}`,
      );
    }

    return fullConfig.id;
  }

  // -------------------------------------------------------------------------
  // T-10: Activate a saved connection → construct ActiveConnectionHandle
  // -------------------------------------------------------------------------

  /**
   * Activates a saved connection by id.
   * Looks up the config in globalState and, for S3/GCS connections, retrieves
   * credentials from SecretStorage and constructs a fresh client.
   * The client encapsulates credentials opaquely; they are never accessible
   * as strings after this point (AD-4, NFR-7).
   *
   * @returns An ActiveConnectionHandle on success, or an Error.
   */
  async activateConnection(id: string): Promise<ActiveConnectionHandle | Error> {
    const configs = this._readConfigs();
    const config = configs.find((c) => c.id === id);
    if (!config) {
      this._logger.warn(
        `ConnectionManager.activateConnection: config not found: id=${id}`,
      );
      return new Error(`Connection not found: ${id}`);
    }

    this._logger.info(
      `Activating connection: id=${id} type=${config.connectionType}`,
    );

    if (config.connectionType === 'local') {
      return { connectionType: 'local', warehousePath: config.warehousePath };
    }

    if (config.connectionType === 'gcs') {
      let cred: StoredCredential | undefined;
      if (config.gcsAuthType === 'serviceAccountKey') {
        cred = await this._loadCredential(config.id);
        if (!cred) {
          this._logger.error(
            `ConnectionManager.activateConnection: credential not found in SecretStorage: id=${id}`,
          );
          return new Error(
            `Credentials not found for connection "${config.label}". Please re-enter them.`,
          );
        }
      }
      try {
        const gcsConfig = buildGcsConfig(config, cred);
        return {
          connectionType: 'gcs',
          warehousePath: config.warehousePath,
          gcsConfig,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Error(`Failed to activate GCS connection: ${msg}`);
      }
    }

    // S3 — retrieve credentials from SecretStorage (T-10, T-11)
    const cred = await this._loadCredential(config.id);
    if (!cred) {
      this._logger.error(
        `ConnectionManager.activateConnection: credential not found in SecretStorage: id=${id}`,
      );
      return new Error(
        `Credentials not found for connection "${config.label}". Please re-enter them.`,
      );
    }

    const s3Config = buildS3Config(config, cred);
    return {
      connectionType: 's3',
      warehousePath: config.warehousePath,
      s3Config,
    };
  }

  /**
   * Builds an ephemeral ActiveConnectionHandle from unpersisted connection settings and credentials.
   * Resolves masked credentials from SecretStorage if config.id refers to an existing saved connection.
   */
  async createTemporaryHandle(
    config: ConnectionConfig,
    credentials: { accessKey: string; secretKey: string },
  ): Promise<ActiveConnectionHandle | Error> {
    let effectiveAccessKey = credentials.accessKey ? credentials.accessKey.trim() : '';
    let effectiveSecretKey = credentials.secretKey ? credentials.secretKey.trim() : '';

    if (config.connectionType === 's3' || config.connectionType === 'gcs') {
      const existingCred = config.id ? await this._loadCredential(config.id) : undefined;
      if (isMaskedCredential(effectiveAccessKey)) {
        effectiveAccessKey = existingCred?.ak ?? '';
      }
      if (isMaskedCredential(effectiveSecretKey)) {
        effectiveSecretKey = existingCred?.sk ?? '';
      }
    }

    const effectiveCreds = {
      accessKey: effectiveAccessKey,
      secretKey: effectiveSecretKey,
    };

    if (config.connectionType === 's3') {
      const s3Uri = (config.warehousePath || '').trim();
      const match = /^s3[an]?:\/\/([^/]+)/i.exec(s3Uri);
      if (!match) {
        return new Error('A valid S3 URI with a bucket (e.g. s3://bucket-name) is required.');
      }
      try {
        const s3Config = buildS3Config(config, {
          ak: effectiveCreds.accessKey.trim(),
          sk: effectiveCreds.secretKey.trim(),
        });
        return {
          connectionType: 's3',
          warehousePath: s3Uri,
          s3Config,
        };
      } catch (err: unknown) {
        return err instanceof Error ? err : new Error(String(err));
      }
    } else if (config.connectionType === 'gcs') {
      const gcsUri = (config.warehousePath || '').trim();
      const match = /^(?:gs|gcs):\/\/([^/]+)/i.exec(gcsUri);
      if (!match) {
        return new Error('A valid GCS URI with a bucket (e.g. gs://bucket-name) is required.');
      }
      try {
        const gcsConfig = buildGcsConfig(config, {
          ak: 'gcs',
          sk: effectiveCreds.secretKey.trim(),
        });
        return {
          connectionType: 'gcs',
          warehousePath: gcsUri,
          gcsConfig,
        };
      } catch (err: unknown) {
        return err instanceof Error ? err : new Error(String(err));
      }
    } else {
      return {
        connectionType: 'local',
        warehousePath: config.warehousePath || os.homedir(),
      };
    }
  }

  // -------------------------------------------------------------------------
  // List saved connections (non-credential fields only)
  // -------------------------------------------------------------------------

  listConnections(): ConnectionConfig[] {
    return this._readConfigs();
  }

  // -------------------------------------------------------------------------
  // Delete a saved connection
  // -------------------------------------------------------------------------

  async deleteConnection(id: string): Promise<void> {
    const configs = this._readConfigs();
    const filtered = configs.filter((c) => c.id !== id);
    await this._globalState.update(GLOBAL_STATE_KEY, filtered);
    await this._secrets.delete(`${SECRET_KEY_PREFIX}${id}`);
    this._logger.info(`Connection deleted: id=${id}`);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _readConfigs(): ConnectionConfig[] {
    const raw = (this._globalState.get<ConnectionConfig[]>(GLOBAL_STATE_KEY)) ?? [];
    return this._sanitizeDuplicates(raw);
  }

  /**
   * Sanitizes pre-existing configurations stored in globalState to ensure
   * no duplicate connection names exist. Exact duplicates are pruned and
   * distinct connections with collision names are disambiguated.
   */
  private _sanitizeDuplicates(rawConfigs: ConnectionConfig[]): ConnectionConfig[] {
    if (rawConfigs.length <= 1) return rawConfigs;

    const seenLabels = new Set<string>();
    let hasDuplicates = false;
    for (const c of rawConfigs) {
      const lower = c.label.trim().toLowerCase();
      if (seenLabels.has(lower)) {
        hasDuplicates = true;
        break;
      }
      seenLabels.add(lower);
    }

    if (!hasDuplicates) {
      return rawConfigs;
    }

    const sanitized: ConnectionConfig[] = [];
    const evictedIds: string[] = [];
    // Sort by savedAt descending so we preserve the newest for exact duplicates
    const sorted = [...rawConfigs].sort((a, b) => b.savedAt - a.savedAt);

    for (const config of sorted) {
      const trimmedLabel = config.label.trim();
      const lower = trimmedLabel.toLowerCase();

      const existing = sanitized.find((c) => c.label.trim().toLowerCase() === lower);
      if (!existing) {
        sanitized.push(config);
      } else {
        // If identical type and warehousePath, evict older duplicate
        if (
          existing.connectionType === config.connectionType &&
          existing.warehousePath.trim() === config.warehousePath.trim()
        ) {
          evictedIds.push(config.id);
          this._logger.warn(
            `ConnectionManager: pruned duplicate connection: id=${config.id} label="${config.label}"`,
          );
        } else {
          // Different connection: disambiguate name
          let counter = 2;
          let newName = `${trimmedLabel} (${counter})`;
          while (sanitized.some((c) => c.label.trim().toLowerCase() === newName.toLowerCase())) {
            counter++;
            newName = `${trimmedLabel} (${counter})`;
          }
          this._logger.warn(
            `ConnectionManager: disambiguated duplicate connection name: id=${config.id} "${config.label}" -> "${newName}"`,
          );
          sanitized.push({
            ...config,
            label: newName,
          });
        }
      }
    }

    void this._globalState.update(GLOBAL_STATE_KEY, sanitized);
    for (const id of evictedIds) {
      void this._secrets.delete(`${SECRET_KEY_PREFIX}${id}`);
    }

    return sanitized;
  }

  /**
   * Retrieves credentials from SecretStorage and parses the JSON blob.
   * Returns undefined if the key does not exist or if the blob is malformed.
   * Credentials are validated to be non-empty strings before being returned (T-11).
   */
  private async _loadCredential(
    id: string,
  ): Promise<StoredCredential | undefined> {
    const raw = await this._secrets.get(`${SECRET_KEY_PREFIX}${id}`);
    if (!raw) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // T-11: malformed blob in SecretStorage is treated as absent
      this._logger.error(
        `SecretStorage parse failure for id=${id} — treating as absent`,
      );
      return undefined;
    }

    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as StoredCredential).ak === 'string'
      && typeof (parsed as StoredCredential).sk === 'string'
      && (parsed as StoredCredential).ak.trim().length > 0
      && (parsed as StoredCredential).sk.trim().length > 0
    ) {
      return {
        ak: (parsed as StoredCredential).ak.trim(),
        sk: (parsed as StoredCredential).sk.trim(),
      };
    }

    this._logger.error(
      `SecretStorage credential invalid or empty for id=${id} — treating as absent`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `configs` trimmed to at most `maxSize` items.
 * The oldest entries (lowest `savedAt`) are evicted first (FR-6b LRU).
 */
function applyLruCap(configs: ConnectionConfig[], maxSize: number): ConnectionConfig[] {
  if (configs.length <= maxSize) return configs;
  return [...configs]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, maxSize);
}

/**
 * Checks whether an endpoint URL points to standard AWS S3.
 * Returns true if the endpoint is omitted or its host ends with amazonaws.com.
 */
function isAwsEndpoint(endpointUrl?: string): boolean {
  if (!endpointUrl || endpointUrl.trim() === '') {
    return true;
  }
  try {
    const url = new URL(endpointUrl.trim());
    return url.hostname.endsWith('.amazonaws.com') || url.hostname === 'amazonaws.com';
  } catch {
    return false;
  }
}

/**
 * Constructs an S3Client from a ConnectionConfig and decrypted credentials.
 * The S3Client is the only object that ever holds credential strings; it is
 * passed as part of the opaque handle and never stringified (AD-4, NFR-7).
 */
function buildS3Config(
  config: ConnectionConfig,
  cred: StoredCredential,
): S3Config {
  const isAws = isAwsEndpoint(config.endpointUrl);
  const clientConfig: S3ClientConfig = {
    region: config.region ?? 'us-east-1',
    credentials: {
      accessKeyId: cred.ak.trim(),
      secretAccessKey: cred.sk.trim(),
    },
    // S3-compatible stores (MinIO, IBM COS) require path-style addressing (FR-4).
    // Native AWS S3 deprecated path-style and expects virtual-hosted style.
    forcePathStyle: !isAws,
  };

  if (config.endpointUrl && config.endpointUrl.trim() !== '') {
    clientConfig.endpoint = config.endpointUrl.trim();
  }

  if (!config.sslVerification) {
    // AC-5: allow self-signed certificates when SSL verification is disabled
    clientConfig.requestHandler = {
      httpsAgent: new Agent({ rejectUnauthorized: false }),
    } as S3ClientConfig['requestHandler'];
  }

  const client = new S3Client(clientConfig);
  const { bucket, keyPrefix } = parseS3Uri(config.warehousePath);
  return { client, bucket, keyPrefix };
}

/**
 * Parses an S3 URI like "s3://bucket/key/prefix" into { bucket, keyPrefix }.
 * Throws if the URI cannot be parsed.
 */
function parseS3Uri(uri: string): { bucket: string; keyPrefix: string } {
  const match = /^s3[an]?:\/\/([^/]+)\/?(.*)$/.exec(uri.trim());
  if (!match) {
    throw new Error(`Invalid S3 URI: "${uri}"`);
  }
  return { bucket: match[1]!, keyPrefix: (match[2] ?? '').replace(/\/+$/, '') };
}

/**
 * Parses a GCS URI like "gs://bucket/key/prefix" into { bucket, keyPrefix }.
 * Normalises gcs:// to gs://. Throws if the URI cannot be parsed.
 */
export function parseGcsUri(uri: string): { bucket: string; keyPrefix: string } {
  const normalised = uri.trim().replace(/^gcs:\/\//, 'gs://');
  const match = /^gs:\/\/([^/]+)\/?(.*)$/.exec(normalised);
  if (!match) {
    throw new Error(`Invalid GCS URI: "${uri}"`);
  }
  return { bucket: match[1]!, keyPrefix: (match[2] ?? '').replace(/\/+$/, '') };
}

/**
 * Normalises and parses a Google Cloud Service Account key input, which may be:
 * 1. A JSON string (pretty-printed or minified, possibly with Markdown code fences, wrapping quotes,
 *    or raw newlines in private_key).
 * 2. A file path pointing to a .json key file on the local file system (with optional ~ expansion).
 *
 * Returns either:
 * - { credentials: Record<string, any> } for in-memory JSON objects
 * - { keyFilename: string } for existing file paths
 * Throws a descriptive Error if parsing fails or if the key file is not found.
 */
export function parseServiceAccountKeyInput(raw: string): { credentials?: Record<string, any>; keyFilename?: string } {
  let s = raw.trim();
  if (!s) {
    throw new Error('Service Account Key is empty.');
  }

  // Strip Markdown code fences if user copied ```json ... ```
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  // Strip wrapping outer quotes if user copied "'{...}'" or '"..."'
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }

  // Check if it's a file path:
  // If it doesn't start with '{', it's almost certainly a file path
  if (!s.startsWith('{')) {
    let filePath = s;
    if (filePath.startsWith('~/') || filePath === '~') {
      filePath = path.join(os.homedir(), filePath.slice(1));
    }
    // Remove surrounding quotes from path if any
    filePath = filePath.replace(/^['"]+|['"]+$/g, '');

    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        // Parse the file content to ensure it's valid JSON credentials
        const creds = parseJsonCredentials(fileContent);
        return { credentials: creds, keyFilename: filePath };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read Service Account key file at "${filePath}": ${msg}`);
      }
    } else {
      // If it looks like a path (e.g. ends with .json or has / or \), report file not found
      if (s.includes('/') || s.includes('\\') || s.endsWith('.json')) {
        throw new Error(`Service Account key file not found: "${filePath}". Please check that the file exists.`);
      }
      throw new Error(`Invalid Service Account Key: expected a valid JSON object or an existing .json file path.`);
    }
  }

  // It starts with '{', so parse as JSON
  const credentials = parseJsonCredentials(s);
  return { credentials };
}

/**
 * Validates that an object contains Google Cloud Service Account fields.
 */
function validateServiceAccountObject(obj: any): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Service Account credentials must be a JSON object.');
  }

  // If user provided a wrapper object like { path: "..." } or { keyFilename: "..." }
  if (obj.keyFilename || obj.keyFile || obj.path) {
    let p = String(obj.keyFilename || obj.keyFile || obj.path);
    if (p.startsWith('~/')) {
      p = path.join(os.homedir(), p.slice(2));
    }
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const inner = JSON.parse(content);
      validateServiceAccountObject(inner);
      return;
    }
  }

  const hasClientEmail = typeof obj.client_email === 'string' && obj.client_email.includes('@');
  const hasPrivateKey = typeof obj.private_key === 'string' && obj.private_key.length > 0;
  const isServiceAccountType = obj.type === 'service_account';
  const hasProjectId = typeof obj.project_id === 'string' && obj.project_id.length > 0;

  if (!hasClientEmail && !hasPrivateKey && !isServiceAccountType && !hasProjectId) {
    throw new Error(
      'JSON does not appear to be a Google Cloud Service Account key (missing "client_email", "private_key", or "type": "service_account").'
    );
  }
}

/**
 * Parses a JSON string containing Service Account credentials with multiple fallback repairs
 * for common copy-paste errors (raw newlines in private_key, trailing commas, single quotes).
 */
export function parseJsonCredentials(rawJson: string): Record<string, any> {
  let s = rawJson.trim();

  // Strip Markdown fences and quotes if present
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }

  // Strategy 1: Standard JSON.parse
  try {
    const obj = JSON.parse(s);
    validateServiceAccountObject(obj);
    return obj;
  } catch (err1: unknown) {
    const errMessage1 = err1 instanceof Error ? err1.message : String(err1);

    // Strategy 2: Fix raw unescaped newlines in "private_key" string literal
    try {
      const fixedNewlines = s.replace(/"private_key"\s*:\s*"([^"]*)"/gs, (_m, keyVal) => {
        const escaped = keyVal.replace(/\r?\n/g, '\\n');
        return `"private_key": "${escaped}"`;
      });
      const obj = JSON.parse(fixedNewlines);
      validateServiceAccountObject(obj);
      return obj;
    } catch { /* proceed to next fallback */ }

    // Strategy 3: Remove trailing commas before } or ]
    try {
      const fixedCommas = s.replace(/,(\s*[}\]])/g, '$1');
      const obj = JSON.parse(fixedCommas);
      validateServiceAccountObject(obj);
      return obj;
    } catch { /* proceed to next fallback */ }

    // Strategy 4: Convert Python dict single quotes to double quotes
    try {
      const fixedQuotes = s.replace(/'/g, '"');
      const obj = JSON.parse(fixedQuotes);
      validateServiceAccountObject(obj);
      return obj;
    } catch { /* proceed to next fallback */ }

    // Strategy 5: Fix unescaped newlines in any string value
    try {
      const relaxed = s.replace(/:(\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (_m, pre, inner) => {
        return `:${pre}"${inner.replace(/\r?\n/g, '\\n')}"`;
      });
      const obj = JSON.parse(relaxed);
      validateServiceAccountObject(obj);
      return obj;
    } catch { /* proceed to next fallback */ }

    // Strategy 6: Combine single-quote, trailing-comma, and newline fixes
    try {
      let combined = s;
      if (combined.includes("'")) {
        combined = combined.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
      }
      combined = combined.replace(/,(\s*[}\]])/g, '$1');
      combined = combined.replace(/"private_key"\s*:\s*"([^"]*)"/gs, (_m, keyVal) => {
        return `"private_key": "${keyVal.replace(/\r?\n/g, '\\n')}"`;
      });
      const obj = JSON.parse(combined);
      validateServiceAccountObject(obj);
      return obj;
    } catch { /* proceed to throw */ }

    throw new Error(`Invalid Service Account JSON (${errMessage1}). Please ensure valid JSON or specify a key file path.`);
  }
}

/**
 * Constructs a GcsConfig from a ConnectionConfig and optional credentials.
 */
export function buildGcsConfig(
  config: ConnectionConfig,
  cred?: StoredCredential,
): GcsConfig {
  const options: StorageOptions = {};
  if (config.projectId && config.projectId.trim() !== '') {
    options.projectId = config.projectId.trim();
  }

  if (config.gcsAuthType === 'serviceAccountKey') {
    const rawKey = cred?.sk?.trim() ?? '';
    if (rawKey) {
      const parsed = parseServiceAccountKeyInput(rawKey);
      if (parsed.credentials) {
        options.credentials = parsed.credentials;
      }
      if (parsed.keyFilename) {
        options.keyFilename = parsed.keyFilename;
      }
    }
  }

  const client = new Storage(options);
  const { bucket, keyPrefix } = parseGcsUri(config.warehousePath);
  return { client, bucket, keyPrefix };
}
