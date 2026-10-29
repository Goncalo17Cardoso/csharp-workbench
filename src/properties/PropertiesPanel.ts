import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { PropsToHost, PropsToWebview } from './protocol';

export const PROPERTIES_VIEW_TYPE = 'csharpWorkbench.properties';

/** Thin wrapper over a WebviewPanel; no testable logic lives here. */
export class PropertiesPanel {
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    extensionUri: vscode.Uri,
    title: string,
    onMessage: (m: PropsToHost) => void,
    onDispose: () => void,
  ) {
    const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel(PROPERTIES_VIEW_TYPE, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    this.panel.webview.html = this.html(root);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: PropsToHost) => onMessage(m)),
      this.panel.onDidDispose(() => {
        this.disposed = true;
        this.disposables.forEach((d) => d.dispose());
        onDispose();
      }),
    );
  }

  get active(): boolean { return !this.disposed && this.panel.active; }

  post(m: PropsToWebview): void {
    if (this.disposed) return; // late results after the panel was closed
    void this.panel.webview.postMessage(m);
  }

  reveal(): void { this.panel.reveal(); }

  dispose(): void { this.panel.dispose(); }

  private html(root: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'properties.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'properties.css'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Properties</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
