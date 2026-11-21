/**
 * Table Overview Webview Client Script
 *
 * Implements:
 *  - Table Identity & Versioning header
 *  - Schema & Column types table
 *  - Partition specifications
 *  - Embedded Data Preview with DuckDB-WASM
 *  - Snapshots list with link to Metadata Structure
 */
import { esc } from './shared.js';

interface TableColumnItem {
  id: number;
  name: string;
  type: string;
  required: boolean;
  doc?: string;
}

interface TablePartitionItem {
  sourceId: number;
  fieldId: number;
  name: string;
  transform: string;
}

interface SnapshotSummary {
  snapshotId: string;
  parentSnapshotId: string | null;
  timestampMs: number;
  operation: string;
  addedRecords?: string;
  deletedRecords?: string;
  addedFiles?: string;
  manifestList?: string;
}

interface ViewVersionItem {
  versionId: number;
  timestampMs: number;
  representations?: Array<{ type?: string; dialect?: string; sql?: string }>;
}

interface TableOverviewPayload {
  type: 'loadTableOverview';
  tablePath: string;
  tableName: string;
  formatVersion: number;
  tableUuid: string;
  location: string;
  currentSnapshotId: string | null;
  lastUpdatedMs: number | null;
  columns?: TableColumnItem[];
  partitionSpec?: TablePartitionItem[];
  snapshotsCount?: number;
  properties?: Record<string, string>;
  latestMetadataPath: string;
  snapshots?: SnapshotSummary[];
  isView?: boolean;
  viewUuid?: string;
  currentVersionId?: number;
  viewSql?: string;
  viewDialect?: string;
  defaultCatalog?: string;
  defaultNamespace?: string[];
  viewVersions?: ViewVersionItem[];
}

interface DataPreviewPayload {
  type: 'loadDataPreview';
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  error?: string;
}

const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewReady' });

let currentOverview: TableOverviewPayload | null = null;
let currentPreview: DataPreviewPayload | null = null;
let allColumns: TableColumnItem[] = [];
let allSnapshots: SnapshotSummary[] = [];
let snapshotPage = 0;
const SNAPSHOTS_PER_PAGE = 10;

// Breadcrumbs
document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.breadcrumb-link') as HTMLElement | null;
  if (btn) {
    vscode.postMessage({
      type: 'breadcrumbNavigate',
      segment: parseInt(btn.getAttribute('data-idx') || '0', 10),
    });
  }
});

// Retry
document.getElementById('retry-btn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'retry' });
});

// Action buttons
document.getElementById('query-btn')?.addEventListener('click', () => {
  if (currentOverview) {
    vscode.postMessage({
      type: 'openAdHocQuery',
      resourcePath: currentOverview.tablePath,
      initialSql: currentOverview.viewSql,
    });
  }
});

document.getElementById('copy-sql-btn')?.addEventListener('click', () => {
  if (currentOverview?.viewSql) {
    navigator.clipboard?.writeText(currentOverview.viewSql).catch(() => {});
    const btn = document.getElementById('copy-sql-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
  }
});

document.getElementById('view-metadata-btn')?.addEventListener('click', () => {
  if (currentOverview?.latestMetadataPath) {
    vscode.postMessage({ type: 'openMetadataPanel', resourcePath: currentOverview.latestMetadataPath });
  }
});

document.getElementById('view-dag-btn')?.addEventListener('click', () => {
  if (currentOverview) {
    vscode.postMessage({ type: 'openMetadataStructure', resourcePath: currentOverview.tablePath });
  }
});

document.getElementById('load-preview-btn')?.addEventListener('click', () => {
  if (currentOverview) {
    const previewLoading = document.getElementById('preview-loading');
    const previewWrapper = document.getElementById('preview-wrapper');
    if (previewLoading) previewLoading.style.display = 'block';
    if (previewWrapper) previewWrapper.style.display = 'none';
    vscode.postMessage({ type: 'fetchDataPreview', tablePath: currentOverview.tablePath });
  }
});

// Tabs
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => {
      (c as HTMLElement).style.display = 'none';
    });
    btn.classList.add('active');
    const tabKey = btn.getAttribute('data-tab');
    const tabEl = tabKey ? document.getElementById('tab-' + tabKey) : null;
    if (tabEl) tabEl.style.display = 'block';

    if (tabKey === 'preview' && !currentPreview && currentOverview) {
      const previewLoading = document.getElementById('preview-loading');
      if (previewLoading) previewLoading.style.display = 'block';
      vscode.postMessage({ type: 'fetchDataPreview', tablePath: currentOverview.tablePath });
    }
  });
});

