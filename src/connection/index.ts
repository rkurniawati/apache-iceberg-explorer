/**
 * Connection Manager public API barrel.
 */

export { ConnectionManager } from './connectionManager.js';
export type { ConnectionConfig, ActiveConnectionHandle } from './types.js';
export { validateConnectionInput } from './validation.js';
export type { ValidationResult, FieldError } from './validation.js';
