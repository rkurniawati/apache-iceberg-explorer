/**
 * Shared helpers for webview HTML generators.
 *
 * Centralises the four patterns that were duplicated across every panel:
 *   1. escHtml()          — TypeScript-side HTML escaping for template literals
 *   2. breadcrumbCss      — CSS for the #breadcrumb bar (NFR-9)
 *   3. setStateScript     — JS snippet: setState message handler (loading/error states)
 *   4. renderTableScript  — JS snippet: renderTable(columnNames, rows) helper
 */

import { resourcePathToBreadcrumbs } from '../utils.js';

// ── 1. TypeScript-side escaping ───────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in HTML text content or attribute values.
 * Used when building HTML strings in TypeScript template literals (server-side).
 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 2. Breadcrumb HTML builder ────────────────────────────────────────────────

/**
 * Build the static breadcrumb HTML that is embedded into the shell at
 * template-render time.  Each non-final segment becomes a clickable button
 * that posts a breadcrumbNavigate message; the final segment is plain text.
 */
export function breadcrumbHtml(resourcePath: string): string {
  const segments = resourcePathToBreadcrumbs(resourcePath);
  return segments
    .map((seg, i) =>
      i < segments.length - 1
        ? `<button class="breadcrumb-link" data-idx="${i}">${escHtml(seg)}</button><span class="breadcrumb-sep">›</span>`
        : `<span class="breadcrumb-current">${escHtml(seg)}</span>`,
    )
    .join('');
}

// ── 3. Shared CSS ─────────────────────────────────────────────────────────────

/**
 * CSS for the breadcrumb bar.  Included verbatim inside a <style> block.
 * All colours use --vscode-* variables (NFR-9).
 */
export const BREADCRUMB_CSS = `
    #breadcrumb {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem;
      padding: 0 0 0.5rem; border-bottom: 1px solid var(--vscode-editorWidget-border);
      margin-bottom: 1rem; font-size: 0.9em;
    }
    #breadcrumb:empty { display: none; }
    .breadcrumb-sep { opacity: 0.5; }
    .breadcrumb-link {
      color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline;
      background: none; border: none; padding: 0; font: inherit;
    }
    .breadcrumb-link:hover { opacity: 0.8; }
    .breadcrumb-current { font-weight: 600; }`;

/**
 * CSS for the shared table layout used in manifest and preview panels.
 * All colours use --vscode-* variables (NFR-9).
 */
export const TABLE_CSS = `
    #table-wrapper { display: none; overflow-x: auto; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; font-size: var(--vscode-font-size, 13px); }
    th {
      text-align: left; padding: 0.4rem 0.6rem;
      border-bottom: 2px solid var(--vscode-editorWidget-border);
      color: var(--vscode-descriptionForeground); font-weight: 600;
    }
    td { padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--vscode-editorWidget-border); }
    tr:hover td { background: var(--vscode-list-hoverBackground); }`;

// ── 4. Shared client-side JS snippets ────────────────────────────────────────

/**
 * Client-side JS that handles the `setState` message for panels that toggle
 * between a loading indicator, an error box, and a #table-wrapper.
 *
 * Depends on: #loading, #error, #error-message, #table-wrapper being present
 * in the panel's HTML.
 */
export const SET_STATE_SCRIPT = `
    function applyState(msg) {
      if (msg.state === 'loading') {
        document.getElementById('loading').style.display = '';
        document.getElementById('error').style.display = 'none';
        document.getElementById('table-wrapper').style.display = 'none';
      } else if (msg.state === 'error') {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
        document.getElementById('error-message').textContent = msg.message || 'An error occurred.';
        document.getElementById('table-wrapper').style.display = 'none';
      }
    }`;

/**
 * Client-side JS that renders a generic column/row query result into
 * #header-row (a <tr>) and #tbody.
 *
 * Depends on: #header-row and #tbody being present in the panel's HTML.
 */
export const RENDER_TABLE_SCRIPT = `
    function renderTable(columnNames, rows) {
      const headerRow = document.getElementById('header-row');
      headerRow.innerHTML = '';
      for (const col of columnNames) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
      }
      const tbody = document.getElementById('tbody');
      tbody.innerHTML = '';
      for (const row of rows) {
        const tr = document.createElement('tr');
        for (const col of columnNames) {
          const td = document.createElement('td');
          const val = row[col];
          td.textContent = val == null ? '' : String(val);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }`;

/**
 * Client-side JS: two utility functions used in inline scripts.
 *
 *  escHtml(s)  — escapes text for safe innerHTML assignment
 *  escAttr(s)  — escapes a value for use in an HTML attribute
 */
export const ESC_SCRIPT = `
    function escHtml(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
    function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }`;
