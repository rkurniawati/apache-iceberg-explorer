/**
 * Query Engine barrel export.
 *
 * All consumers (Webview Panel Manager, tests) should import from this file only.
 */

export { QueryEngine } from './queryEngine.js';
export {
  type QueryErrorClass,
  type QueryError,
  type QueryResult,
  type ManifestEntryRow,
  type DataFileRow,
  isQueryError,
  queryError,
} from './types.js';
