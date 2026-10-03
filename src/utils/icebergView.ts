/**
 * Iceberg View Utilities & Specification helpers.
 *
 * Implements Apache Iceberg View Specification v1:
 * - View metadata detection (view-uuid, representations, versions)
 * - Extraction of SQL representations, dialect, catalog, namespace, and version log
 * - SQL table reference parser (FROM / JOIN extraction)
 */

export interface IcebergViewRepresentation {
  type: string;
  sql?: string;
  dialect?: string;
}

export interface IcebergViewVersionSummary {
  versionId: number;
  timestampMs: number;
  schemaId: number;
  summary?: Record<string, string>;
  defaultCatalog?: string;
  defaultNamespace?: string[];
  representations?: IcebergViewRepresentation[];
}

export interface IcebergViewDetails {
  viewUuid: string;
  formatVersion: number;
  location: string;
  currentVersionId: number;
  defaultCatalog?: string;
  defaultNamespace: string[];
  viewSql?: string;
  viewDialect?: string;
  versions: IcebergViewVersionSummary[];
  versionLog: Array<{ timestampMs: number; versionId: number }>;
  referencedTables: string[];
}

/**
 * Checks whether the given metadata object represents an Apache Iceberg View
 * rather than a standard Iceberg Table.
 */
export function isIcebergViewMetadata(metaObj: unknown): boolean {
  if (!metaObj || typeof metaObj !== 'object') {
    return false;
  }
  const meta = metaObj as Record<string, unknown>;

  // Definite indicator: view-uuid is present
  if (typeof meta['view-uuid'] === 'string' && meta['view-uuid'].trim().length > 0) {
    return true;
  }

  // Structural indicator: has versions array with representations, and no table-uuid or snapshots
  if (
    Array.isArray(meta.versions) &&
    !meta['table-uuid'] &&
    !meta.snapshots &&
    meta.versions.some((v: any) => v && Array.isArray(v.representations))
  ) {
    return true;
  }

  return false;
}

/**
 * Parses table references from SQL query FROM and JOIN clauses.
 * Supports identifiers with optional schema/namespace prefix and quotes.
 * e.g. "SELECT * FROM events WHERE ..." -> ["events"]
 * e.g. "SELECT * FROM datalake.events JOIN "audit" ..." -> ["datalake.events", "audit"]
 */
export function extractTableReferencesFromSql(sql: string): string[] {
  if (!sql || typeof sql !== 'string') {
    return [];
  }

  const tableRefs = new Set<string>();
  // Match FROM or JOIN followed by table identifier (words, dots, quotes)
  const regex = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_."`]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(sql)) !== null) {
    const raw = match[1].replace(/[`"]/g, '').trim();
    if (raw && !raw.startsWith('(')) {
      tableRefs.add(raw);
    }
  }

  return Array.from(tableRefs);
}

/**
 * Extracts normalized details from an Iceberg View metadata JSON object.
 */
export function extractIcebergViewDetails(metaObj: Record<string, unknown>): IcebergViewDetails {
  const viewUuid = String(metaObj['view-uuid'] ?? '');
  const formatVersion = Number(metaObj['format-version'] ?? 1);
  const location = String(metaObj['location'] ?? '');
  const currentVersionId = Number(metaObj['current-version-id'] ?? 1);

  const rawVersions = Array.isArray(metaObj.versions) ? (metaObj.versions as Array<Record<string, unknown>>) : [];
  const versions: IcebergViewVersionSummary[] = rawVersions.map((v) => ({
    versionId: Number(v['version-id'] ?? 0),
    timestampMs: Number(v['timestamp-ms'] ?? 0),
    schemaId: Number(v['schema-id'] ?? 0),
    summary: v.summary && typeof v.summary === 'object' ? (v.summary as Record<string, string>) : undefined,
    defaultCatalog: v['default-catalog'] ? String(v['default-catalog']) : undefined,
    defaultNamespace: Array.isArray(v['default-namespace']) ? (v['default-namespace'] as unknown[]).map(String) : undefined,
    representations: Array.isArray(v.representations)
      ? (v.representations as Array<Record<string, unknown>>).map((r) => ({
          type: String(r.type ?? ''),
          sql: r.sql ? String(r.sql) : undefined,
          dialect: r.dialect ? String(r.dialect) : undefined,
        }))
      : undefined,
  }));

  // Find the active version
  const activeVersion =
    versions.find((v) => v.versionId === currentVersionId) ?? versions[versions.length - 1];

  let viewSql: string | undefined;
  let viewDialect: string | undefined;

  if (activeVersion?.representations && activeVersion.representations.length > 0) {
    const sqlRep = activeVersion.representations.find((r) => r.type === 'sql') ?? activeVersion.representations[0];
    viewSql = sqlRep.sql;
    viewDialect = sqlRep.dialect;
  }

  const defaultCatalog = activeVersion?.defaultCatalog;
  const defaultNamespace = activeVersion?.defaultNamespace ?? [];

  // Version log
  const rawLog = Array.isArray(metaObj['version-log'])
    ? (metaObj['version-log'] as Array<Record<string, unknown>>)
    : [];
  const versionLog = rawLog.map((item) => ({
    timestampMs: Number(item['timestamp-ms'] ?? 0),
    versionId: Number(item['version-id'] ?? 0),
  }));

  const referencedTables = viewSql ? extractTableReferencesFromSql(viewSql) : [];

  return {
    viewUuid,
    formatVersion,
    location,
    currentVersionId,
    defaultCatalog,
    defaultNamespace,
    viewSql,
    viewDialect,
    versions,
    versionLog,
    referencedTables,
  };
}
