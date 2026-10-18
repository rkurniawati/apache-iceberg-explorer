/**
 * Storage discovery and warehouse path auto-detection.
 * Supports S3, GCS, and local filesystem warehouses.
 */

import * as path from 'path';
import type { ActiveConnectionHandle } from '../storage/types.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { isStorageError } from '../storage/errors.js';
import { validateWarehouseStructure } from './validation.js';

export interface BrowseItem {
  name: string;
  path: string;
  isTable: boolean;
  isSchema: boolean;
}

export interface BrowseDirectoryResult {
  currentPath: string;
  parentPath: string | null;
  items: BrowseItem[];
}

/**
 * Normalises an S3, GCS, or local filesystem path.
 */
export function normaliseStoragePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (/^s3[an]?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  if (/^(?:gs|gcs):\/\//i.test(trimmed)) {
    return trimmed.replace(/^gcs:\/\//i, 'gs://').replace(/\/+$/, '');
  }
  return trimmed.replace(/[\\/]+$/, '') || '/';
}

/**
 * Joins a parent directory path with a child subfolder name.
 */
export function joinStoragePath(parentPath: string, childName: string): string {
  const norm = normaliseStoragePath(parentPath);
  if (/^s3[an]?:\/\//i.test(norm) || /^gs:\/\//i.test(norm)) {
    return `${norm}/${childName.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  }
  return path.join(norm, childName);
}

/**
 * Returns the parent path of a given S3 URI, GCS URI, or local filesystem path.
 * Returns null if the path is already at root or bucket root.
 */
export function getParentPath(targetPath: string): string | null {
  const norm = normaliseStoragePath(targetPath);

  // S3: s3://bucket/optional/prefix
  const s3Match = /^(s3[an]?:\/\/[^/]+)(?:\/(.*))?$/i.exec(norm);
  if (s3Match) {
    const bucketRoot = s3Match[1];
    const prefix = (s3Match[2] ?? '').replace(/\/+$/, '');
    if (!prefix) {
      return null; // already at bucket root
    }
    const segments = prefix.split('/').filter(Boolean);
    segments.pop();
    return segments.length === 0 ? bucketRoot : `${bucketRoot}/${segments.join('/')}`;
  }

  // GCS: gs://bucket/optional/prefix
  const gcsMatch = /^(gs:\/\/[^/]+)(?:\/(.*))?$/i.exec(norm);
  if (gcsMatch) {
    const bucketRoot = gcsMatch[1];
    const prefix = (gcsMatch[2] ?? '').replace(/\/+$/, '');
    if (!prefix) {
      return null;
    }
    const segments = prefix.split('/').filter(Boolean);
    segments.pop();
    return segments.length === 0 ? bucketRoot : `${bucketRoot}/${segments.join('/')}`;
  }

  // Local filesystem
  const parent = path.dirname(norm);
  if (parent === norm) {
    return null;
  }
  return parent;
}

/**
 * Derives an ActiveConnectionHandle for a specific path, updating S3/GCS keyPrefixes accordingly.
 */
export function buildHandleForPath(
  baseHandle: ActiveConnectionHandle,
  newPath: string,
): ActiveConnectionHandle {
  if (baseHandle.connectionType === 's3') {
    const match = /^s3[an]?:\/\/([^/]+)\/?(.*)$/i.exec(newPath.trim());
    const keyPrefix = match ? (match[2] ?? '').replace(/\/+$/, '') : '';
    return {
      connectionType: 's3',
      warehousePath: newPath,
      s3Config: {
        ...baseHandle.s3Config,
        keyPrefix,
      },
    };
  } else if (baseHandle.connectionType === 'gcs') {
    const normalised = newPath.trim().replace(/^gcs:\/\//i, 'gs://');
    const match = /^gs:\/\/([^/]+)\/?(.*)$/i.exec(normalised);
    const keyPrefix = match ? (match[2] ?? '').replace(/\/+$/, '') : '';
    return {
      connectionType: 'gcs',
      warehousePath: newPath,
      gcsConfig: {
        ...baseHandle.gcsConfig,
        keyPrefix,
      },
    };
  } else {
    return {
      connectionType: 'local',
      warehousePath: newPath,
    };
  }
}

/**
 * Lists the directory contents at `dirPath` with table and schema detection.
 */
export async function browseDirectory(
  handle: ActiveConnectionHandle,
  adapter: StorageAdapter,
  dirPath: string,
): Promise<BrowseDirectoryResult | { error: string }> {
  const normPath = normaliseStoragePath(dirPath);
  const pathHandle = buildHandleForPath(handle, normPath);

  const contents = await adapter.listDirectoryContents(pathHandle, normPath, { filter: 'all' });
  if (isStorageError(contents)) {
    return { error: contents.message };
  }

  const parentPath = getParentPath(normPath);
  const items: BrowseItem[] = [];

  for (const sub of contents.subdirectories) {
    if (sub === 'metadata' || sub === 'data') {
      continue;
    }
    const childPath = joinStoragePath(normPath, sub);
    const childHandle = buildHandleForPath(pathHandle, childPath);

    let isTable = false;
    let isSchema = false;

    const isTab = await adapter.isTable(childHandle, childPath);
    if (!isStorageError(isTab) && isTab === true) {
      isTable = true;
    } else {
      // Check if this subdirectory might be a schema directory containing tables
      const subContents = await adapter.listDirectoryContents(childHandle, childPath, { filter: 'all' });
      if (!isStorageError(subContents)) {
        for (const grandChild of subContents.subdirectories.slice(0, 10)) {
          if (grandChild === 'metadata' || grandChild === 'data') continue;
          const grandChildPath = joinStoragePath(childPath, grandChild);
          const grandChildHandle = buildHandleForPath(childHandle, grandChildPath);
          const grandIsTab = await adapter.isTable(grandChildHandle, grandChildPath);
          if (!isStorageError(grandIsTab) && grandIsTab === true) {
            isSchema = true;
            break;
          }
        }
      }
    }

    items.push({
      name: sub,
      path: childPath,
      isTable,
      isSchema,
    });
  }

  // Sort: schemas and tables first, then alphabetically
  items.sort((a, b) => {
    if (a.isTable !== b.isTable) return a.isTable ? -1 : 1;
    if (a.isSchema !== b.isSchema) return a.isSchema ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    currentPath: normPath,
    parentPath,
    items,
  };
}

/**
 * Searches up to `maxDepth` levels under `handle.warehousePath` to automatically detect valid Iceberg warehouse roots.
 */
export async function findCandidateWarehouseRoots(
  handle: ActiveConnectionHandle,
  adapter: StorageAdapter,
  maxDepth = 3,
): Promise<string[]> {
  const candidates = new Set<string>();
  const startPath = normaliseStoragePath(handle.warehousePath);
  if (!startPath) return [];

  // 1. Is startPath itself a table?
  const isStartTable = await adapter.isTable(handle, startPath);
  if (!isStorageError(isStartTable) && isStartTable) {
    const parent1 = getParentPath(startPath);
    if (parent1) {
      const parent2 = getParentPath(parent1);
      if (parent2) {
        candidates.add(parent2);
      }
    }
  }

  // 2. Search breadth-first
  interface QueueItem {
    path: string;
    depth: number;
    parent: string | null;
    grandParent: string | null;
  }

  const queue: QueueItem[] = [{ path: startPath, depth: 0, parent: null, grandParent: null }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);

    if (current.depth > 0) {
      const currentHandle = buildHandleForPath(handle, current.path);
      const isTab = await adapter.isTable(currentHandle, current.path);
      if (!isStorageError(isTab) && isTab) {
        if (current.depth === 1 && current.parent) {
          const root = getParentPath(current.parent);
          if (root) candidates.add(root);
        } else if (current.depth === 2 && current.grandParent) {
          candidates.add(current.grandParent);
        } else if (current.depth >= 3 && current.grandParent) {
          candidates.add(current.grandParent);
        }
        continue;
      }
    }

    if (current.depth < maxDepth) {
      const currentHandle = buildHandleForPath(handle, current.path);
      const res = await adapter.listDirectoryContents(currentHandle, current.path, { filter: 'all' });
      if (!isStorageError(res)) {
        for (const sub of res.subdirectories.slice(0, 20)) {
          if (sub === 'metadata' || sub === 'data') continue;
          const childPath = joinStoragePath(current.path, sub);
          queue.push({
            path: childPath,
            depth: current.depth + 1,
            parent: current.path,
            grandParent: current.parent,
          });
        }
      }
    }
  }

  // 3. Verify candidates with validateWarehouseStructure
  const verified: string[] = [];
  for (const candidate of candidates) {
    const candHandle = buildHandleForPath(handle, candidate);
    const valid = await validateWarehouseStructure(candHandle, adapter);
    if (valid.valid) {
      verified.push(candidate);
    }
  }

  return verified;
}
