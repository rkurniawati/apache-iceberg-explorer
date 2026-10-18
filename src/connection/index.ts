/**
 * Connection Manager public API barrel.
 */

export { ConnectionManager, isMaskedCredential } from './connectionManager.js';
export type { ConnectionConfig, ActiveConnectionHandle } from './types.js';
export { validateConnectionInput, validateWarehouseStructure, isAbsoluteLocalPath } from './validation.js';
export type { ValidationResult, FieldError } from './validation.js';
export {
  browseDirectory,
  findCandidateWarehouseRoots,
  buildHandleForPath,
  normaliseStoragePath,
  joinStoragePath,
  getParentPath,
} from './discovery.js';
export type { BrowseDirectoryResult, BrowseItem } from './discovery.js';
