/**
 * Declarations for VS Code Webview API available in browser scripts.
 */
interface VsCodeApi<T = unknown> {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
}

declare function acquireVsCodeApi<T = unknown>(): VsCodeApi<T>;
