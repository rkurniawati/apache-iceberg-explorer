/**
 * Connection Manager public API barrel.
 */

export { ConnectionManager, isMaskedCredential } from './connectionManager.js';
export type { ConnectionConfig, ActiveConnectionHandle } from './types.js';
export { validateConnectionInput, validateWarehouseStructure } from './validation.js';
export type { ValidationResult, FieldError } from './validation.js';
