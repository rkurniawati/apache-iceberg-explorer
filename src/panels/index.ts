/**
 * Webview Panel Manager — public API barrel.
 */
export { WebviewPanelManager } from './webviewPanelManager.js';
export { PanelType, panelRegistryKey } from './types.js';
export { omitAbsent, lastPathSegment, resourcePathToBreadcrumbs } from './utils.js';
export { generateNonce, getMetadataDetailHtml } from './html/metadataDetail.js';
export type { PanelMessage, WebviewMessage } from './messages.js';
