/**
 * Message protocol between the extension host and all webview panels.
 * Messages flow host → webview (PanelMessage) and webview → host (WebviewMessage).
 * (T-17, T-18, T-27, T-28, design.md §2.3)
 */
import type { ErrorClass } from '../storage/errors.js';
import type { ManifestEntryRow, DataFileRow, QueryResult } from '../query/types.js';

// ── Host → Webview ────────────────────────────────────────────────────────────

export interface SetLoadingMessage {
  type: 'setState';
  state: 'loading';
}

export interface SetIdleMessage {
  type: 'setState';
  state: 'idle';
}

export interface SetErrorMessage {
  type: 'setState';
  state: 'error';
  errorClass: ErrorClass | string;
  message: string;
}

export interface LoadMetadataMessage {
  type: 'loadMetadata';
  payload: unknown;
  /** Full resource path — used by webview to compute the breadcrumb. */
  resourcePath: string;
}

export interface LoadManifestListMessage {
  type: 'loadManifestList';
  rows: ManifestEntryRow[];
}

export interface LoadManifestFileMessage {
  type: 'loadManifestFile';
  rows: DataFileRow[];
}

export interface LoadPreviewMessage {
  type: 'loadPreview';
  result: QueryResult;
}

export interface LoadQueryResultMessage {
  type: 'loadQueryResult';
  result: QueryResult;
}

export interface ShowCapBannerMessage {
  type: 'showCapBanner';
  message: string;
}

export type PanelMessage =
  | SetLoadingMessage
  | SetIdleMessage
  | SetErrorMessage
  | LoadMetadataMessage
  | LoadManifestListMessage
  | LoadManifestFileMessage
  | LoadPreviewMessage
  | LoadQueryResultMessage
  | ShowCapBannerMessage;

// ── Webview → Host ────────────────────────────────────────────────────────────

/** Sent by the webview as its first action to signal the message listener is registered. */
export interface WebviewReadyMessage {
  type: 'webviewReady';
}

export interface RetryMessage {
  type: 'retry';
}

export interface BreadcrumbNavigateMessage {
  type: 'breadcrumbNavigate';
  /** Zero-based index of the clicked breadcrumb segment. */
  segment: number;
}

export interface OpenManifestListMessage {
  type: 'openManifestList';
  resourcePath: string;
}

export interface OpenManifestFileMessage {
  type: 'openManifestFile';
  resourcePath: string;
}

export interface OpenParquetPreviewMessage {
  type: 'openParquetPreview';
  resourcePath: string;
}

export interface OpenAdHocQueryMessage {
  type: 'openAdHocQuery';
  resourcePath: string;
}

export interface RunQueryMessage {
  type: 'runQuery';
  sql: string;
}

export interface CancelQueryMessage {
  type: 'cancelQuery';
}

export type WebviewMessage =
  | WebviewReadyMessage
  | RetryMessage
  | BreadcrumbNavigateMessage
  | OpenManifestListMessage
  | OpenManifestFileMessage
  | OpenParquetPreviewMessage
  | OpenAdHocQueryMessage
  | RunQueryMessage
  | CancelQueryMessage;
