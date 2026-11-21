/**
 * Parquet Preview Panel — HTML shell generator.
 *
 * Implements FR-13: preview first 100 rows of a Parquet file.
 * NFR-3: row cap with banner. NFR-8: CSP nonce. NFR-9: --vscode-* colours.
 * FR-18: breadcrumbs. FR-20: user-readable errors.
 *
 * Client-side rendering script is located in src/webviews/parquetPreview.ts
 * and bundled to out/webviews/parquetPreview.js.
 */
import { generateNonce } from './metadataDetail.js';
import { breadcrumbHtml, escHtml } from './shared.js';

export { generateNonce };

export interface ParquetPreviewStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

/**
 * Produce the HTML shell for the Parquet preview panel.
 */
export function getParquetPreviewHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
  styleUris?: ParquetPreviewStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/parquetPreview.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/parquetPreview.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Parquet Preview</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="toolbar">
    <button id="adhoc-btn" data-resource-path="${escHtml(resourcePath)}">Open ad-hoc query →</button>
  </div>
  <div id="cap-banner"></div>
  <div id="loading">Loading preview…</div>
  <div id="error">
    <div id="error-message"></div>
    <button id="retry-btn">Retry</button>
  </div>
  <div id="table-wrapper">
    <table>
      <thead id="thead"><tr id="header-row"></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
