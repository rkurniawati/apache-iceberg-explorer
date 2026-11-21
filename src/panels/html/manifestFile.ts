/**
 * Manifest File Panel — HTML shell generator.
 *
 * Implements FR-12: display manifest file entries from an Avro manifest file.
 * NFR-8: CSP nonce. NFR-9: --vscode-* colours only. FR-18: breadcrumbs.
 * FR-20: user-readable errors. A-5: ORC files have no preview link.
 *
 * Client-side rendering script is located in src/webviews/manifestFile.ts
 * and bundled to out/webviews/manifestFile.js.
 */
import { generateNonce } from './metadataDetail.js';
import { breadcrumbHtml } from './shared.js';

export { generateNonce };

export interface ManifestFileStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

/**
 * Produce the HTML shell for the manifest file panel.
 */
export function getManifestFileHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
  styleUris?: ManifestFileStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/manifestFile.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/manifestFile.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manifest File</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="loading">Loading manifest file…</div>
  <div id="error">
    <div id="error-message"></div>
    <button id="retry-btn">Retry</button>
  </div>
  <div id="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>File Path</th>
          <th>Format</th>
          <th>Record Count</th>
          <th>File Size</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
