/** Shell-level helpers: tab counters, busy overlay and banners. */

export function setTabCount(tab: HTMLElement, n: number): void {
  const label = tab.dataset.label ?? tab.textContent ?? '';
  tab.dataset.label = label;
  tab.textContent = n > 0 ? `${label} (${n})` : label;
}

/**
 * Action buttons carry the `primary` class (Install/Update/Uninstall/Consolidate/Update selected).
 * While busy, `root` is marked `data-busy` and every action is disabled. When busy ends, each button
 * goes back to its own view rule (`data-blocked`, set through `setOwnDisabled`).
 */
export function setActionsDisabled(root: HTMLElement, disabled: boolean): void {
  if (disabled) root.dataset.busy = 'true';
  else delete root.dataset.busy;
  root.querySelectorAll<HTMLButtonElement>('button.primary').forEach((b) => {
    b.disabled = disabled || b.dataset.blocked === 'true';
  });
}

/** Applies a view's own rule (e.g. nothing selected) without re-enabling a button while busy. */
export function setOwnDisabled(btn: HTMLButtonElement, blocked: boolean): void {
  btn.dataset.blocked = String(blocked);
  btn.disabled = blocked || btn.closest('[data-busy="true"]') !== null;
}

export function applyBusy(
  root: HTMLElement,
  status: HTMLElement,
  label: string | null,
  progress?: { done: number; total: number },
): void {
  status.className = 'status';
  if (label === null) {
    status.textContent = '';
    setActionsDisabled(root, false);
    return;
  }
  status.textContent = progress ? `${label} (${progress.done}/${progress.total})` : label;
  setActionsDisabled(root, true);
}

export function showError(
  root: HTMLElement,
  status: HTMLElement,
  message: string,
  canOpenOutput: boolean,
  openOutput: () => void,
): void {
  setActionsDisabled(root, false);
  status.className = 'status status-error';
  status.textContent = message;
  if (canOpenOutput) {
    const b = document.createElement('button');
    b.textContent = 'Show output';
    b.addEventListener('click', openOutput);
    status.append(' ', b);
  }
}

export function showInfo(root: HTMLElement, status: HTMLElement, message: string): void {
  setActionsDisabled(root, false);
  status.className = 'status status-info';
  status.textContent = message;
}

export function showResult(
  root: HTMLElement,
  status: HTMLElement,
  ok: boolean,
  message: string,
  openOutput: () => void,
  cancelled = false,
): void {
  if (cancelled) {
    showInfo(root, status, message);
    return;
  }
  if (!ok) {
    showError(root, status, message, true, openOutput);
    return;
  }
  status.className = 'status status-ok';
  status.textContent = message;
}
