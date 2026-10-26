/**
 * Settings Panel Webview Client Script
 *
 * Implements connection form handling, client-side validation,
 * inline S3/GCS warehouse explorer drawer, and bidirectional messaging
 * with the extension host.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  function loadInitialSettingsData(): {
    initialConnections: Array<{ id: string; label: string }>;
    initialActiveConnectionId: string | null;
  } {
    const el = document.getElementById('settings-data');
    if (el?.textContent) {
      try {
        return JSON.parse(el.textContent);
      } catch {
        // fallback to empty
      }
    }
    return { initialConnections: [], initialActiveConnectionId: null };
  }

  const initialData = loadInitialSettingsData();
  let existingConnections: Array<{ id: string; label: string }> =
    Array.isArray(initialData.initialConnections)
      ? initialData.initialConnections.map((c) => ({ id: c.id, label: c.label }))
      : [];
  let activeConnectionId: string | null = initialData.initialActiveConnectionId || null;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const connType     = /** @type {HTMLSelectElement}   */ (document.getElementById('conn-type') as HTMLSelectElement | null);
  const connLabel    = /** @type {HTMLInputElement}    */ (document.getElementById('conn-label') as HTMLInputElement | null);
  const warehousePath= /** @type {HTMLInputElement}    */ (document.getElementById('warehouse-path') as HTMLInputElement | null);
  const pathLabel    = document.getElementById('warehouse-path-label');
  const s3Fields     = document.getElementById('s3-fields');
  const endpointUrl  = /** @type {HTMLInputElement}    */ (document.getElementById('endpoint-url') as HTMLInputElement | null);
  const region       = /** @type {HTMLInputElement}    */ (document.getElementById('region') as HTMLInputElement | null);
  const accessKey    = /** @type {HTMLInputElement}    */ (document.getElementById('access-key') as HTMLInputElement | null);
  const secretKey    = /** @type {HTMLInputElement}    */ (document.getElementById('secret-key') as HTMLInputElement | null);
  const sslVerify    = /** @type {HTMLInputElement}    */ (document.getElementById('ssl-verify') as HTMLInputElement | null);
  const gcsFields    = document.getElementById('gcs-fields');
  const gcsAuthType    = /** @type {HTMLSelectElement}   */ (document.getElementById('gcs-auth-type') as HTMLSelectElement | null);
  const gcsKeyRow      = document.getElementById('gcs-key-row');
  const gcsKeyFile     = /** @type {HTMLInputElement}    */ (document.getElementById('gcs-key-file') as HTMLInputElement | null);
  const gcsKeyJson     = /** @type {HTMLTextAreaElement} */ (document.getElementById('gcs-key-json') as HTMLTextAreaElement | null);
  const keyModeFileBtn = document.getElementById('key-mode-file');
  const keyModePasteBtn= document.getElementById('key-mode-paste');
  const gcsFileContainer = document.getElementById('gcs-file-container');
  const gcsJsonContainer = document.getElementById('gcs-json-container');
  const browseKeyBtn   = document.getElementById('browse-key-btn');
  const formatJsonBtn  = document.getElementById('format-json-btn');
  const gcsJsonStatus  = document.getElementById('gcs-json-status');
  const gcsCredsNote   = document.getElementById('gcs-creds-note');
  const gcsProjectId   = /** @type {HTMLInputElement}    */ (document.getElementById('gcs-project-id') as HTMLInputElement | null);
  const connId         = /** @type {HTMLInputElement}    */ (document.getElementById('conn-id') as HTMLInputElement | null);
  const formHeading    = document.getElementById('form-heading');
  const credsNote      = document.getElementById('creds-note');
  const saveBtn          = document.getElementById('save-btn');
  const connectBtn       = /** @type {HTMLButtonElement} */ (document.getElementById('connect-btn') as HTMLButtonElement | null);
  const clearBtn         = document.getElementById('clear-btn');
  const statusBanner     = document.getElementById('status-banner');
  const statusBannerText = document.getElementById('status-banner-text');
  const statusBannerIcon = document.getElementById('status-banner-icon');
  const bannerConnectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('banner-connect-btn') as HTMLButtonElement | null);
  const browseWarehouseBtn   = document.getElementById('browse-warehouse-btn');
  const detectWarehouseBtn   = document.getElementById('detect-warehouse-btn');
  const pathSuggestion       = document.getElementById('path-suggestion');
  const pathSuggestionValue   = document.getElementById('path-suggestion-value');
  const applySuggestionBtn   = document.getElementById('apply-suggestion-btn');
  const warehouseBrowser     = document.getElementById('warehouse-browser');
  const browserCloseBtn      = document.getElementById('browser-close-btn');
  const browserUpBtn         = /** @type {HTMLButtonElement} */ (document.getElementById('browser-up-btn') as HTMLButtonElement | null);
  const browserRefreshBtn    = document.getElementById('browser-refresh-btn');
  const browserLocalPickerBtn= document.getElementById('browser-local-picker-btn');
  const browserCurrentPath   = document.getElementById('browser-current-path');
  const browserStatus        = document.getElementById('browser-status');
  const browserList          = document.getElementById('browser-list');
  const browserSelectedText  = document.getElementById('browser-selected-text');
  const browserSelectBtn     = /** @type {HTMLButtonElement} */ (document.getElementById('browser-select-btn') as HTMLButtonElement | null);

  let currentBrowsedPath = '';
  let currentParentPath: string | null = null;
  let currentSelectedPath = '';
  let currentSuggestion = '';

  function showSuggestion(path: string) {
    currentSuggestion = path;
    if (pathSuggestionValue) pathSuggestionValue.textContent = path;
    if (pathSuggestion) pathSuggestion.style.display = 'flex';
  }

  function hideSuggestion() {
    currentSuggestion = '';
    if (pathSuggestion) pathSuggestion.style.display = 'none';
    if (pathSuggestionValue) pathSuggestionValue.textContent = '';
  }

  function setBrowserStatus(msg: string, isError: boolean) {
    if (!browserStatus) return;
    if (!msg) {
      browserStatus.style.display = 'none';
      browserStatus.textContent = '';
      browserStatus.className = 'browser-status';
      return;
    }
    browserStatus.textContent = msg;
    browserStatus.className = isError ? 'browser-status error' : 'browser-status';
    browserStatus.style.display = 'block';
  }

  function setSelectedPath(path: string) {
    currentSelectedPath = path;
    if (browserSelectedText) browserSelectedText.textContent = path || 'None';
    if (browserSelectBtn) browserSelectBtn.disabled = !path;
  }

  function escapeHtml(text: string) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function requestBrowse(targetPath?: string) {
    if (!warehouseBrowser || !connType || !warehousePath) return;
    warehouseBrowser.style.display = 'block';
    setBrowserStatus('Loading directory contents...', false);
    if (browserSelectBtn) browserSelectBtn.disabled = true;

    const reqPath = targetPath !== undefined ? targetPath : warehousePath.value.trim();

    vscode.postMessage({
      type: 'browseDirectory',
      id: connId?.value || undefined,
      connectionType: connType.value,
      warehousePath: reqPath,
      dirPath: reqPath,
      endpointUrl: connType.value === 's3' && endpointUrl?.value.trim() ? endpointUrl.value.trim() : undefined,
      region: connType.value === 's3' && region ? region.value.trim() : undefined,
      accessKey: connType.value === 's3' && accessKey ? accessKey.value.trim() : undefined,
      secretKey: connType.value === 's3' && secretKey ? secretKey.value.trim() : (connType.value === 'gcs' ? getEffectiveGcsKey() : undefined),
      sslVerification: connType.value === 's3' && sslVerify ? sslVerify.checked : true,
      gcsAuthType: connType.value === 'gcs' && gcsAuthType ? gcsAuthType.value : undefined,
      projectId: connType.value === 'gcs' && gcsProjectId ? gcsProjectId.value.trim() : undefined,
    });
  }

  function requestDetect(targetPath?: string) {
    if (!connType || !warehousePath) return;
    const p = targetPath || warehousePath.value.trim();
    if (!p) {
      showError('err-path', 'Please enter a bucket or directory path to detect warehouses.');
      return;
    }
    clearErrors();
    hideSuggestion();
    showBanner('Scanning for Iceberg tables...', false);

    vscode.postMessage({
      type: 'detectWarehouse',
      id: connId?.value || undefined,
      connectionType: connType.value,
      warehousePath: p,
      searchPath: p,
      endpointUrl: connType.value === 's3' && endpointUrl?.value.trim() ? endpointUrl.value.trim() : undefined,
      region: connType.value === 's3' && region ? region.value.trim() : undefined,
      accessKey: connType.value === 's3' && accessKey ? accessKey.value.trim() : undefined,
      secretKey: connType.value === 's3' && secretKey ? secretKey.value.trim() : (connType.value === 'gcs' ? getEffectiveGcsKey() : undefined),
      sslVerification: connType.value === 's3' && sslVerify ? sslVerify.checked : true,
      gcsAuthType: connType.value === 'gcs' && gcsAuthType ? gcsAuthType.value : undefined,
      projectId: connType.value === 'gcs' && gcsProjectId ? gcsProjectId.value.trim() : undefined,
    });
  }

  let gcsKeyMode = 'file'; // 'file' | 'paste'

  function setGcsKeyMode(mode: string) {
    gcsKeyMode = mode;
    if (mode === 'file') {
      if (keyModeFileBtn) keyModeFileBtn.classList.add('active');
      if (keyModePasteBtn) keyModePasteBtn.classList.remove('active');
      if (gcsFileContainer) gcsFileContainer.style.display = 'block';
      if (gcsJsonContainer) gcsJsonContainer.style.display = 'none';
    } else {
      if (keyModeFileBtn) keyModeFileBtn.classList.remove('active');
      if (keyModePasteBtn) keyModePasteBtn.classList.add('active');
      if (gcsFileContainer) gcsFileContainer.style.display = 'none';
      if (gcsJsonContainer) gcsJsonContainer.style.display = 'block';
    }
  }

  if (keyModeFileBtn) keyModeFileBtn.addEventListener('click', function() { setGcsKeyMode('file'); });
  if (keyModePasteBtn) keyModePasteBtn.addEventListener('click', function() { setGcsKeyMode('paste'); });

  if (browseKeyBtn) {
    browseKeyBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'browseKeyFile' });
    });
  }

  function getEffectiveGcsKey(): string {
    if (gcsKeyMode === 'paste') {
      return (gcsKeyJson ? gcsKeyJson.value.trim() : '') || (gcsKeyFile ? gcsKeyFile.value.trim() : '');
    }
    return (gcsKeyFile ? gcsKeyFile.value.trim() : '') || (gcsKeyJson ? gcsKeyJson.value.trim() : '');
  }

  function clearGcsKeyError() {
    clearFieldError('err-gcs-key');
    if (gcsKeyFile) {
      gcsKeyFile.classList.remove('invalid');
      gcsKeyFile.removeAttribute('aria-invalid');
    }
    if (gcsKeyJson) {
      gcsKeyJson.classList.remove('invalid');
      gcsKeyJson.removeAttribute('aria-invalid');
    }
  }

  function formatOrValidateJson() {
    if (!gcsKeyJson) return;
    let raw = gcsKeyJson.value.trim();
    if (!raw) {
      if (gcsJsonStatus) gcsJsonStatus.textContent = '';
      return;
    }
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1).trim();
    }
    try {
      const parsed = JSON.parse(raw);
      gcsKeyJson.value = JSON.stringify(parsed, null, 2);
      if (gcsJsonStatus) {
        gcsJsonStatus.textContent = parsed.client_email ? '✓ Service Account: ' + parsed.client_email : '✓ Valid JSON';
        gcsJsonStatus.style.color = 'var(--vscode-charts-green, #4ec9b0)';
      }
      clearGcsKeyError();
    } catch (err: any) {
      try {
        const relaxed = raw.replace(/"private_key"\s*:\s*"([^"]*)"/gs, function(_m, keyVal) {
          return '"private_key": "' + keyVal.replace(/\r?\n/g, '\\n') + '"';
        });
        const parsed2 = JSON.parse(relaxed);
        gcsKeyJson.value = JSON.stringify(parsed2, null, 2);
        if (gcsJsonStatus) {
          gcsJsonStatus.textContent = parsed2.client_email ? '✓ Repaired & formatted for ' + parsed2.client_email : '✓ Valid JSON';
          gcsJsonStatus.style.color = 'var(--vscode-charts-green, #4ec9b0)';
        }
        clearGcsKeyError();
      } catch (err2) {
        if (gcsJsonStatus) {
          gcsJsonStatus.textContent = '⚠ ' + err.message;
          gcsJsonStatus.style.color = 'var(--vscode-errorForeground)';
        }
      }
    }
  }
  if (formatJsonBtn) formatJsonBtn.addEventListener('click', formatOrValidateJson);

  // ── Connection type switch (FR-2, FR-5) ─────────────────────────────────
  function applyGcsAuthType() {
    if (!connType) return;
    const isGcs = connType.value === 'gcs';
    const isKey = isGcs && gcsAuthType && gcsAuthType.value === 'serviceAccountKey';
    if (gcsKeyRow) {
      gcsKeyRow.style.display = isKey ? 'block' : 'none';
    }
    if (gcsKeyFile) {
      gcsKeyFile.disabled = !isKey;
    }
    if (gcsKeyJson) {
      gcsKeyJson.disabled = !isKey;
    }
    if (browseKeyBtn) {
      (browseKeyBtn as HTMLButtonElement).disabled = !isKey;
    }
  }

  function applyType() {
    if (!connType || !warehousePath) return;
    const isS3 = connType.value === 's3';
    const isGcs = connType.value === 'gcs';

    // Update placeholder and label for warehouse path
    if (isS3) {
      warehousePath.placeholder = 's3://bucket/warehouse-path';
      if (pathLabel) pathLabel.textContent = 'Warehouse path (S3 URI)';
    } else if (isGcs) {
      warehousePath.placeholder = 'gs://bucket/warehouse-path';
      if (pathLabel) pathLabel.textContent = 'Warehouse path (GCS URI)';
    } else {
      warehousePath.placeholder = '/absolute/path/to/warehouse';
      if (pathLabel) pathLabel.textContent = 'Warehouse path';
    }

    const pathNote = document.getElementById('warehouse-path-note');
    if (pathNote) {
      if (isS3) {
        pathNote.innerHTML = 'Points to the warehouse root in the bucket. Iceberg Explorer expects schemas and tables directly under this path: <code>s3://warehouse-path/&lt;schema&gt;/&lt;table&gt;/</code> containing <code>metadata/</code> and <code>data/</code> subdirectories.';
        pathNote.style.display = 'block';
      } else if (isGcs) {
        pathNote.innerHTML = 'Points to the warehouse root in the bucket. Iceberg Explorer expects schemas and tables directly under this path: <code>gs://warehouse-path/&lt;schema&gt;/&lt;table&gt;/</code> containing <code>metadata/</code> and <code>data/</code> subdirectories.';
        pathNote.style.display = 'block';
      } else {
        pathNote.style.display = 'none';
      }
    }

    // Toggle S3 fields
    if (s3Fields) {
      s3Fields.style.display = isS3 ? 'block' : 'none';
      const s3Inputs = s3Fields.querySelectorAll('input, select');
      s3Inputs.forEach(function(el) {
        (el as HTMLInputElement | HTMLSelectElement).disabled = !isS3;
      });
    }
    if (credsNote && !isS3) {
      credsNote.style.display = 'none';
    }

    // Toggle GCS fields
    if (gcsFields) {
      gcsFields.style.display = isGcs ? 'block' : 'none';
      const gcsInputs = gcsFields.querySelectorAll('input, select');
      gcsInputs.forEach(function(el) {
        (el as HTMLInputElement | HTMLSelectElement).disabled = !isGcs;
      });
    }
    applyGcsAuthType();
    if (browserLocalPickerBtn) {
      browserLocalPickerBtn.style.display = connType.value === 'local' ? 'inline-block' : 'none';
    }
    if (warehouseBrowser) {
      warehouseBrowser.style.display = 'none';
    }
    hideSuggestion();
  }

  if (connType) {
    connType.addEventListener('change', applyType);
  }
  if (gcsAuthType) {
    gcsAuthType.addEventListener('change', applyGcsAuthType);
  }
  applyType(); // apply on load

  // ── Mode & button helpers ────────────────────────────────────────────────
  function renderHeading(isEdit: boolean, label?: string) {
    if (!formHeading) return;
    if (isEdit) {
      formHeading.textContent = '';
      formHeading.appendChild(document.createTextNode('Edit Connection: '));
      const sub = document.createElement('span');
      sub.style.fontWeight = 'normal';
      sub.style.opacity = '0.85';
      sub.textContent = label || '';
      formHeading.appendChild(sub);
    } else {
      formHeading.textContent = 'New Connection';
    }
  }

  function updateConnectButtonState() {
    if (!connectBtn) return;
    const currentId = connectBtn.dataset.connId || connId?.value;
    if (!currentId || connectBtn.style.display === 'none') {
      return;
    }
    const isOpen = Boolean(activeConnectionId && activeConnectionId === currentId);
    connectBtn.textContent = isOpen ? 'Disconnect' : 'Connect';
    connectBtn.title = isOpen ? 'Disconnect this connection' : 'Connect to this connection';
    connectBtn.disabled = false;

    if (bannerConnectBtn && bannerConnectBtn.dataset.connId === currentId && bannerConnectBtn.style.display !== 'none') {
      bannerConnectBtn.textContent = isOpen ? 'Disconnect' : 'Connect';
      bannerConnectBtn.disabled = false;
    }
  }

  function setEditMode(label?: string, idToConnect?: string) {
    renderHeading(true, label);
    if (saveBtn) saveBtn.textContent = 'Save Changes';
    if (connectBtn) {
      connectBtn.style.display = 'inline-block';
      if (idToConnect) {
        connectBtn.dataset.connId = idToConnect;
      }
      updateConnectButtonState();
    }
    if (clearBtn) {
      clearBtn.textContent = '+ New Connection';
      clearBtn.title = 'Start creating a new connection';
    }
  }

  function setNewConnectionMode() {
    renderHeading(false);
    if (saveBtn) saveBtn.textContent = 'Save Connection';
    if (connectBtn) {
      connectBtn.style.display = 'none';
      delete connectBtn.dataset.connId;
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
    }
    if (clearBtn) {
      clearBtn.textContent = 'Clear';
      clearBtn.title = 'Clear form';
    }
  }

  function resetForm() {
    if (connId) connId.value       = '';
    if (connLabel) connLabel.value    = '';
    if (warehousePath) warehousePath.value= '';
    if (endpointUrl) endpointUrl.value  = '';
    if (region) region.value       = '';
    if (accessKey) accessKey.value    = '';
    if (secretKey) secretKey.value    = '';
    if (sslVerify) sslVerify.checked  = true;
    if (gcsAuthType) gcsAuthType.value = 'adc';
    if (gcsKeyFile) gcsKeyFile.value = '';
    if (gcsKeyJson) gcsKeyJson.value = '';
    if (gcsJsonStatus) gcsJsonStatus.textContent = '';
    setGcsKeyMode('file');
    if (gcsProjectId) gcsProjectId.value = '';
    if (gcsCredsNote) gcsCredsNote.style.display = 'none';
    if (credsNote) {
      credsNote.textContent = '';
      credsNote.style.display = 'none';
    }
    setNewConnectionMode();
    applyGcsAuthType();
    clearErrors();
    hideBanner();
    hideSuggestion();
    if (warehouseBrowser) {
      warehouseBrowser.style.display = 'none';
    }
  }

  // ── Connect & Clear buttons ──────────────────────────────────────────────
  if (connectBtn) {
    connectBtn.addEventListener('click', function () {
      const idToAct = connectBtn.dataset.connId || connId?.value;
      if (idToAct) {
        const isOpen = Boolean(activeConnectionId && activeConnectionId === idToAct);
        connectBtn.disabled = true;
        if (isOpen) {
          connectBtn.textContent = 'Disconnecting...';
          vscode.postMessage({
            type: 'disconnectConnection',
            id: idToAct,
          });
        } else {
          connectBtn.textContent = 'Connecting...';
          vscode.postMessage({
            type: 'activateConnection',
            id: idToAct,
          });
        }
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      resetForm();
      if (connLabel) connLabel.focus();
    });
  }

  if (browseWarehouseBtn) {
    browseWarehouseBtn.addEventListener('click', function() {
      if (!connType || !warehousePath) return;
      const isS3 = connType.value === 's3';
      const isGcs = connType.value === 'gcs';
      const currentVal = warehousePath.value.trim();

      if (isS3 && (!currentVal || !new RegExp('^s3[an]?://[^/]+', 'i').test(currentVal))) {
        showError('err-path', 'Please enter at least an S3 bucket (e.g. s3://my-bucket) to browse.');
        warehousePath.focus();
        return;
      }
      if (isGcs && (!currentVal || !new RegExp('^(?:gs|gcs)://[^/]+', 'i').test(currentVal))) {
        showError('err-path', 'Please enter at least a GCS bucket (e.g. gs://my-bucket) to browse.');
        warehousePath.focus();
        return;
      }

      clearErrors();
      requestBrowse(currentVal);
    });
  }

  if (detectWarehouseBtn) {
    detectWarehouseBtn.addEventListener('click', function() {
      if (warehousePath) {
        requestDetect(warehousePath.value.trim());
      }
    });
  }

  if (applySuggestionBtn) {
    applySuggestionBtn.addEventListener('click', function() {
      if (currentSuggestion && warehousePath) {
        warehousePath.value = currentSuggestion;
        hideSuggestion();
        clearErrors();
        hideBanner();
      }
    });
  }

  if (browserCloseBtn) {
    browserCloseBtn.addEventListener('click', function() {
      if (warehouseBrowser) warehouseBrowser.style.display = 'none';
    });
  }

  if (browserUpBtn) {
    browserUpBtn.addEventListener('click', function() {
      if (currentParentPath) {
        requestBrowse(currentParentPath);
      }
    });
  }

  if (browserRefreshBtn) {
    browserRefreshBtn.addEventListener('click', function() {
      if (warehousePath) {
        requestBrowse(currentBrowsedPath || warehousePath.value.trim());
      }
    });
  }

  if (browserLocalPickerBtn) {
    browserLocalPickerBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'browseWarehouseFolderDialog' });
    });
  }

  if (browserSelectBtn) {
    browserSelectBtn.addEventListener('click', function() {
      if (currentSelectedPath && warehousePath) {
        warehousePath.value = currentSelectedPath;
        if (warehouseBrowser) warehouseBrowser.style.display = 'none';
        clearErrors();
        hideSuggestion();
      }
    });
  }

  // ── Validation helpers ────────────────────────────────────────────────────
  function getInputElementForError(id: string): HTMLElement | null {
    switch (id) {
      case 'err-label': return connLabel;
      case 'err-endpoint': return endpointUrl;
      case 'err-region': return region;
      case 'err-access-key': return accessKey;
      case 'err-secret-key': return secretKey;
      case 'err-gcs-key':
        return (typeof gcsKeyMode !== 'undefined' && gcsKeyMode === 'paste') ? gcsKeyJson : gcsKeyFile;
      case 'err-gcs-project': return gcsProjectId;
      case 'err-path': return warehousePath;
      default: return null;
    }
  }

  function showError(id: string, msg: string) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = msg;
      el.classList.add('visible');
    }
    const input = getInputElementForError(id);
    if (input) {
      input.classList.add('invalid');
      if (typeof input.setAttribute === 'function') input.setAttribute('aria-invalid', 'true');
    }
  }

  function clearFieldError(id: string) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '';
      el.classList.remove('visible');
    }
    const input = getInputElementForError(id);
    if (input) {
      input.classList.remove('invalid');
      if (typeof input.removeAttribute === 'function') input.removeAttribute('aria-invalid');
    }
  }

  function clearErrors() {
    document.querySelectorAll('.field-error').forEach(function(el) {
      el.textContent = '';
      el.classList.remove('visible');
    });
    document.querySelectorAll('.invalid').forEach(function(el) {
      el.classList.remove('invalid');
      if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-invalid');
    });
  }

  function focusFirstError() {
    let firstInvalid: HTMLElement | null = null;
    if (typeof document.querySelector === 'function') {
      firstInvalid = document.querySelector('.invalid') as HTMLElement | null;
    } else if (typeof document.querySelectorAll === 'function') {
      const all = document.querySelectorAll('.invalid');
      if (all && all.length > 0) firstInvalid = all[0] as HTMLElement;
    }
    if (firstInvalid) {
      if (typeof firstInvalid.scrollIntoView === 'function') {
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (typeof firstInvalid.focus === 'function') {
        firstInvalid.focus();
      }
    }
  }

  function showBanner(msg: string, isError: boolean, connectId?: string) {
    if (statusBannerIcon) {
      statusBannerIcon.textContent = isError ? '⚠️' : '✓';
      statusBannerIcon.style.display = 'inline-block';
    }
    if (statusBannerText) {
      statusBannerText.textContent = msg;
    } else if (statusBanner) {
      statusBanner.textContent = msg;
    }
    if (statusBanner) {
      statusBanner.className = isError ? 'error' : 'success';
      if (typeof statusBanner.setAttribute === 'function') {
        statusBanner.setAttribute('role', isError ? 'alert' : 'status');
      }
    }
    if (bannerConnectBtn) {
      if (!isError && connectId) {
        bannerConnectBtn.dataset.connId = connectId;
        bannerConnectBtn.style.display = 'inline-block';
        bannerConnectBtn.disabled = false;
        const isOpen = Boolean(activeConnectionId && activeConnectionId === connectId);
        bannerConnectBtn.textContent = isOpen ? 'Disconnect' : 'Connect';
      } else {
        bannerConnectBtn.style.display = 'none';
        delete bannerConnectBtn.dataset.connId;
      }
    }
    if (statusBanner) {
      statusBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function hideBanner() {
    if (statusBanner) {
      statusBanner.className = '';
      if (typeof statusBanner.removeAttribute === 'function') {
        statusBanner.removeAttribute('role');
      }
    }
    if (statusBannerIcon) {
      statusBannerIcon.textContent = '';
      statusBannerIcon.style.display = 'none';
    }
    if (statusBannerText) statusBannerText.textContent = '';
    if (bannerConnectBtn) {
      bannerConnectBtn.style.display = 'none';
      delete bannerConnectBtn.dataset.connId;
    }
  }

  if (bannerConnectBtn) {
    bannerConnectBtn.addEventListener('click', function () {
      const idToAct = bannerConnectBtn.dataset.connId;
      if (idToAct) {
        const isOpen = Boolean(activeConnectionId && activeConnectionId === idToAct);
        bannerConnectBtn.disabled = true;
        if (isOpen) {
          bannerConnectBtn.textContent = 'Disconnecting...';
          vscode.postMessage({
            type: 'disconnectConnection',
            id: idToAct,
          });
        } else {
          bannerConnectBtn.textContent = 'Connecting...';
          vscode.postMessage({
            type: 'activateConnection',
            id: idToAct,
          });
        }
      }
    });
  }

  // ── Save Connection ────────────────────────────────────────────────────────
  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      if (!connType || !connLabel || !warehousePath) return;
      clearErrors();
      hideBanner();

      const isS3  = connType.value === 's3';
      const isGcs = connType.value === 'gcs';
      const label = connLabel.value.trim();
      const path  = warehousePath.value.trim();
      let valid = true;

      if (!label) {
        showError('err-label', 'Connection name is required.');
        valid = false;
      } else {
        const currentId = connId?.value || '';
        const isDuplicate = existingConnections.some(function(c) {
          return c.id !== currentId && c.label.trim().toLowerCase() === label.toLowerCase();
        });
        if (isDuplicate) {
          showError('err-label', 'A connection with the name "' + label + '" already exists.');
          valid = false;
        }
      }
      if (!path) {
        showError('err-path', isS3 ? 'Warehouse path (S3 URI) is required.' : isGcs ? 'Warehouse path (GCS URI) is required.' : 'Warehouse path is required.');
        valid = false;
      } else if (!isS3 && !isGcs && !(path.startsWith('/') || (path.length >= 3 && /^[a-zA-Z]$/.test(path[0]) && path[1] === ':' && (path[2] === '/' || path[2] === '\\')) || path.startsWith('\\\\'))) {
        showError('err-path', 'Warehouse path must be an absolute path (starting with / or a drive letter like C:\\).');
        valid = false;
      } else if (isS3 && !new RegExp('^s3[an]?://[^/]+', 'i').test(path)) {
        showError('err-path', 'Warehouse path must be a valid S3 URI (e.g. s3://bucket/warehouse-path).');
        valid = false;
      } else if (isGcs && !new RegExp('^(?:gs|gcs)://[^/]+', 'i').test(path)) {
        showError('err-path', 'Warehouse path must be a valid GCS URI (e.g. gs://bucket/warehouse-path).');
        valid = false;
      }

      if (isS3) {
        const ep = endpointUrl ? endpointUrl.value.trim() : '';
        if (ep) {
          try {
            const parsedUrl = new URL(ep);
            if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
              showError('err-endpoint', 'Endpoint URL must use https or http scheme.');
              valid = false;
            }
          } catch (e) {
            showError('err-endpoint', 'Endpoint URL is not a valid URL.');
            valid = false;
          }
        }
        if (!region || !region.value.trim()) {
          showError('err-region', 'Region is required for S3 connections.');
          valid = false;
        }
        if (!accessKey || !accessKey.value.trim()) {
          showError('err-access-key', 'Access key is required for S3 connections.');
          valid = false;
        }
        if (!secretKey || !secretKey.value.trim()) {
          showError('err-secret-key', 'Secret key is required for S3 connections.');
          valid = false;
        }
      }

      if (isGcs) {
        if (gcsAuthType && gcsAuthType.value === 'serviceAccountKey') {
          const keyVal = getEffectiveGcsKey();
          if (!keyVal) {
            showError('err-gcs-key', 'Service account key JSON or file path is required.');
            valid = false;
          }
        }
      }

      if (!valid) {
        showBanner('Please correct the highlighted errors before saving.', true);
        focusFirstError();
        return;
      }

      const gcsSecret = isGcs && gcsAuthType && gcsAuthType.value === 'serviceAccountKey' ? getEffectiveGcsKey() : undefined;

      // Send to extension host — credentials travel only in this message and are
      // immediately stored in SecretStorage by ConnectionManager (FR-3, NFR-7).
      vscode.postMessage({
        type: 'saveConnection',
        id:              connId?.value || undefined,
        connectionType:  connType.value,
        label:           label,
        warehousePath:   path,
        endpointUrl:     isS3 && endpointUrl?.value.trim() ? endpointUrl.value.trim() : undefined,
        region:          isS3 && region ? region.value.trim() : undefined,
        accessKey:       isS3 && accessKey ? accessKey.value.trim() : undefined,
        secretKey:       isS3 && secretKey ? secretKey.value.trim() : gcsSecret,
        sslVerification: isS3 && sslVerify ? sslVerify.checked : true,
        gcsAuthType:     isGcs && gcsAuthType ? gcsAuthType.value : undefined,
        projectId:       isGcs && gcsProjectId && gcsProjectId.value.trim() ? gcsProjectId.value.trim() : undefined,
      });

      // Note: Credential fields are kept until saveSuccess to prevent losing input on errors.
    });
  }

  const MASK_VALUE = '••••••••';
  function handleMaskFocus(el: HTMLInputElement) {
    if (el.value === MASK_VALUE || el.value === '********') {
      el.select();
    }
  }
  if (accessKey) accessKey.addEventListener('focus', function () { handleMaskFocus(accessKey); });
  if (secretKey) secretKey.addEventListener('focus', function () { handleMaskFocus(secretKey); });
  if (gcsKeyFile) {
    gcsKeyFile.addEventListener('focus', function () { handleMaskFocus(gcsKeyFile); });
    gcsKeyFile.addEventListener('input', function () {
      const val = gcsKeyFile.value.trim();
      if (val.startsWith('{')) {
        if (gcsKeyJson) gcsKeyJson.value = gcsKeyFile.value;
        gcsKeyFile.value = '';
        setGcsKeyMode('paste');
        formatOrValidateJson();
      }
      clearGcsKeyError();
    });
  }
  if (gcsKeyJson) {
    gcsKeyJson.addEventListener('input', function () {
      const val = gcsKeyJson.value.trim();
      if ((val.startsWith('/') || val.startsWith('~/')) && !val.includes('\n')) {
        if (gcsKeyFile) gcsKeyFile.value = val;
        gcsKeyJson.value = '';
        setGcsKeyMode('file');
      }
      clearGcsKeyError();
    });
  }
  if (gcsProjectId) {
    gcsProjectId.addEventListener('input', function () {
      clearFieldError('err-gcs-project');
    });
  }

  // Clear field errors when the user types
  if (connLabel) {
    connLabel.addEventListener('input', function () {
      clearFieldError('err-label');
      if (connId?.value) {
        renderHeading(true, connLabel.value.trim() || 'Untitled');
      }
    });
  }
  if (warehousePath) {
    warehousePath.addEventListener('input', function () {
      clearFieldError('err-path');
    });
  }
  if (endpointUrl) {
    endpointUrl.addEventListener('input', function () {
      clearFieldError('err-endpoint');
    });
  }
  if (region) {
    region.addEventListener('input', function () {
      clearFieldError('err-region');
    });
  }
  if (accessKey) {
    accessKey.addEventListener('input', function () {
      clearFieldError('err-access-key');
    });
  }
  if (secretKey) {
    secretKey.addEventListener('input', function () {
      clearFieldError('err-secret-key');
    });
  }

  // ── Messages from extension host ─────────────────────────────────────────
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || !msg.type || !connType) return;

    switch (msg.type) {
      case 'setActiveConnectionId':
      case 'activeConnectionChanged':
        activeConnectionId = msg.id || null;
        updateConnectButtonState();
        break;
      case 'newConnection':
        if (msg.activeConnectionId !== undefined) {
          activeConnectionId = msg.activeConnectionId;
        }
        resetForm();
        if (connLabel) connLabel.focus();
        break;
      case 'setExistingConnections':
        if (Array.isArray(msg.connections)) {
          existingConnections = msg.connections;
        }
        break;
      case 'keyFileSelected':
        if (gcsKeyFile && msg.filePath) {
          gcsKeyFile.value = msg.filePath;
          setGcsKeyMode('file');
          clearGcsKeyError();
        }
        break;
      case 'saveSuccess':
        hideBanner();
        if (msg.activeConnectionId !== undefined) {
          activeConnectionId = msg.activeConnectionId;
        }
        if (connId) connId.value = msg.connectionId;
        setEditMode(connLabel?.value.trim(), msg.connectionId);
        if (Array.isArray(msg.connections)) {
          existingConnections = msg.connections;
        }
        if (connType.value === 's3') {
          if (accessKey) accessKey.value = MASK_VALUE;
          if (secretKey) secretKey.value = MASK_VALUE;
          if (credsNote) {
            credsNote.textContent = 'Existing credentials are saved. Enter new values only to update credentials.';
            credsNote.style.display = 'block';
          }
          if (gcsCredsNote) gcsCredsNote.style.display = 'none';
        } else if (connType.value === 'gcs') {
          if (gcsAuthType && gcsAuthType.value === 'serviceAccountKey') {
            if (gcsKeyFile) gcsKeyFile.value = MASK_VALUE;
            if (gcsKeyJson) gcsKeyJson.value = '';
            setGcsKeyMode('file');
            if (gcsCredsNote) {
              gcsCredsNote.textContent = 'Existing service account key is saved. Enter a new value only to update credentials.';
              gcsCredsNote.style.display = 'block';
            }
          }
        }
        break;
      case 'saveError':
        showBanner(msg.message || 'Failed to save connection.', true);
        if (connId?.value && connType.value === 's3' && accessKey && secretKey && !accessKey.value && !secretKey.value) {
          accessKey.value = MASK_VALUE;
          secretKey.value = MASK_VALUE;
        }
        if (msg.suggestedWarehousePath) {
          showSuggestion(msg.suggestedWarehousePath);
        }
        if (msg.message && (msg.message.includes('label:') || msg.message.toLowerCase().includes('already exists'))) {
          let labelMsg = msg.message;
          if (labelMsg.includes('label:')) {
            labelMsg = labelMsg.split('label:')[1].trim();
          } else if (labelMsg.startsWith('Validation failed:')) {
            labelMsg = labelMsg.replace('Validation failed:', '').trim();
          }
          showError('err-label', labelMsg);
        }
        if (msg.message && (msg.message.includes('warehousePath:') || msg.message.toLowerCase().includes('warehouse path'))) {
          let pathMsg = msg.message;
          if (pathMsg.includes('warehousePath:')) {
            pathMsg = pathMsg.split('warehousePath:')[1].trim();
          } else if (pathMsg.startsWith('Validation failed:')) {
            pathMsg = pathMsg.replace('Validation failed:', '').trim();
          }
          showError('err-path', pathMsg);
        }
        if (msg.message && (msg.message.toLowerCase().includes('service account') || msg.message.toLowerCase().includes('key file') || msg.message.toLowerCase().includes('json') || msg.message.includes('secretKey:'))) {
          showError('err-gcs-key', msg.message);
        }
        focusFirstError();
        break;

      case 'browseDirectoryResult':
        if (msg.error) {
          setBrowserStatus(msg.error, true);
          if (browserList) {
            browserList.innerHTML = '<div class="browser-list-empty">' + escapeHtml(msg.error) + '</div>';
          }
        } else {
          setBrowserStatus('', false);
          currentBrowsedPath = msg.currentPath || '';
          currentParentPath = msg.parentPath || null;
          if (browserCurrentPath) {
            browserCurrentPath.textContent = currentBrowsedPath;
            browserCurrentPath.title = currentBrowsedPath;
          }
          if (browserUpBtn) {
            browserUpBtn.disabled = !currentParentPath;
          }
          setSelectedPath(currentBrowsedPath);

          if (browserList) {
            browserList.innerHTML = '';
            const items = Array.isArray(msg.items) ? msg.items : [];
            if (items.length === 0) {
              browserList.innerHTML = '<div class="browser-list-empty">No subdirectories found in this path.</div>';
            } else {
              items.forEach(function(item: any) {
                const row = document.createElement('div');
                row.className = 'browser-item';

                const left = document.createElement('div');
                left.className = 'browser-item-left';

                const icon = document.createElement('span');
                icon.className = 'browser-item-icon';
                icon.textContent = item.isTable ? '🧊' : (item.isSchema ? '🗄️' : '📁');
                left.appendChild(icon);

                const name = document.createElement('span');
                name.className = 'browser-item-name';
                name.textContent = item.name + '/';
                left.appendChild(name);

                row.appendChild(left);

                const right = document.createElement('div');
                right.className = 'browser-item-right';

                if (item.isTable) {
                  const badge = document.createElement('span');
                  badge.className = 'browser-item-badge browser-badge-table';
                  badge.textContent = 'Table';
                  right.appendChild(badge);
                } else if (item.isSchema) {
                  const badge2 = document.createElement('span');
                  badge2.className = 'browser-item-badge browser-badge-schema';
                  badge2.textContent = 'Schema';
                  right.appendChild(badge2);
                }

                const drillBtn = document.createElement('button');
                drillBtn.type = 'button';
                drillBtn.className = 'secondary browser-drill-btn';
                drillBtn.textContent = 'Open →';
                drillBtn.title = 'Explore inside ' + item.name;
                drillBtn.addEventListener('click', function(e) {
                  e.stopPropagation();
                  requestBrowse(item.path);
                });
                right.appendChild(drillBtn);

                row.appendChild(right);

                row.addEventListener('click', function() {
                  document.querySelectorAll('.browser-item').forEach(function(el) {
                    el.classList.remove('selected');
                  });
                  row.classList.add('selected');
                  setSelectedPath(item.path);
                });

                row.addEventListener('dblclick', function() {
                  requestBrowse(item.path);
                });

                browserList.appendChild(row);
              });
            }
          }
        }
        break;

      case 'detectWarehouseResult':
        if (msg.error) {
          showBanner(msg.error, true);
        } else if (Array.isArray(msg.suggestedPaths) && msg.suggestedPaths.length > 0) {
          showSuggestion(msg.suggestedPaths[0]);
          showBanner('Detected Iceberg warehouse: ' + msg.suggestedPaths[0], false);
        } else {
          showBanner('No Iceberg tables detected under this path. Use Browse to navigate.', true);
        }
        break;

      case 'warehousePathSelected':
        if (warehousePath && msg.path) {
          warehousePath.value = msg.path;
          clearErrors();
          hideSuggestion();
          if (warehouseBrowser) warehouseBrowser.style.display = 'none';
        }
        break;
      case 'activateSuccess':
        activeConnectionId = msg.id || connectBtn?.dataset.connId || connId?.value || null;
        updateConnectButtonState();
        showBanner('Connection activated.', false);
        break;
      case 'activateError':
        updateConnectButtonState();
        showBanner(msg.message || 'Could not activate connection.', true);
        break;
      case 'disconnectSuccess':
        if (!msg.id || activeConnectionId === msg.id) {
          activeConnectionId = null;
        }
        updateConnectButtonState();
        showBanner('Connection disconnected.', false);
        break;
      case 'disconnectError':
        updateConnectButtonState();
        showBanner(msg.message || 'Could not disconnect connection.', true);
        break;
      case 'deleteSuccess':
        showBanner('Connection deleted.', false);
        if (msg.id) {
          existingConnections = existingConnections.filter(function(c) { return c.id !== msg.id; });
          if (activeConnectionId === msg.id) {
            activeConnectionId = null;
            updateConnectButtonState();
          }
        }
        break;
      case 'deleteError':
        showBanner(msg.message || 'Could not delete connection.', true);
        break;
      case 'editConnection':
        if (msg.activeConnectionId !== undefined) {
          activeConnectionId = msg.activeConnectionId;
        } else if (msg.isActive === true) {
          activeConnectionId = msg.config.id;
        } else if (msg.isActive === false && activeConnectionId === msg.config.id) {
          activeConnectionId = null;
        }
        // Pre-fill form fields from msg.config
        connType.value         = msg.config.connectionType;
        if (connLabel) connLabel.value        = msg.config.label;
        if (warehousePath) warehousePath.value    = msg.config.warehousePath;
        if (endpointUrl) endpointUrl.value      = msg.config.endpointUrl || '';
        if (region) region.value           = msg.config.region || '';
        if (connId) connId.value           = msg.config.id;
        if (sslVerify && msg.config.sslVerification !== undefined) {
          sslVerify.checked    = msg.config.sslVerification !== false;
        }
        setEditMode(msg.config.label, msg.config.id);
        if (msg.config.connectionType === 's3' && msg.hasSavedCredentials) {
          if (accessKey) accessKey.value = MASK_VALUE;
          if (secretKey) secretKey.value = MASK_VALUE;
          if (credsNote) {
            credsNote.textContent = 'Existing credentials are saved. Enter new values only to update credentials.';
            credsNote.style.display = 'block';
          }
          if (gcsKeyFile) gcsKeyFile.value = '';
          if (gcsKeyJson) gcsKeyJson.value = '';
          if (gcsCredsNote) gcsCredsNote.style.display = 'none';
        } else if (msg.config.connectionType === 'gcs') {
          if (accessKey) accessKey.value = '';
          if (secretKey) secretKey.value = '';
          if (credsNote) credsNote.style.display = 'none';
          if (gcsAuthType) {
            gcsAuthType.value = msg.config.gcsAuthType || 'adc';
          }
          if (gcsProjectId) {
            gcsProjectId.value = msg.config.projectId || '';
          }
          if (msg.config.gcsAuthType === 'serviceAccountKey' && msg.hasSavedCredentials) {
            if (gcsKeyFile) gcsKeyFile.value = MASK_VALUE;
            if (gcsKeyJson) gcsKeyJson.value = '';
            setGcsKeyMode('file');
            if (gcsCredsNote) {
              gcsCredsNote.textContent = 'Existing service account key is saved. Enter a new value only to update credentials.';
              gcsCredsNote.style.display = 'block';
            }
          } else {
            if (gcsKeyFile) gcsKeyFile.value = '';
            if (gcsKeyJson) gcsKeyJson.value = '';
            if (gcsCredsNote) gcsCredsNote.style.display = 'none';
          }
        } else {
          if (accessKey) accessKey.value = '';
          if (secretKey) secretKey.value = '';
          if (credsNote) {
            credsNote.textContent = '';
            credsNote.style.display = 'none';
          }
          if (gcsKeyFile) gcsKeyFile.value = '';
          if (gcsKeyJson) gcsKeyJson.value = '';
          if (gcsCredsNote) gcsCredsNote.style.display = 'none';
        }
        applyType();
        break;
    }
  });

}());