// Filter columns
document.getElementById('schema-search')?.addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  const q = target.value.toLowerCase();
  renderColumns(allColumns.filter((c) => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)));
});

// Snapshot pagination
document.getElementById('snap-prev-btn')?.addEventListener('click', () => {
  if (snapshotPage > 0) {
    snapshotPage--;
    renderSnapshots();
  }
});

document.getElementById('snap-next-btn')?.addEventListener('click', () => {
  const maxPage = Math.ceil(allSnapshots.length / SNAPSHOTS_PER_PAGE) - 1;
  if (snapshotPage < maxPage) {
    snapshotPage++;
    renderSnapshots();
  }
});

function renderColumns(cols: TableColumnItem[]): void {
  const tbody = document.getElementById('schema-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  cols.forEach((col) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color: var(--vscode-descriptionForeground);">${col.id}</td>
      <td><strong>${esc(col.name)}</strong></td>
      <td><code style="color: var(--vscode-symbolIcon-classForeground, #4ec9b0);">${esc(col.type)}</code></td>
      <td>${col.required ? '<span style="color: #f87171;">Required</span>' : '<span style="opacity: 0.7;">Optional</span>'}</td>
      <td style="color: var(--vscode-descriptionForeground);">${esc(col.doc || '—')}</td>
    `;
    tbody.appendChild(tr);
  });
  const colCountEl = document.getElementById('column-count');
  if (colCountEl) colCountEl.textContent = String(cols.length);
}

function renderSnapshots(): void {
  const list = document.getElementById('snapshots-list');
  if (!list) return;
  list.innerHTML = '';
  const total = allSnapshots.length;
  const totalEl = document.getElementById('snapshots-total');
  if (totalEl) totalEl.textContent = String(total);

  const start = snapshotPage * SNAPSHOTS_PER_PAGE;
  const end = Math.min(start + SNAPSHOTS_PER_PAGE, total);
  const pageItems = allSnapshots.slice(start, end);

  const maxPage = Math.max(0, Math.ceil(total / SNAPSHOTS_PER_PAGE) - 1);
  const pageIndEl = document.getElementById('snap-page-indicator');
  if (pageIndEl) pageIndEl.textContent = `Page ${snapshotPage + 1} of ${maxPage + 1}`;
  const prevBtn = document.getElementById('snap-prev-btn') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('snap-next-btn') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = snapshotPage === 0;
  if (nextBtn) nextBtn.disabled = snapshotPage >= maxPage;

  pageItems.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'timeline-card';
    const op = (s.operation || 'unknown').toLowerCase();
    let opClass = 'op-append';
    if (op.includes('overwrite')) opClass = 'op-overwrite';
    else if (op.includes('replace')) opClass = 'op-replace';
    else if (op.includes('delete')) opClass = 'op-delete';

    const dateStr = new Date(s.timestampMs).toLocaleString();
    const diffSummary: string[] = [];
    if (s.addedRecords) diffSummary.push(`+${s.addedRecords} records`);
    if (s.deletedRecords) diffSummary.push(`-${s.deletedRecords} records`);
    if (s.addedFiles) diffSummary.push(`+${s.addedFiles} files`);

    card.innerHTML = `
      <div class="timeline-left">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span class="timeline-id">#${s.snapshotId}</span>
          <span class="op-badge ${opClass}">${esc(s.operation || 'commit')}</span>
        </div>
        <div class="timeline-meta">${dateStr} ${s.parentSnapshotId ? ' &bull; parent: #' + s.parentSnapshotId : ''}</div>
      </div>
      <div style="font-size: 0.85rem; color: var(--vscode-descriptionForeground);">
        ${diffSummary.join(' &bull; ')}
      </div>
    `;
    list.appendChild(card);
  });
}

function renderPreview(data: DataPreviewPayload): void {
  const loadingEl = document.getElementById('preview-loading');
  const wrapper = document.getElementById('preview-wrapper');
  const errBox = document.getElementById('preview-error');

  if (loadingEl) loadingEl.style.display = 'none';

  if (data.error) {
    if (errBox) {
      errBox.textContent = data.error;
      errBox.style.display = 'block';
    }
    if (wrapper) wrapper.style.display = 'none';
    return;
  }
  if (errBox) errBox.style.display = 'none';
  if (wrapper) wrapper.style.display = 'block';

  const thead = document.getElementById('preview-thead');
  const tbody = document.getElementById('preview-tbody');
  if (!thead || !tbody) return;
  thead.innerHTML = '';
  tbody.innerHTML = '';

  const tr = document.createElement('tr');
  data.columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
    tr.appendChild(th);
  });
  thead.appendChild(tr);

  data.rows.forEach((row) => {
    const rowTr = document.createElement('tr');
    data.columns.forEach((col) => {
      const td = document.createElement('td');
      const val = row[col];
      td.textContent = val !== null && val !== undefined ? String(val) : 'NULL';
      if (val === null || val === undefined) {
        td.style.color = 'var(--vscode-descriptionForeground)';
        td.style.fontStyle = 'italic';
      }
      rowTr.appendChild(td);
    });
    tbody.appendChild(rowTr);
  });
  const rowCountEl = document.getElementById('preview-row-count');
  if (rowCountEl) rowCountEl.textContent = String(data.rows.length);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const errorMsgEl = document.getElementById('error-message');
  const contentEl = document.getElementById('content');

  if (msg.type === 'setState') {
    if (msg.state === 'loading') {
      if (loadingEl) loadingEl.style.display = 'block';
      if (errorEl) errorEl.style.display = 'none';
      if (contentEl) contentEl.style.display = 'none';
    } else if (msg.state === 'error') {
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'block';
      if (errorMsgEl) errorMsgEl.textContent = msg.message || 'An error occurred.';
      if (contentEl) contentEl.style.display = 'none';
    } else if (msg.state === 'idle') {
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'none';
      if (contentEl) contentEl.style.display = 'block';
    }
  } else if (msg.type === 'loadTableOverview') {
    currentOverview = msg;
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    const tableNameEl = document.getElementById('table-name');
    if (tableNameEl) tableNameEl.textContent = (msg.isView ? 'View ' : 'Table ') + msg.tableName;

    const vBadge = document.getElementById('version-badge');
    const queryBtn = document.getElementById('query-btn');
    const viewDagBtn = document.getElementById('view-dag-btn');
    const itemCurrentSnap = document.getElementById('item-current-snapshot');
    const partitionSec = document.getElementById('partition-section');
    const tabBtnPreview = document.getElementById('tab-btn-preview');
    const itemViewUuid = document.getElementById('item-view-uuid');
    const viewUuidEl = document.getElementById('view-uuid');
    const itemCurrentVersion = document.getElementById('item-current-version');
    const currentVersionEl = document.getElementById('current-version');
    const itemDefaultNs = document.getElementById('item-default-namespace');
    const defaultNsEl = document.getElementById('default-namespace');
    const itemDefaultCat = document.getElementById('item-default-catalog');
    const defaultCatEl = document.getElementById('default-catalog');
    const tabBtnSql = document.getElementById('tab-btn-sql');
    const tabBtnSnaps = document.getElementById('tab-btn-snapshots');
    const viewSqlCode = document.getElementById('view-sql-code');
    const viewDialectBadge = document.getElementById('view-dialect-badge');
    const tabSql = document.getElementById('tab-sql');

    if (msg.isView) {
      if (vBadge) {
        vBadge.textContent = 'VIEW (v' + msg.formatVersion + ')';
        vBadge.className = 'badge';
        vBadge.style.background = '#0284c7';
        vBadge.style.color = '#fff';
      }

      // Views are metadata-only objects; querying and data previews are not applicable
      if (queryBtn) queryBtn.style.display = 'none';
      if (viewDagBtn) viewDagBtn.style.display = 'none';
      if (itemCurrentSnap) itemCurrentSnap.style.display = 'none';
      if (partitionSec) partitionSec.style.display = 'none';
      if (tabBtnPreview) tabBtnPreview.style.display = 'none';

      if (itemViewUuid) itemViewUuid.style.display = 'inline';
      if (viewUuidEl) viewUuidEl.textContent = msg.viewUuid || msg.tableUuid;
      if (itemCurrentVersion) itemCurrentVersion.style.display = 'inline';
      if (currentVersionEl) currentVersionEl.textContent = 'v' + (msg.currentVersionId ?? 1);

      if (msg.defaultNamespace && msg.defaultNamespace.length > 0) {
        if (itemDefaultNs) itemDefaultNs.style.display = 'inline';
        if (defaultNsEl) defaultNsEl.textContent = msg.defaultNamespace.join('.');
      } else {
        if (itemDefaultNs) itemDefaultNs.style.display = 'none';
      }

      if (msg.defaultCatalog) {
        if (itemDefaultCat) itemDefaultCat.style.display = 'inline';
        if (defaultCatEl) defaultCatEl.textContent = msg.defaultCatalog;
      } else {
        if (itemDefaultCat) itemDefaultCat.style.display = 'none';
      }

      if (tabBtnSql) tabBtnSql.style.display = 'inline-block';
      if (tabBtnSnaps) tabBtnSnaps.textContent = 'Versions & History';
      if (viewSqlCode) viewSqlCode.textContent = msg.viewSql || 'No SQL definition available.';
      if (viewDialectBadge) viewDialectBadge.textContent = (msg.viewDialect || 'sql').toUpperCase();

      // If current tab is preview, switch to View SQL tab
      const activeTabBtn = document.querySelector('.tab-btn.active');
      if (activeTabBtn && activeTabBtn.getAttribute('data-tab') === 'preview') {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
        if (tabBtnSql) tabBtnSql.classList.add('active');
        if (tabSql) tabSql.classList.add('active');
      }
    } else {
      if (vBadge) {
        vBadge.textContent = 'v' + msg.formatVersion;
        vBadge.className = 'badge badge-v' + msg.formatVersion;
        vBadge.style.background = '';
        vBadge.style.color = '';
      }

      if (queryBtn) queryBtn.style.display = 'inline-flex';
      if (viewDagBtn) viewDagBtn.style.display = 'inline-flex';
      if (itemCurrentSnap) itemCurrentSnap.style.display = 'inline';
      if (partitionSec) partitionSec.style.display = 'block';
      if (tabBtnPreview) tabBtnPreview.style.display = 'inline-block';

      if (itemViewUuid) itemViewUuid.style.display = 'none';
      if (itemCurrentVersion) itemCurrentVersion.style.display = 'none';
      if (itemDefaultNs) itemDefaultNs.style.display = 'none';
      if (itemDefaultCat) itemDefaultCat.style.display = 'none';

      if (tabBtnSql) tabBtnSql.style.display = 'none';
      if (tabBtnSnaps) tabBtnSnaps.textContent = 'Snapshots History';
    }

    const tableLocEl = document.getElementById('table-location');
    const curSnapEl = document.getElementById('current-snapshot');
    const tableUpdEl = document.getElementById('table-updated');
    if (tableLocEl) tableLocEl.textContent = msg.location;
    if (curSnapEl) curSnapEl.textContent = msg.currentSnapshotId || 'None';
    if (tableUpdEl) tableUpdEl.textContent = msg.lastUpdatedMs ? new Date(msg.lastUpdatedMs).toLocaleString() : 'Unknown';

    // Partition Spec
    const pChips = document.getElementById('partition-chips');
    if (pChips) {
      pChips.innerHTML = '';
      if (msg.partitionSpec && msg.partitionSpec.length > 0) {
        msg.partitionSpec.forEach((p: TablePartitionItem) => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = `${p.name} (${p.transform})`;
          pChips.appendChild(chip);
        });
      } else {
        pChips.innerHTML = '<span style="color: var(--vscode-descriptionForeground); font-style: italic;">Unpartitioned</span>';
      }
    }

    // Columns
    allColumns = msg.columns || [];
    renderColumns(allColumns);

    // Properties
    const pTbody = document.getElementById('properties-tbody');
    const pSection = document.getElementById('properties-section');
    if (pTbody) {
      pTbody.innerHTML = '';
      const props = Object.entries(msg.properties || {});
      if (props.length > 0) {
        props.forEach(([k, v]) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td style="font-family: monospace;">${esc(k)}</td><td>${esc(v)}</td>`;
          pTbody.appendChild(tr);
        });
        if (pSection) pSection.style.display = 'block';
      } else {
        if (pSection) pSection.style.display = 'none';
      }
    }

    // Snapshots or View Versions
    if (msg.isView && Array.isArray(msg.viewVersions) && msg.viewVersions.length > 0) {
      allSnapshots = msg.viewVersions.map((v: ViewVersionItem) => ({
        snapshotId: 'v' + v.versionId,
        parentSnapshotId: null,
        timestampMs: v.timestampMs,
        operation: (v.representations && v.representations[0]?.dialect) ? v.representations[0].dialect.toUpperCase() : 'VIEW',
        addedRecords: undefined,
        deletedRecords: undefined,
        addedFiles: undefined,
        manifestList: undefined,
      }));
    } else {
      allSnapshots = msg.snapshots || [];
    }
    snapshotPage = 0;
    renderSnapshots();
  } else if (msg.type === 'loadDataPreview') {
    currentPreview = msg;
    renderPreview(msg);
  }
});

