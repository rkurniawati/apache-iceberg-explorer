/**
 * Utility helpers shared across panel renderers.
 * (T-26, design.md §2.2, A-8)
 */

/**
 * Returns the value unchanged when it is defined and non-null;
 * returns null for undefined and null inputs.
 *
 * Section renderers call this before rendering a field so that absent keys in
 * an Iceberg metadata payload are silently omitted rather than shown as errors.
 * No section renderer may gate field rendering on the integer value of
 * `format-version` — fields are rendered if and only if their key is present.
 * (A-8, FR-10h)
 */
export function omitAbsent<T>(value: T | undefined | null): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value;
}

/**
 * Return the final path segment of a resource path (S3 URI or local path).
 * Used for the panel tab title and the last breadcrumb segment.
 */
export function lastPathSegment(resourcePath: string): string {
  const normalised = resourcePath.replace(/\\/g, '/').replace(/\/$/, '');
  const idx = normalised.lastIndexOf('/');
  return idx >= 0 ? normalised.slice(idx + 1) : normalised;
}

/**
 * Decompose a resource path into breadcrumb segments suitable for display.
 *
 * S3:    s3://bucket/prefix/schema/table/metadata/v3.metadata.json
 *        → ['bucket/prefix', 'schema', 'table', 'v3.metadata.json']
 *
 * Local: /warehouse/schema/table/metadata/v3.metadata.json
 *        → ['/warehouse', 'schema', 'table', 'v3.metadata.json']
 *
 * Convention: the segment immediately before "metadata" is the table name,
 * the one before that is the schema. Everything above that is the root.
 * (FR-18, T-27)
 */
export function resourcePathToBreadcrumbs(resourcePath: string): string[] {
  // Normalise Hadoop-style s3a:// / s3n:// to s3:// so breadcrumb logic is uniform.
  const normalised = resourcePath.replace(/\\/g, '/').replace(/^s3[an]:\/\//, 's3://');
  let parts: string[];

  if (normalised.startsWith('s3://')) {
    const withoutScheme = normalised.slice('s3://'.length);
    parts = withoutScheme.split('/').filter(Boolean);
    const metaIdx = parts.lastIndexOf('metadata');
    if (metaIdx >= 3) {
      const root = parts.slice(0, metaIdx - 2).join('/');
      const schema = parts[metaIdx - 2];
      const table = parts[metaIdx - 1];
      const file = parts[parts.length - 1];
      return [root, schema!, table!, file!];
    }
    const tail = parts.slice(-4);
    if (tail.length === 4) { return tail; }
    return parts;
  }

  // Local path
  parts = normalised.split('/').filter(Boolean);
  const metaIdx = parts.lastIndexOf('metadata');
  if (metaIdx >= 2) {
    const root = '/' + parts.slice(0, metaIdx - 2).join('/');
    const schema = parts[metaIdx - 2];
    const table = parts[metaIdx - 1];
    const file = parts[parts.length - 1];
    return [root, schema!, table!, file!];
  }
  const tail = parts.slice(-4);
  const rootParts = parts.slice(0, parts.length - tail.length);
  const root = rootParts.length > 0 ? '/' + rootParts.join('/') : '/';
  return tail.length >= 2 ? [root, ...tail.slice(-3)] : [root, ...tail];
}
