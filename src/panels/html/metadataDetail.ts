/**
 * Metadata Detail Panel — HTML shell generator.
 *
 * Implements:
 *  T-18  HTML shell with CSP nonce and theme variables  (NFR-8, NFR-9)
 *  T-19  Table Identity & Versioning section            (FR-10a, FR-10i)
 *  T-20  Schema Information section                     (FR-10b)
 *  T-21  Partitioning section                           (FR-10c)
 *  T-22  Sort Orders section                            (FR-10d)
 *  T-23  Snapshots section                              (FR-10e)
 *  T-24  Refs section                                   (FR-10f)
 *  T-25  Table Properties section                       (FR-10g)
 *  T-26  format-version–aware field omission            (FR-10h, A-8)
 *  T-27  Breadcrumb bar                                 (FR-18)
 *  T-28  Panel state machine and error surface          (FR-20, design.md §2.3)
 *
 * Client-side rendering script is located in src/webviews/metadataDetail.ts
 * and bundled to out/webviews/metadataDetail.js.
 */
import * as crypto from 'node:crypto';

/**
 * Generate a cryptographically random nonce for the CSP header.
 * A fresh value is produced on every call (T-18, NFR-8).
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * URIs for stylesheets and client scripts used by the metadata detail panel.
 */
export interface MetadataDetailStyleUris {
  commonCssUri?: string | { toString(): string };
  panelCssUri?: string | { toString(): string };
  scriptUri?: string | { toString(): string };
}

export type MetadataDetailUris = MetadataDetailStyleUris;

/**
 * Produce the static HTML shell for the metadata detail panel.
 *
 * @param nonce      Per-load CSP nonce (applied to every <script> tag).
 * @param cspSource  Value of webview.cspSource (for img-src and script-src).
 * @param styleUris  Resource URIs for common CSS, panel CSS, and bundled webview JS.
 *
 * NFR-8: CSP nonce on all scripts; no external CDN URLs.
 * NFR-9: All colours use --vscode-* variables; zero hardcoded hex/RGB values.
 */
export function getMetadataDetailHtml(
  nonce: string,
  cspSource: string,
  styleUris?: MetadataDetailStyleUris,
): string {
  const commonCssHref = styleUris?.commonCssUri ?? 'resources/css/common.css';
  const panelCssHref = styleUris?.panelCssUri ?? 'resources/css/metadataDetail.css';
  const scriptSrc = styleUris?.scriptUri ?? 'out/webviews/metadataDetail.js';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Metadata Detail</title>
  <link rel="stylesheet" href="${commonCssHref}">
  <link rel="stylesheet" href="${panelCssHref}">
</head>
<body>

  <!-- FR-18: Breadcrumb bar — populated by webview script once resourcePath is known -->
  <div id="breadcrumb" aria-label="Navigation breadcrumb"></div>

  <!-- Top bar: format-version badge + view mode toggle buttons -->
  <div id="top-bar">
    <!-- FR-10i: Format-version badge — prominently placed above all sections -->
    <div id="format-version-badge" style="display:none"></div>
    <div id="view-actions" class="view-actions" style="display:none;">
      <button class="btn" id="toggle-raw-json-btn" type="button" aria-pressed="false" title="Toggle between structured view and formatted raw JSON">
        <span id="toggle-raw-icon">{ }</span> <span id="toggle-raw-label">Raw JSON</span>
      </button>
      <button class="btn" id="copy-raw-json-btn" type="button" style="display:none;" title="Copy formatted raw JSON to clipboard">
        📋 Copy JSON
      </button>
    </div>
  </div>

  <!-- Loading / error / content states (design.md §2.3) -->
  <div id="loading-indicator" aria-live="polite">
    <div class="spinner" role="status" aria-label="Loading…"></div>
    <span>Loading metadata…</span>
  </div>

  <!-- FR-20: Error area — static message strings, no raw exception text -->
  <div id="error-area" role="alert">
    <p id="error-message"></p>
    <button id="error-retry-btn" type="button">Retry</button>
  </div>

  <!-- Populated by section renderers when state transitions to 'loaded' -->
  <div id="content-area">
    <div id="section-identity"      class="section"></div>
    <div id="section-view-sql"      class="section" style="display:none;"></div>
    <div id="section-view-versions" class="section" style="display:none;"></div>
    <div id="section-schemas"       class="section"></div>
    <div id="section-partitioning"  class="section"></div>
    <div id="section-sort-orders"   class="section"></div>
    <div id="section-snapshots"     class="section"></div>
    <div id="section-refs"          class="section"></div>
    <div id="section-properties"    class="section"></div>
  </div>

  <!-- Raw JSON view (formatted for human) -->
  <div id="raw-json-container" style="display:none;">
    <div class="raw-json-header">
      <div class="raw-json-meta">
        <span class="raw-json-title">Raw Metadata JSON</span>
        <span id="raw-json-stats" class="raw-json-stats"></span>
      </div>
    </div>
    <pre class="raw-json-pre" id="raw-json-pre"><code id="raw-json-code" class="raw-json-code"></code></pre>
  </div>

<script nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
}
