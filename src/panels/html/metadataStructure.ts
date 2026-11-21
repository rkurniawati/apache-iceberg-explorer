/**
 * Metadata Structure Panel — HTML shell generator.
 *
 * Implements:
 *  - Snapshot Manifest Hierarchy DAG for the selected snapshot (Metadata -> Snapshot -> Manifest List -> Manifests)
 *  - Paginated commit timeline for snapshots (10 per page, prev/next)
 *  - Stop at Manifest level with on-demand drill down to data files
 *
 * Client-side rendering script is located in src/webviews/metadataStructure.ts
 * and bundled to out/webviews/metadataStructure.js.
 */
import { breadcrumbHtml } from './shared.js';

export interface MetadataStructureStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

export function getMetadataStructureHtml(
  nonce: string,
  cspSource: string,
  tablePath: string,
  styleUris?: MetadataStructureStyleUris,
): string {
  const initialBreadcrumb = breadcrumbHtml(tablePath);
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/metadataStructure.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/metadataStructure.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource}; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metadata Structure</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div>Resolving Iceberg metadata structure…</div>
  </div>

  <div id="error">
    <div class="error-title">Failed to load metadata structure</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary error-retry-btn" id="retry-btn">Retry</button>
  </div>

  <div id="content">
    <div class="header-bar">
      <div>
        <h1>Metadata Structure</h1>
        <div class="header-subtitle">
          Iceberg metadata structure. Click any snapshot commit to view its manifest hierarchy.
        </div>
      </div>
      <div>
        <button class="btn btn-secondary" id="open-overview-btn">View Table Overview</button>
      </div>
    </div>

    <!-- Section 1: Paginated Snapshots Timeline -->
    <div class="section-title">
      <span>Snapshot Commits Timeline (<span id="total-commits">0</span> total)</span>
    </div>
    <div class="section-subtitle">
      Select a snapshot commit below to inspect its manifest hierarchy in the diagram.
    </div>
    <div class="timeline-container">
      <div class="timeline-scroll" id="timeline-scroll"></div>
      <div class="pagination-controls">
        <button class="btn btn-secondary" id="page-prev-btn">&larr; Newer Commits</button>
        <span id="page-indicator">Page 1</span>
        <button class="btn btn-secondary" id="page-next-btn">Older Commits &rarr;</button>
      </div>
    </div>

    <!-- Section 2: Snapshot Manifest Hierarchy -->
    <div class="section-title">
      <span>Snapshot Manifest Hierarchy (Snapshot <span id="selected-snap-label">#—</span>)</span>
    </div>
    <div class="section-subtitle">
      Manifest list and manifests associated with the snapshot selected above.
    </div>
    <div class="dag-container">
      <!-- 1. Metadata JSON -->
      <div class="dag-node dag-node-meta">
        <div class="dag-node-header">
          <div class="dag-label">Table Metadata File</div>
          <div class="meta-controls">
            <label for="meta-file-select" class="meta-select-label">Version:</label>
            <select id="meta-file-select" class="meta-dropdown" title="Select Metadata JSON version" aria-label="Select Metadata JSON version"></select>
            <button class="btn btn-secondary action-link" id="view-meta-json-btn" title="Open this metadata JSON in the Metadata Detail view">View JSON Details ↗</button>
          </div>
        </div>
        <div class="dag-value" id="node-meta-file">vN.metadata.json</div>
        <div id="node-meta-badge" class="meta-badge-container"></div>
      </div>

      <div class="dag-arrow">&darr;</div>

      <!-- 2. Snapshot -->
      <div class="dag-node dag-node-snap">
        <div class="dag-node-header">
          <div class="dag-label">Selected Snapshot</div>
          <span class="active-badge" id="snap-active-badge">Selected in Timeline</span>
        </div>
        <div class="dag-value" id="node-snap-id">Snapshot #—</div>
        <div id="node-snap-meta"></div>
      </div>

      <div class="dag-arrow">&darr;</div>

      <!-- 3. Manifest List -->
      <div class="dag-node dag-node-ml">
        <div class="dag-label">Manifest List (.avro)</div>
        <div class="dag-value" id="node-ml-file">snap-xxx.avro</div>
      </div>

      <div class="dag-arrow">&darr;</div>

      <!-- 4. Manifest Files (stops at manifest level with drill down) -->
      <div class="manifests-section">
        <div class="dag-label dag-label-center">Manifest Files (<span id="manifests-count">0</span>)</div>
        <div id="manifests-list"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}

/** @deprecated Use getMetadataStructureHtml */
export const getMetadataArchitectureHtml = getMetadataStructureHtml;
