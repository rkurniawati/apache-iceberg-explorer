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

export interface TableColumnSummary {
  id: number;
  name: string;
  type: string;
  required: boolean;
  doc?: string;
}

export interface TablePartitionField {
  sourceId: number;
  fieldId: number;
  name: string;
  transform: string;
}

export interface SnapshotSummaryItem {
  snapshotId: string;
  parentSnapshotId: string | null;
  timestampMs: number;
  operation: string;
  addedRecords?: string;
  deletedRecords?: string;
  addedFiles?: string;
  manifestList?: string;
}

export interface ViewRepresentationSummary {
  type: string;
  sql?: string;
  dialect?: string;
}

export interface ViewVersionSummary {
  versionId: number;
  timestampMs: number;
  schemaId: number;
  summary?: Record<string, string>;
  defaultCatalog?: string;
  defaultNamespace?: string[];
  representations?: ViewRepresentationSummary[];
}

export interface LoadTableOverviewMessage {
  type: 'loadTableOverview';
  tablePath: string;
  tableName: string;
  formatVersion: number;
  tableUuid: string;
  location: string;
  currentSnapshotId: string | null;
  lastUpdatedMs: number | null;
  columns: TableColumnSummary[];
  partitionSpec: TablePartitionField[];
  snapshotsCount: number;
  properties: Record<string, string>;
  latestMetadataPath: string;
  snapshots: SnapshotSummaryItem[];
  // View extensions
  isView?: boolean;
  viewUuid?: string;
  currentVersionId?: number | null;
  viewSql?: string;
  viewDialect?: string;
  defaultCatalog?: string;
  defaultNamespace?: string[];
  viewVersions?: ViewVersionSummary[];
}

export interface LoadDataPreviewMessage {
  type: 'loadDataPreview';
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  error?: string;
}

export interface DiscoveredTableItem {
  name: string;
  path: string;
  schema: string;
}

export interface DiscoveredSchemaItem {
  name: string;
  path: string;
  tableCount: number;
}

export interface LoadConnectionDashboardMessage {
  type: 'loadConnectionDashboard';
  connectionLabel: string;
  connectionType: 'local' | 's3';
  warehousePath: string;
  region?: string;
  endpointUrl?: string;
  schemasCount: number;
  tablesCount: number;
  schemas?: DiscoveredSchemaItem[];
  tables: DiscoveredTableItem[];
  initialFilter?: string;
}

export interface LoadSchemaOverviewMessage {
  type: 'loadSchemaOverview';
  schemaName: string;
  schemaPath: string;
  warehouseLabel?: string;
  warehousePath?: string;
  tablesCount: number;
  tables: DiscoveredTableItem[];
  initialFilter?: string;
}

export interface SetDashboardFilterMessage {
  type: 'setFilter';
  filter: string;
}

export interface ManifestArchitectureCard {
  path: string;
  partitionSpecId: number;
  addedFiles: number;
  existingFiles: number;
  deletedFiles: number;
  partitionSummary: string;
}

export interface MetadataArchitectureVersionItem {
  label: string;
  resourcePath: string;
  isLatest: boolean;
}

export interface LoadMetadataArchitectureMessage {
  type: 'loadMetadataArchitecture';
  tablePath: string;
  metadataFile: string;
  availableMetadataFiles?: MetadataArchitectureVersionItem[];
  currentSnapshotId: string | null;
  snapshots: SnapshotSummaryItem[];
  activeSnapshot: {
    snapshotId: string;
    manifestList: string;
    manifests: ManifestArchitectureCard[];
  } | null;
}

export interface ManifestDataFileEntry {
  path: string;
  status: string;
  recordCount: number;
  fileSizeInBytes: number;
}

export interface LoadManifestDataFilesMessage {
  type: 'loadManifestDataFiles';
  manifestPath: string;
  files: ManifestDataFileEntry[];
  error?: string;
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
  | ShowCapBannerMessage
  | LoadTableOverviewMessage
  | LoadSchemaOverviewMessage
  | LoadDataPreviewMessage
  | LoadConnectionDashboardMessage
  | LoadMetadataArchitectureMessage
  | LoadManifestDataFilesMessage
  | SetDashboardFilterMessage;

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
  initialSql?: string;
}

export interface RunQueryMessage {
  type: 'runQuery';
  sql: string;
}

export interface CancelQueryMessage {
  type: 'cancelQuery';
}

export interface OpenTableOverviewMessage {
  type: 'openTableOverview';
  resourcePath: string;
}

export interface OpenSchemaOverviewMessage {
  type: 'openSchemaOverview';
  schemaPath: string;
  schemaName?: string;
}

export interface OpenMetadataPanelMessage {
  type: 'openMetadataPanel';
  resourcePath: string;
}

export interface OpenMetadataArchitectureMessage {
  type: 'openMetadataArchitecture';
  resourcePath: string;
}

export interface OpenConnectionDashboardMessage {
  type: 'openConnectionDashboard';
  connectionId?: string;
}

export interface FetchDataPreviewMessage {
  type: 'fetchDataPreview';
  tablePath: string;
}

export interface SelectArchitectureSnapshotMessage {
  type: 'selectArchitectureSnapshot';
  tablePath: string;
  snapshotId: string;
  metadataPath?: string;
}

export interface SelectArchitectureMetadataFileMessage {
  type: 'selectArchitectureMetadataFile';
  tablePath: string;
  metadataPath: string;
}

export interface FetchManifestDataFilesMessage {
  type: 'fetchManifestDataFiles';
  manifestPath: string;
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
  | CancelQueryMessage
  | OpenTableOverviewMessage
  | OpenSchemaOverviewMessage
  | OpenMetadataPanelMessage
  | OpenMetadataArchitectureMessage
  | OpenConnectionDashboardMessage
  | FetchDataPreviewMessage
  | SelectArchitectureSnapshotMessage
  | SelectArchitectureMetadataFileMessage
  | FetchManifestDataFilesMessage;

