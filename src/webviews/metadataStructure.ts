/**
 * Metadata Structure Webview Client Script
 *
 * Implements:
 *  - Snapshot Manifest Hierarchy DAG for the selected snapshot (Metadata -> Snapshot -> Manifest List -> Manifests)
 *  - Paginated commit timeline for snapshots (10 per page, prev/next)
 *  - Stop at Manifest level with on-demand drill down to data files
 */
import { esc } from './shared.js';

interface SnapshotSummary {
  snapshotId: string;
  parentSnapshotId: string | null;
  timestampMs: number;
  operation: string;
}

interface ManifestCard {
  path: string;
  partitionSpecId: number;
  addedFiles: number;
  existingFiles: number;
  deletedFiles: number;
  partitionSummary?: string;
}

interface MetadataVersionItem {
  label: string;
  resourcePath: string;
  isLatest: boolean;
}

interface MetadataStructurePayload {
  type: 'loadMetadataStructure' | 'loadMetadataArchitecture';
  tablePath: string;
  metadataFile: string;
  availableMetadataFiles?: MetadataVersionItem[];
  currentSnapshotId: string | null;
  snapshots?: SnapshotSummary[];
  activeSnapshot: {
    snapshotId: string;
    manifestList: string;
    manifests: ManifestCard[];
  } | null;
}

interface ManifestDataFileItem {
  path: string;
  status: string;
  recordCount: number;
  fileSizeInBytes: number;
}

const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewReady' });

let currentStructure: MetadataStructurePayload | null = null;
let allSnapshots: SnapshotSummary[] = [];
let selectedSnapshotId: string | null = null;
let timelinePage = 0;
const PAGE_SIZE = 10;

document.getElementById('retry-btn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'retry' });
});

document.getElementById('open-overview-btn')?.addEventListener('click', () => {
  if (currentStructure) {
    vscode.postMessage({ type: 'openTableOverview', resourcePath: currentStructure.tablePath });
  }
});

document.getElementById('breadcrumb')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.breadcrumb-link') as HTMLElement | null;
  if (btn) {
    vscode.postMessage({
      type: 'breadcrumbNavigate',
      segment: Number(btn.dataset.idx),
    });
  }
});

document.getElementById('view-meta-json-btn')?.addEventListener('click', () => {
  if (currentStructure && currentStructure.metadataFile) {
    vscode.postMessage({
      type: 'openMetadataPanel',
      resourcePath: currentStructure.metadataFile,
    });
  }
});

document.getElementById('meta-file-select')?.addEventListener('change', (e) => {
  const target = e.target as HTMLSelectElement | null;
  const selectedPath = target ? target.value : null;
  if (selectedPath && currentStructure && selectedPath !== currentStructure.metadataFile) {
    vscode.postMessage({
      type: 'selectStructureMetadataFile',
      tablePath: currentStructure.tablePath,
      metadataPath: selectedPath,
    });
  }
});

// Pagination
document.getElementById('page-prev-btn')?.addEventListener('click', () => {
  if (timelinePage > 0) {
    timelinePage--;
    renderTimeline();
  }
});

document.getElementById('page-next-btn')?.addEventListener('click', () => {
  const maxPage = Math.ceil(allSnapshots.length / PAGE_SIZE) - 1;
  if (timelinePage < maxPage) {
    timelinePage++;
    renderTimeline();
  }
});

