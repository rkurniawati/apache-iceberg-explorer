/**
 * Ad-hoc Query Panel — HTML shell generator.
 *
 * Implements FR-14–FR-17: SQL textarea, Run button, Cancel button, results table.
 * FR-16: Cancel button visible during loading. FR-17: timeout handled in QueryEngine.
 * NFR-8: CSP nonce. NFR-9: --vscode-* colours. FR-18: breadcrumbs. FR-20: errors.
 *
 * Client-side rendering script is located in src/webviews/adHocQuery.ts
 * and bundled to out/webviews/adHocQuery.js.
 */
import { generateNonce } from './metadataDetail.js';
import { breadcrumbHtml, escHtml } from './shared.js';

export { generateNonce };

export interface AdHocQueryStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

/**
 * Produce the HTML shell for the ad-hoc query panel.
 * Starts in `idle` state: textarea + Run visible; results and errors hidden.
 */
export function getAdHocQueryHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
  initialSql?: string,
  styleUris?: AdHocQueryStyleUris,
): string {
  const queryText = initialSql ? escHtml(initialSql) : 'SELECT * FROM data LIMIT 100;';
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/adHocQuery.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/adHocQuery.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ad-hoc Query</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="query-area">
    <textarea id="sql-input" placeholder="SELECT * FROM data LIMIT 100">${queryText}</textarea>
    <div id="btn-row">
      <button id="run-btn">Run</button>
      <button id="cancel-btn">Cancel</button>
      <span id="status-text"></span>
    </div>
  </div>
  <div id="cap-banner"></div>
  <div id="error-area"></div>
  <div id="table-wrapper">
    <table>
      <thead><tr id="header-row"></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
