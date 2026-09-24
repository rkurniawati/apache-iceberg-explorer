/**
 * Minimal mock of the `vscode` module for use outside the VS Code runtime.
 * Covers APIs referenced by WebviewPanelManager and IcebergTreeProvider.
 */

export const ViewColumn = { One: 1 };

// ---------------------------------------------------------------------------
// TreeItemCollapsibleState
// ---------------------------------------------------------------------------

export const TreeItemCollapsibleState = {
  None:     0,
  Collapsed: 1,
  Expanded:  2,
} as const;

// ---------------------------------------------------------------------------
// TreeItem
// ---------------------------------------------------------------------------

export class TreeItem {
  public iconPath?: unknown;
  public command?: unknown;
  public tooltip?: string;
  public collapsibleState: number;

  constructor(
    public label: string,
    collapsibleState: number = TreeItemCollapsibleState.None,
  ) {
    this.collapsibleState = collapsibleState;
  }
}

// ---------------------------------------------------------------------------
// ThemeColor
// ---------------------------------------------------------------------------

export class ThemeColor {
  constructor(public readonly id: string) {}
}

// ---------------------------------------------------------------------------
// ThemeIcon
// ---------------------------------------------------------------------------

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

export class EventEmitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];

  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { /* no-op */ } };
  };

  fire(data: T): void {
    for (const l of this.listeners) {
      l(data);
    }
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    registeredCommands.set(id, handler);
    return { dispose() { registeredCommands.delete(id); } };
  },
  executeCommand(id: string, ...args: unknown[]) {
    const handler = registeredCommands.get(id);
    return handler ? handler(...args) : undefined;
  },
  _getRegistered() { return registeredCommands; },
};

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

export const window = {
  createWebviewPanel(
    viewType: string,
    title: string,
    _showOptions: unknown,
    _options?: unknown,
  ) {
    const messages: unknown[] = [];
    const messageHandlers: Array<(msg: unknown) => void> = [];
    const disposeListeners: Array<() => void> = [];
    return {
      viewType,
      title,
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        postMessage(msg: unknown) { messages.push(msg); },
        onDidReceiveMessage(handler: (msg: unknown) => void) {
          messageHandlers.push(handler);
          return { dispose() { const idx = messageHandlers.indexOf(handler); if (idx >= 0) messageHandlers.splice(idx, 1); } };
        },
        _receiveMessage(msg: unknown) { messageHandlers.forEach(h => h(msg)); },
        _getMessages() { return messages; },
      },
      reveal(_col: unknown) {},
      onDidDispose(handler: () => void, _ctx: unknown, _subs: unknown) {
        disposeListeners.push(handler);
        return { dispose() {} };
      },
      dispose() { disposeListeners.forEach(h => h()); },
    };
  },

  registerTreeDataProvider(_viewId: string, _provider: unknown) {
    return { dispose() {} };
  },
};

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('node:path') as typeof import('node:path');
    return new Uri(nodePath.join(base.fsPath, ...pathSegments));
  }

  constructor(public readonly fsPath: string) {}
}
