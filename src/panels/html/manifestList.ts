/**
 * Manifest List Panel — HTML shell generator.
 *
 * Implements FR-11: display manifest list entries from an Avro manifest-list file.
 * NFR-8: CSP nonce on all scripts.
 * NFR-9: All colours use --vscode-* variables only.
 * FR-18: Breadcrumb bar.
 * FR-20: User-readable error state.
 *
 * Client-side rendering script is located in src/webviews/manifestList.ts
 * and bundled to out/webviews/manifestList.js.
 */
import { generateNonce } from './metadataDetail.js';
import { breadcrumbHtml } from './shared.js';

export { generateNonce };

export interface ManifestListStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

/**
 * Produce the HTML shell for the manifest list panel.
 * Rendered in `loading` state initially; the host posts messages to drive transitions.
 */
export function getManifestListHtml(
  nonce: string,
  cspSource: string,
  resourcePath: string,
  styleUris?: ManifestListStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/manifestList.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/manifestList.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manifest List</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>
  <div id="breadcrumb">${breadcrumbHtml(resourcePath)}</div>
  <div id="loading">Loading manifest list…</div>
  <div id="error">
    <div id="error-message"></div>
    <button id="retry-btn">Retry</button>
  </div>
  <div id="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Manifest Path</th>
          <th>Partition Spec ID</th>
          <th>Content</th>
          <th>Added Files</th>
          <th>Existing Files</th>
          <th>Deleted Files</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
