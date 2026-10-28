import * as vscode from 'vscode';

let override: (() => Promise<boolean> | undefined) | undefined;

/** Wires the Test-mode hook (`PanelTestHooks.confirmOverride`); the getter is read on every call. */
export function setConfirmOverride(get: () => (() => Promise<boolean>) | undefined): void {
  override = () => get()?.();
}

/** Single entry point for destructive-action confirmations. */
export async function confirmAction(message: string, detail?: string, button = 'Delete'): Promise<boolean> {
  const hooked = override?.();
  if (hooked) return hooked;
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
}
