/**
 * Shared helpers for webview HTML generators.
 *
 * Centralises server-side HTML escaping and static breadcrumb rendering.
 * Client-side webview helpers are located in src/webviews/shared.ts.
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
