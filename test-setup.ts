/**
 * ts-node register helper.
 *
 * Patches Node's module loader to:
 *  1. Intercept `require('vscode')` and return a minimal stub.
 *  2. Remap `.js` extension imports to `.ts` so that production source files
 *     written for Node16 (which require .js extensions) resolve correctly
 *     when run with ts-node in CommonJS mode.
 *
 * Usage:
 *   npx ts-node -P tsconfig.test.json -r ./test-setup.ts \
 *     src/test/slice-metadata-panel.test.ts
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module') as typeof import('module') & {
  _load(request: string, ...args: unknown[]): unknown;
  _resolveFilename(request: string, ...args: unknown[]): string;
};

const originalResolve = Module._resolveFilename.bind(Module);
const originalLoad    = Module._load.bind(Module);

Module._resolveFilename = function (request: string, ...args: unknown[]): string {
  // Remap .js → .ts so Node16-style imports work in CJS ts-node mode
  if (request.endsWith('.js')) {
    const tsRequest = request.slice(0, -3) + '.ts';
    try {
      return originalResolve(tsRequest, ...args);
    } catch {
      // fall through to the original request
    }
  }
  return originalResolve(request, ...args);
};

Module._load = function (request: string, ...args: unknown[]): unknown {
  if (request === 'vscode') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./src/test/__mocks__/vscode');
  }
  return originalLoad(request, ...args);
};
