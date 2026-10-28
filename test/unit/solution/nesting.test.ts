import { describe, expect, it } from 'vitest';
import { nestFiles } from '../../../src/solution/nesting';

describe('nestFiles', () => {
  it('nests appsettings environments under appsettings.json', () => {
    const m = nestFiles(['appsettings.json', 'appsettings.Development.json', 'other.json']);
    expect(m.get('appsettings.Development.json')).toBe('appsettings.json');
    expect(m.has('other.json')).toBe(false);
  });
  it('nests Designer.cs under resx before cs', () => {
    expect(nestFiles(['A.resx', 'A.cs', 'A.Designer.cs']).get('A.Designer.cs')).toBe('A.resx');
    expect(nestFiles(['A.cs', 'A.Designer.cs']).get('A.Designer.cs')).toBe('A.cs');
  });
  it('does not nest without parent', () => {
    expect(nestFiles(['A.Designer.cs', 'b.razor.cs', 'x.g.cs', 'a.min.js', 'p.Dev.json']).size).toBe(0);
  });
  it('covers the other rules', () => {
    const m = nestFiles(['V.xaml', 'V.xaml.cs', 'C.razor', 'C.razor.cs', 'C.razor.css', 'C.razor.js', 'P.cshtml', 'P.cshtml.cs',
      'G.cs', 'G.g.cs', 'G.g.i.cs', 's.js', 's.min.js', 's.css', 's.min.css']);
    expect(Object.fromEntries(m)).toEqual({
      'V.xaml.cs': 'V.xaml', 'C.razor.cs': 'C.razor', 'C.razor.css': 'C.razor', 'C.razor.js': 'C.razor',
      'P.cshtml.cs': 'P.cshtml', 'G.g.cs': 'G.cs', 'G.g.i.cs': 'G.cs', 's.min.js': 's.js', 's.min.css': 's.css',
    });
  });
});
