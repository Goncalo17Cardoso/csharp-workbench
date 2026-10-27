// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { renderInstalled } from '../../../src/webview/views/installed';
import { renderUpdates, UpdateSequence } from '../../../src/webview/views/updates';
import { renderConsolidate } from '../../../src/webview/views/consolidate';
import { applyBusy, setTabCount, showError } from '../../../src/webview/chrome';

describe('tabs', () => {
  it('installed filter is case-insensitive', () => {
    const el = document.createElement('div');
    const rows = [
      { id: 'Serilog', versions: { a: '4.0.0' }, overrides: [] },
      { id: 'Newtonsoft.Json', versions: { a: '13.0.1' }, central: '13.0.1', overrides: [] },
    ];
    renderInstalled(el, rows, 'SERI', () => {}, true);
    expect(el.querySelectorAll('.row')).toHaveLength(1);
    renderInstalled(el, rows, '', () => {}, true);
    expect(el.textContent).toContain('(central)');
    renderInstalled(el, rows, '', () => {}, false);
    expect(el.textContent).toContain('confirming…');
  });

  it('update selected sends one run per selected package, in sequence', () => {
    const el = document.createElement('div');
    const send = vi.fn();
    const rows = [
      { id: 'A', current: ['1.0.0'], latest: '2.0.0', projects: ['p1'] },
      { id: 'B', current: ['1.0.0'], latest: '3.0.0', projects: ['p1', 'p2'] },
      { id: 'C', current: ['1.0.0'], latest: '4.0.0', projects: ['p2'] },
    ];
    const seq = new UpdateSequence(send);
    renderUpdates(el, rows, '', seq);
    const boxes = el.querySelectorAll<HTMLInputElement>('input.sel-row');
    boxes[0].click();
    boxes[1].click();
    const btn = el.querySelector<HTMLButtonElement>('button.update-selected')!;
    expect(btn.textContent).toBe('Update selected (2)');
    btn.click();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ type: 'run', request: { kind: 'update', packageId: 'A', version: '2.0.0', projects: ['p1'] } });
    seq.onResult(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: 'run', request: { kind: 'update', packageId: 'B', version: '3.0.0', projects: ['p1', 'p2'] } });
    seq.onResult(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('update sequence stops on failure', () => {
    const send = vi.fn();
    const seq = new UpdateSequence(send);
    seq.start([
      { id: 'A', current: [], latest: '2', projects: ['p'] },
      { id: 'B', current: [], latest: '2', projects: ['p'] },
    ]);
    seq.onResult(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tab counters reflect row counts', () => {
    const mk = (t: string) => { const b = document.createElement('button'); b.textContent = t; b.dataset.label = t; return b; };
    const tabs = { updates: mk('Updates'), consolidate: mk('Consolidate') };
    setTabCount(tabs.updates, 3);
    expect(tabs.updates.textContent).toBe('Updates (3)');
    setTabCount(tabs.updates, 0);
    expect(tabs.updates.textContent).toBe('Updates');
    setTabCount(tabs.consolidate, 2);
    expect(tabs.consolidate.textContent).toBe('Consolidate (2)');
  });

  it('consolidate under cpm shows override note', () => {
    const el = document.createElement('div');
    const send = vi.fn();
    const rows = [{ id: 'X', versions: { p1: '1.0.0', p2: '2.0.0' }, target: '2.0.0' }];
    renderConsolidate(el, rows, true, send);
    expect(el.textContent).toContain('Removes VersionOverride from these projects');
    const sel = el.querySelector<HTMLSelectElement>('select')!;
    expect(sel.value).toBe('2.0.0');
    el.querySelector<HTMLButtonElement>('button.consolidate')!.click();
    expect(send).toHaveBeenCalledWith({ type: 'run', request: { kind: 'consolidate', packageId: 'X', version: '2.0.0', projects: ['p1', 'p2'] } });
    renderConsolidate(el, rows, false, send);
    expect(el.textContent).not.toContain('VersionOverride');
  });

  it('busy disables action buttons and error re-enables them', () => {
    const root = document.createElement('div');
    const status = document.createElement('div');
    const b1 = document.createElement('button'); b1.className = 'primary';
    const b2 = document.createElement('button'); b2.className = 'primary';
    root.append(status, b1, b2);
    applyBusy(root, status, 'Installing', { done: 1, total: 3 });
    expect(b1.disabled && b2.disabled).toBe(true);
    expect(status.textContent).toContain('Installing');
    expect(status.textContent).toContain('1/3');
    showError(root, status, 'boom', true, () => {});
    expect(b1.disabled || b2.disabled).toBe(false);
    expect(status.textContent).toContain('boom');
    expect(status.textContent).toContain('Show output');
    showError(root, status, 'boom', false, () => {});
    expect(status.textContent).not.toContain('Show output');
  });
});
