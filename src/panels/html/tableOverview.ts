/**
 * Table Overview Panel — HTML shell generator.
 *
 * Implements:
 *  - Table Identity & Versioning header
 *  - Schema & Column types table
 *  - Partition specifications
 *  - Embedded Data Preview with DuckDB-WASM
 *  - Snapshots list with link to Metadata Structure
 *
 * Client-side rendering script is located in src/webviews/tableOverview.ts
 * and bundled to out/webviews/tableOverview.js.
 */
import { breadcrumbHtml } from './shared.js';

export interface TableOverviewStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

export function getTableOverviewHtml(
  nonce: string,
  cspSource: string,
  tablePath: string,
  styleUris?: TableOverviewStyleUris,
): string {
  const initialBreadcrumb = breadcrumbHtml(tablePath);
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/tableOverview.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/tableOverview.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Table Overview</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div id="loading-msg">Loading Iceberg table overview…</div>
  </div>

  <div id="error">
    <div style="font-weight: 600; margin-bottom: 0.25rem;">Failed to load table</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary" id="retry-btn" style="margin-top: 0.75rem;">Retry</button>
  </div>

  <div id="content" style="display: none;">
    <div class="header-bar">
      <div class="header-main">
        <div class="title-row">
          <h1 id="table-name">Table</h1>
          <span class="badge" id="version-badge">v2</span>
        </div>
        <div class="meta-details">
          <span class="meta-item" id="item-location">Location: <strong id="table-location"></strong></span>
          <span class="meta-item" id="item-current-snapshot">Current Snapshot: <strong id="current-snapshot" style="font-family: monospace;"></strong></span>
          <span class="meta-item" id="item-view-uuid" style="display: none;">View UUID: <strong id="view-uuid" style="font-family: monospace;"></strong></span>
          <span class="meta-item" id="item-current-version" style="display: none;">Current Version: <strong id="current-version"></strong></span>
          <span class="meta-item" id="item-default-namespace" style="display: none;">Namespace: <strong id="default-namespace"></strong></span>
          <span class="meta-item" id="item-default-catalog" style="display: none;">Catalog: <strong id="default-catalog"></strong></span>
          <span class="meta-item" id="item-updated">Updated: <strong id="table-updated"></strong></span>
        </div>
      </div>
      <div class="actions-bar">
        <button class="btn" id="query-btn">🔍 Query SQL</button>
        <button class="btn btn-secondary" id="view-metadata-btn">📄 Metadata JSON</button>
        <button class="btn btn-secondary" id="view-dag-btn">🏗️ Metadata Structure</button>
      </div>
    </div>

    <div class="tabs-bar">
      <button class="tab-btn active" data-tab="schema" id="tab-btn-schema">Schema & Columns</button>
      <button class="tab-btn" data-tab="sql" id="tab-btn-sql" style="display: none;">View SQL</button>
      <button class="tab-btn" data-tab="preview" id="tab-btn-preview">Data Preview</button>
      <button class="tab-btn" data-tab="snapshots" id="tab-btn-snapshots">Snapshots History</button>
    </div>

    <!-- Tab 1: Schema -->
    <div id="tab-schema" class="tab-content">
      <div id="partition-section">
        <div style="font-weight: 600; margin-bottom: 0.4rem;">Partition Specification</div>
        <div class="partition-chips" id="partition-chips">
          <span style="color: var(--vscode-descriptionForeground); font-style: italic;">Unpartitioned</span>
        </div>
      </div>

      <div class="filter-bar">
        <div style="font-weight: 600;">Table Columns (<span id="column-count">0</span>)</div>
        <input type="text" class="search-input" id="schema-search" placeholder="Filter columns…">
      </div>
      <div style="overflow-x: auto;">
        <table id="schema-table">
          <thead>
            <tr>
              <th style="width: 50px;">ID</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nullability</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody id="schema-tbody"></tbody>
        </table>
      </div>

      <div id="properties-section" style="margin-top: 2rem;">
        <div style="font-weight: 600; margin-bottom: 0.5rem;">Table Properties</div>
        <table id="properties-table">
          <thead><tr><th style="width: 300px;">Key</th><th>Value</th></tr></thead>
          <tbody id="properties-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- Tab: View SQL (Visible for Iceberg Views) -->
    <div id="tab-sql" class="tab-content" style="display: none;">
      <div style="margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; font-size: 0.85rem; color: var(--vscode-descriptionForeground);">
        ℹ️ <strong>Apache Iceberg View</strong>: Views are metadata-only definitions containing a SQL query. They do not store physical data snapshots. You can copy the SQL query below to execute in your external query engine (such as Trino or Spark).
      </div>
      <div class="filter-bar">
        <div><strong>Dialect:</strong> <span class="badge" id="view-dialect-badge" style="background: #0284c7; color: #fff;">TRINO</span></div>
        <button class="btn btn-secondary" id="copy-sql-btn">📋 Copy SQL</button>
      </div>
      <pre style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); padding: 1rem; border-radius: 4px; overflow: auto; max-height: 500px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5;"><code id="view-sql-code"></code></pre>
    </div>

    <!-- Tab 2: Data Preview -->
    <div id="tab-preview" class="tab-content" style="display: none;">
      <div class="filter-bar">
        <div>Sample Data (Top <span id="preview-row-count">0</span> rows)</div>
        <button class="btn btn-secondary" id="load-preview-btn">🔄 Reload Sample</button>
      </div>
      <div id="preview-loading" style="padding: 2rem; text-align: center; display: none;">
        <div class="spinner"></div>
        <div>Querying latest data files with DuckDB…</div>
      </div>
      <div id="preview-error" style="display: none; padding: 1rem; color: var(--vscode-errorForeground);"></div>
      <div id="preview-wrapper" style="overflow-x: auto;">
        <table id="preview-table">
          <thead id="preview-thead"></thead>
          <tbody id="preview-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- Tab 3: Snapshots History -->
    <div id="tab-snapshots" class="tab-content" style="display: none;">
      <div class="filter-bar">
        <div style="font-weight: 600;">Snapshot Commits (<span id="snapshots-total">0</span> total)</div>
      </div>
      <div class="timeline-list" id="snapshots-list"></div>
      <div class="pagination-bar" id="snapshots-pagination">
        <button class="btn btn-secondary" id="snap-prev-btn">&larr; Previous</button>
        <span id="snap-page-indicator" style="font-size: 0.85rem;">Page 1</span>
        <button class="btn btn-secondary" id="snap-next-btn">Next &rarr;</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
