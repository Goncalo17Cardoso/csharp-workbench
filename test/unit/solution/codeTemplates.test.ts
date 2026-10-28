import { describe, expect, it } from 'vitest';
import { renderCodeTemplate } from '../../../src/solution/codeTemplates';

describe('renderCodeTemplate', () => {
  it('renders file-scoped class exactly', () => {
    expect(renderCodeTemplate('class', 'Customer', 'MyApp.Core.Models', true)).toBe(
      'namespace MyApp.Core.Models;\n\npublic class Customer\n{\n}\n');
  });
  it('renders block-scoped interface', () => {
    expect(renderCodeTemplate('interface', 'IFoo', 'A.B', false)).toBe(
      'namespace A.B\n{\n    public interface IFoo\n    {\n    }\n}\n');
  });
  it('renders other kinds', () => {
    expect(renderCodeTemplate('struct', 'S', 'N', true)).toBe('namespace N;\n\npublic struct S\n{\n}\n');
    expect(renderCodeTemplate('enum', 'E', 'N', true)).toBe('namespace N;\n\npublic enum E\n{\n}\n');
    expect(renderCodeTemplate('record', 'R', 'N', true)).toBe('namespace N;\n\npublic record R\n{\n}\n');
  });
});
