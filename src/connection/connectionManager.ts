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
import * as crypto from 'node:crypto';

import type { ILogger } from '../extension.js';
import type { ConnectionConfig } from './types.js';
import type { ActiveConnectionHandle, S3Config } from '../storage/types.js';
import { validateConnectionInput } from './validation.js';

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

  // -------------------------------------------------------------------------
  // T-07 + T-08 + T-09: Save a connection (persist config + credentials + LRU)
  // -------------------------------------------------------------------------

  /**
   * Saves a connection configuration and credentials.
   *
   * - Validates inputs (T-12/CM-V1–V5).
   * - Assigns a stable `id` (UUID) if the config is new.
   * - Persists non-secret fields to globalState.
   * - Persists S3 credentials to SecretStorage under the config's id.
   * - Enforces the 5-config LRU cap, evicting the oldest on overflow (FR-6b).
   *
   * @param config    - Non-credential connection fields. `id` may be omitted for new connections;
   *                    if present the existing entry is updated.
   * @param credentials - accessKey and secretKey (only ever used for S3; ignored for local).
   * @returns The id of the saved connection, or an Error if validation fails.
   */
  async saveConnection(
    config: Omit<ConnectionConfig, 'id' | 'savedAt'> & { id?: string },
    credentials: { accessKey: string; secretKey: string },
  ): Promise<string | Error> {
    const fullConfig: ConnectionConfig = {
      ...config,
      id: config.id ?? crypto.randomUUID(),
      savedAt: Date.now(),
    };

    // CM-V1 through CM-V5 (T-12)
    const validation = validateConnectionInput(fullConfig, credentials);
    if (!validation.valid) {
      const msg = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      this._logger.warn(`ConnectionManager.saveConnection: validation failed — ${msg}`);
      return new Error(`Validation failed: ${msg}`);
    }

    // Persist credentials to SecretStorage BEFORE updating globalState so that
    // if the SecretStorage write fails we don't leave a dangling config entry (T-08).
    if (fullConfig.connectionType === 's3') {
      const stored: StoredCredential = {
        ak: credentials.accessKey.trim(),
        sk: credentials.secretKey.trim(),
      };
      await this._secrets.store(
        `${SECRET_KEY_PREFIX}${fullConfig.id}`,
        JSON.stringify(stored),
      );
      this._logger.info(
        `Credentials stored in SecretStorage: id=${fullConfig.id}`,
      );
    }

    // Persist non-secret config to globalState
    const configs = this._readConfigs();
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
   * Looks up the config in globalState and, for S3 connections, retrieves
   * credentials from SecretStorage and constructs a fresh S3Client.
   * The S3Client encapsulates credentials opaquely; they are never accessible
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
    return (
      (this._globalState.get<ConnectionConfig[]>(GLOBAL_STATE_KEY)) ?? []
    );
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
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid S3 URI: "${uri}"`);
  }
  return { bucket: match[1]!, keyPrefix: match[2] ?? '' };
}
