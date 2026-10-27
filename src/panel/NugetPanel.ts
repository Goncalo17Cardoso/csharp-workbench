import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ToHost, ToWebview } from './protocol';

/** Thin wrapper over a WebviewPanel; no testable logic lives here. */
export class NugetPanel {
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    title: string,
    onMessage: (m: ToHost) => void,
    onDispose: () => void,
  ) {
    const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel('csharpWorkbench.nuget', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    this.panel.webview.html = this.html(root);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: ToHost) => onMessage(m)),
      this.panel.onDidDispose(() => {
        this.disposables.forEach((d) => d.dispose());
        onDispose();
      }),
    );
  }

  post(m: ToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  reveal(): void { this.panel.reveal(); }

  dispose(): void { this.panel.dispose(); }

  private html(root: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.css'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>NuGet</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