function renderTimeline(): void {
  const scroll = document.getElementById('timeline-scroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  const total = allSnapshots.length;
  const totalEl = document.getElementById('total-commits');
  if (totalEl) totalEl.textContent = String(total);

  const start = timelinePage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const pageItems = allSnapshots.slice(start, end);

  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const pageIndEl = document.getElementById('page-indicator');
  if (pageIndEl) pageIndEl.textContent = `Page ${timelinePage + 1} of ${maxPage + 1}`;
  const prevBtn = document.getElementById('page-prev-btn') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('page-next-btn') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = timelinePage === 0;
  if (nextBtn) nextBtn.disabled = timelinePage >= maxPage;

  pageItems.forEach((s) => {
    const chip = document.createElement('div');
    chip.className = 'snap-chip' + (s.snapshotId === selectedSnapshotId ? ' selected' : '');
    const op = (s.operation || 'unknown').toLowerCase();
    let opClass = 'op-append';
    if (op.includes('overwrite')) opClass = 'op-overwrite';
    else if (op.includes('replace')) opClass = 'op-replace';
    else if (op.includes('delete')) opClass = 'op-delete';

    chip.innerHTML = `
      <div class="snap-chip-header">
        <span class="snap-chip-id">#${s.snapshotId}</span>
        <span class="op-badge ${opClass}">${esc(s.operation || 'commit')}</span>
      </div>
      <div class="snap-chip-time">${new Date(s.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}</div>
    `;
    chip.addEventListener('click', () => {
      selectedSnapshotId = s.snapshotId;
      renderTimeline();
      const snapLabel = document.getElementById('selected-snap-label');
      if (snapLabel) snapLabel.textContent = '#' + s.snapshotId;
      if (currentStructure) {
        vscode.postMessage({
          type: 'selectStructureSnapshot',
          tablePath: currentStructure.tablePath,
          snapshotId: s.snapshotId,
          metadataPath: currentStructure.metadataFile,
        });
      }
    });
    scroll.appendChild(chip);
  });
}

function renderManifests(manifests: ManifestCard[]): void {
  const list = document.getElementById('manifests-list');
  if (!list) return;
  list.innerHTML = '';
  const countEl = document.getElementById('manifests-count');
  if (countEl) countEl.textContent = String(manifests.length);

  if (manifests.length === 0) {
    list.innerHTML = '<div class="empty-state">No manifests found for this snapshot</div>';
    return;
  }

  manifests.forEach((m, idx) => {
    const card = document.createElement('div');
    card.className = 'manifest-card';
    const filename = m.path.split('/').pop() || m.path;

    card.innerHTML = `
      <div class="manifest-header">
        <div>
          <div class="manifest-path">${esc(filename)}</div>
          <div class="manifest-stats">
            <span>Partition Spec: #${m.partitionSpecId}</span>
            <span>&bull;</span>
            <span class="stat-added">+${m.addedFiles} added</span>
            <span>&bull;</span>
            <span>${m.existingFiles} existing</span>
            <span>&bull;</span>
            <span class="stat-deleted">-${m.deletedFiles} deleted</span>
          </div>
          ${m.partitionSummary ? '<div class="manifest-summary">' + esc(m.partitionSummary) + '</div>' : ''}
        </div>
        <div>
          <button class="btn btn-secondary drill-btn" data-path="${esc(m.path)}" data-idx="${idx}">View Data Files &darr;</button>
        </div>
      </div>
      <div class="data-files-drawer" id="drawer-${idx}">
        <div class="spinner-small hidden" id="spin-${idx}">Loading data files…</div>
        <div id="drawer-content-${idx}"></div>
      </div>
    `;
    list.appendChild(card);
  });
}

document.getElementById('manifests-list')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.drill-btn') as HTMLElement | null;
  if (btn) {
    const idx = btn.getAttribute('data-idx');
    const path = btn.getAttribute('data-path');
    const drawer = idx ? document.getElementById('drawer-' + idx) : null;
    if (!drawer || !idx) return;
    if (drawer.style.display === 'block') {
      drawer.style.display = 'none';
      btn.innerHTML = 'View Data Files &darr;';
    } else {
      drawer.style.display = 'block';
      btn.innerHTML = 'Hide Data Files &uarr;';
      const content = document.getElementById('drawer-content-' + idx);
      const spin = document.getElementById('spin-' + idx);
      if (content && !content.hasChildNodes()) {
        if (spin) spin.style.display = 'block';
        vscode.postMessage({ type: 'fetchManifestDataFiles', manifestPath: path });
      }
    }
    return;
  }

  const previewBtn = target?.closest('.preview-btn') as HTMLElement | null;
  if (previewBtn) {
    const resourcePath = previewBtn.getAttribute('data-path');
    if (resourcePath) {
      vscode.postMessage({ type: 'openParquetPreview', resourcePath });
    }
  }
});

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
  } else if (msg.type === 'loadMetadataStructure' || msg.type === 'loadMetadataArchitecture') {
    currentStructure = msg;
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    allSnapshots = msg.snapshots || [];
    selectedSnapshotId = msg.activeSnapshot ? msg.activeSnapshot.snapshotId : msg.currentSnapshotId;
    const snapLabelEl = document.getElementById('selected-snap-label');
    if (snapLabelEl) snapLabelEl.textContent = selectedSnapshotId ? '#' + selectedSnapshotId : 'None';

    const metaFilename = msg.metadataFile.split('/').pop() || msg.metadataFile;
    const nodeMetaFileEl = document.getElementById('node-meta-file');
    if (nodeMetaFileEl) nodeMetaFileEl.textContent = metaFilename;

    // Populate metadata versions dropdown
    const selectEl = document.getElementById('meta-file-select') as HTMLSelectElement | null;
    const avail: MetadataVersionItem[] = msg.availableMetadataFiles || [];
    if (selectEl) {
      selectEl.innerHTML = '';
      if (avail.length > 0) {
        avail.forEach((v) => {
          const opt = document.createElement('option');
          opt.value = v.resourcePath;
          opt.textContent = v.label + (v.isLatest ? ' (Latest)' : '');
          if (v.resourcePath === msg.metadataFile) {
            opt.selected = true;
          }
          selectEl.appendChild(opt);
        });
        selectEl.style.display = 'inline-block';
      } else {
        selectEl.style.display = 'none';
      }
    }

    // Display version status badge
    const badgeContainer = document.getElementById('node-meta-badge');
    if (badgeContainer) {
      badgeContainer.innerHTML = '';
      const curMetaInfo = avail.find((v) => v.resourcePath === msg.metadataFile);
      const isLatest = curMetaInfo ? curMetaInfo.isLatest : true;
      const pill = document.createElement('span');
      pill.className = 'meta-pill' + (isLatest ? '' : ' historical');
      pill.textContent = isLatest ? 'Latest Metadata Version' : 'Historical Metadata Version';
      badgeContainer.appendChild(pill);
    }

    const nodeSnapIdEl = document.getElementById('node-snap-id');
    const nodeMlFileEl = document.getElementById('node-ml-file');
    if (msg.activeSnapshot) {
      if (nodeSnapIdEl) nodeSnapIdEl.textContent = 'Snapshot #' + msg.activeSnapshot.snapshotId;
      const mlName = msg.activeSnapshot.manifestList.split('/').pop() || msg.activeSnapshot.manifestList;
      if (nodeMlFileEl) nodeMlFileEl.textContent = mlName;
      renderManifests(msg.activeSnapshot.manifests || []);
    } else {
      if (nodeSnapIdEl) nodeSnapIdEl.textContent = 'No Active Snapshot';
      if (nodeMlFileEl) nodeMlFileEl.textContent = '—';
      renderManifests([]);
    }

    timelinePage = 0;
    renderTimeline();
  } else if (msg.type === 'loadManifestDataFiles') {
    // Find drawer with matching manifest path
    document.querySelectorAll('.drill-btn').forEach((btn) => {
      if (btn.getAttribute('data-path') === msg.manifestPath) {
        const idx = btn.getAttribute('data-idx');
        const spin = idx ? document.getElementById('spin-' + idx) : null;
        const content = idx ? document.getElementById('drawer-content-' + idx) : null;
        if (spin) spin.style.display = 'none';
        if (!content) return;
        content.innerHTML = '';

        if (msg.error) {
          content.innerHTML = `<div class="drawer-error">${esc(msg.error)}</div>`;
          return;
        }
        const files: ManifestDataFileItem[] = msg.files || [];
        if (files.length === 0) {
          content.innerHTML = '<div class="drawer-empty">No data files found in this manifest</div>';
          return;
        }

        const table = document.createElement('table');
        table.innerHTML = `
          <thead>
            <tr>
              <th>Status</th>
              <th>Data File Path</th>
              <th>Records</th>
              <th>Size</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody>
            ${files.map((f) => {
              const fname = f.path.split('/').pop() || f.path;
              const isParquet = fname.endsWith('.parquet');
              const sizeKb = (f.fileSizeInBytes / 1024).toFixed(1) + ' KB';
              return `
                <tr>
                  <td><span class="badge badge-sm">${esc(f.status)}</span></td>
                  <td class="file-path-cell">${esc(fname)}</td>
                  <td>${f.recordCount}</td>
                  <td class="file-size-cell">${sizeKb}</td>
                  <td>
                    ${isParquet ? `<button class="action-link preview-btn" data-path="${esc(f.path)}">Preview</button>` : '—'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        `;
        content.appendChild(table);
      }
    });
  }
});

