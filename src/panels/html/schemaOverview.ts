/**
 * Schema Overview Panel — HTML shell generator.
 *
 * Implements:
 *  - Schema details card
 *  - Tables count in this schema
 *  - Searchable list of tables in this schema
 *  - Direct jump to Table Overview or SQL Query
 *
 * Client-side rendering script is located in src/webviews/schemaOverview.ts
 * and bundled to out/webviews/schemaOverview.js.
 */
import { breadcrumbHtml } from './shared.js';

export interface SchemaOverviewStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

export function getSchemaOverviewHtml(
  nonce: string,
  cspSource: string,
  schemaPath: string,
  styleUris?: SchemaOverviewStyleUris,
): string {
  const initialBreadcrumb = breadcrumbHtml(schemaPath);
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/schemaOverview.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/schemaOverview.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schema Overview</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${initialBreadcrumb}</div>

  <div id="loading">
    <div class="spinner"></div>
    <div>Loading schema tables…</div>
  </div>

  <div id="error">
    <div style="font-weight: 600; margin-bottom: 0.25rem;">Failed to load schema</div>
    <div id="error-message"></div>
    <button class="btn btn-secondary" id="retry-btn" style="margin-top: 0.75rem;">Retry</button>
  </div>

  <div id="content" style="display: none;">
    <div class="header-bar">
      <div class="header-title-row">
        <h1 id="schema-title">Schema</h1>
        <span class="status-badge"><span class="status-dot"></span> Schema</span>
      </div>
      <div class="actions-bar">
        <button class="btn btn-secondary" id="warehouse-btn">🏠 Warehouse Overview</button>
        <button class="btn" id="new-query-btn">📝 New SQL Query</button>
      </div>
    </div>

    <div class="cards-grid">
      <!-- Card 1: Schema Details -->
      <div class="card">
        <div class="card-title">Schema Configuration</div>
        <div class="card-row">
          <span class="card-row-label">Schema:</span>
          <span class="card-row-val" id="schema-name-val"></span>
        </div>
        <div class="card-row">
          <span class="card-row-label">Location:</span>
          <span class="card-row-val" id="schema-path-val" style="font-family: monospace;"></span>
        </div>
        <div class="card-row" id="warehouse-row">
          <span class="card-row-label">Warehouse:</span>
          <span class="card-row-val" id="schema-wh-val"></span>
        </div>
      </div>

      <!-- Card 2: Tables Inventory -->
      <div class="card">
        <div class="card-title">Schema Inventory</div>
        <div style="display: flex; gap: 2rem; margin-top: 0.5rem;">
          <div>
            <div class="card-main-val" id="stat-tables">0</div>
            <div style="font-size: 0.8rem; color: var(--vscode-descriptionForeground);">Iceberg Tables</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tables in Schema Roster -->
    <div class="roster-header">
      <div class="roster-title">Tables (<span id="tables-count">0</span>)</div>
      <input type="text" class="search-input" id="table-search" placeholder="Search tables in this schema…">
    </div>

    <div style="overflow-x: auto;">
      <table id="tables-table">
        <thead>
          <tr>
            <th>Table Name</th>
            <th>Location URI</th>
            <th style="width: 200px;">Actions</th>
          </tr>
        </thead>
        <tbody id="tables-tbody"></tbody>
      </table>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
