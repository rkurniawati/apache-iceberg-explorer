/**
 * Shared client-side helpers for webview scripts.
 */

/**
 * Handles the `setState` message for panels that toggle between
 * `#loading`, `#error`, `#error-message`, and `#table-wrapper`.
 */
export function applyState(msg: { state?: string; message?: string }): void {
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const errorMsgEl = document.getElementById('error-message');
  const tableWrapperEl = document.getElementById('table-wrapper');

  if (msg.state === 'loading') {
    if (loadingEl) loadingEl.style.display = '';
    if (errorEl) errorEl.style.display = 'none';
    if (tableWrapperEl) tableWrapperEl.style.display = 'none';
  } else if (msg.state === 'error') {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'block';
    if (errorMsgEl) errorMsgEl.textContent = msg.message || 'An error occurred.';
    if (tableWrapperEl) tableWrapperEl.style.display = 'none';
  }
}

/**
 * Renders a generic column/row query result into `#header-row` and `#tbody`.
 */
export function renderTable(
  columnNames: string[],
  rows: Array<Record<string, unknown>>,
): void {
  const headerRow = document.getElementById('header-row');
  if (headerRow) {
    headerRow.innerHTML = '';
    for (const col of columnNames) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
  }
  const tbody = document.getElementById('tbody');
  if (tbody) {
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
  }
}

/**
 * Escapes text for safe `innerHTML` assignment via DOM textContent.
 */
export function escHtml(s: unknown): string {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

/**
 * Escapes a value for use in a double-quoted HTML attribute.
 */
export function escAttr(s: unknown): string {
  return String(s).replace(/"/g, '&quot;');
}

/**
 * Escapes `&`, `<`, `>`, and `"` for safe HTML interpolation.
 */
export function esc(s: unknown): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

