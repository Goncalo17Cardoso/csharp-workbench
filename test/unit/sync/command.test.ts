import { describe, expect, it } from 'vitest';
import { toWorkspaceEditSpec } from '../../../src/sync/editSpec';
import type { SyncPlan } from '../../../src/sync/plan';

const plan = (path: string, edits: { start: number; end: number; newText: string }[]): SyncPlan =>
  ({ edits: new Map([[path, edits]]), skipped: [], moves: [], ambiguous: [] });

describe('toWorkspaceEditSpec', () => {
  it('maps offsets in CRLF+BOM text to positions', () => {
    const text = '﻿using A;\r\nnamespace Old;\r\nclass C {}';
    const at = text.indexOf('Old');
    const spec = toWorkspaceEditSpec(plan('/a.cs', [{ start: at, end: at + 3, newText: 'New' }]), new Map([['/a.cs', text]]));
    expect(spec[0].range).toEqual({ startLine: 1, startCol: 10, endLine: 1, endCol: 13 });
  });
  it('does not count the BOM as a column on line 0', () => {
    const text = '﻿using A;\r\nclass C {}';
    const spec = toWorkspaceEditSpec(plan('/a.cs', [{ start: 1, end: 1, newText: 'using B;\r\n' }]), new Map([['/a.cs', text]]));
    expect(spec[0].range).toEqual({ startLine: 0, startCol: 0, endLine: 0, endCol: 0 });
  });
  it('leaves BOM-less text (open document) untouched', () => {
    const text = 'using A;\nnamespace Old;';
    const at = text.indexOf('Old');
    const spec = toWorkspaceEditSpec(plan('/a.cs', [{ start: 0, end: 5, newText: 'x' }, { start: at, end: at + 3, newText: 'N' }]), new Map([['/a.cs', text]]));
    expect(spec[0].range.startCol).toBe(0);
    expect(spec[1].range).toEqual({ startLine: 1, startCol: 10, endLine: 1, endCol: 13 });
  });
  it('labels per edit kind', () => {
    const text = 'using Old;\nnamespace Old;\nclass C { Old.T x; }';
    const o = (s: string, from = 0) => text.indexOf(s, from);
    const spec = toWorkspaceEditSpec(plan('/a.cs', [
      { start: o('Old'), end: o('Old') + 3, newText: 'New' },
      { start: o('Old', 12), end: o('Old', 12) + 3, newText: 'New' },
      { start: o('Old.T'), end: o('Old.T') + 5, newText: 'New.T' },
      { start: 0, end: 0, newText: 'using Z;\n' },
    ]), new Map([['/a.cs', text]]));
    expect(spec.map((s) => s.label)).toEqual(['Using directive', 'Namespace declaration', 'Qualified name', 'Using directive']);
  });
});
