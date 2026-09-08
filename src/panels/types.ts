/**
 * Panel type identifiers — used as the first segment of the registry key.
 * (T-15, AD-6, architecture.md §4.3)
 */
export enum PanelType {
  MetadataDetail = 'metadataDetail',
  /** Stubs — not implemented in this slice. */
  ManifestList = 'manifestList',
  ManifestFile = 'manifestFile',
  ParquetPreview = 'parquetPreview',
  AdHocQuery = 'adHocQuery',
  Settings = 'settings',
}

/**
 * Compute the composite registry key for the one-panel-per-resource policy.
 * (AD-6: keyed by panelType + resourcePath)
 */
export function panelRegistryKey(
  panelType: PanelType,
  resourcePath: string,
): string {
  return `${panelType}::${resourcePath}`;
}
