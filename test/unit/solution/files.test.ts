import { describe, expect, it, vi } from 'vitest';
import { renderCodeTemplate } from '../../../src/solution/codeTemplates';
import {
  canPasteInto, dedupeNested, FileExistsError, isSamePathIgnoreCase, copyName, createBuiltIn, createFromCatalog, ensureNotExists, isSameProject, newItemChoices, targetPathFor,
  validateDrop, validateName,
} from '../../../src/solution/commands/files';
import type { ProjectInfoData } from '../../../src/solution/model';

const info: ProjectInfoData = {
  path: '/s/Core/Core.csproj', rootNamespace: 'MyApp.Core', targetFrameworks: [], projectRefs: [], fileScopedNamespaces: true,
};
const core = {
  projectForPath: (p: string) =>
    p.startsWith('/s/Core/') ? { path: '/s/Core/Core.csproj', name: 'Core' }
      : p.startsWith('/s/Web/') ? { path: '/s/Web/Web.csproj', name: 'Web' } : undefined,
};

describe('pure helpers', () => {
  it('targetPathFor appends the extension once', () => {
    expect(targetPathFor('/a', 'X', '.cs')).toBe('/a/X.cs');
    expect(targetPathFor('/a', 'X.cs', '.cs')).toBe('/a/X.cs');
  });
  it('ensureNotExists throws for an existing file', async () => {
    await expect(ensureNotExists('/a/X.cs', async () => true)).rejects.toBeInstanceOf(FileExistsError);
    await expect(ensureNotExists('/a/X.cs', async () => false)).resolves.toBeUndefined();
  });
  it('copyName produces "X - Copy.cs" then "X - Copy (2).cs"', () => {
    expect(copyName(new Set(['X.cs']), 'X.cs')).toBe('X - Copy.cs');
    expect(copyName(new Set(['X.cs', 'X - Copy.cs']), 'X.cs')).toBe('X - Copy (2).cs');
    expect(copyName(new Set(['Dir']), 'Dir')).toBe('Dir - Copy');
    expect(copyName(new Set(), 'Y.cs')).toBe('Y.cs');
  });
  it('validateName rejects empty, illegal chars and existing', () => {
    
    expect(validateName('', () => false)).toEqual({ code: 'empty' });
    expect(validateName('a/b', () => false)).toEqual({ code: 'chars' });
    expect(validateName('a?', () => false)).toEqual({ code: 'chars' });
    expect(validateName('X', () => true)).toEqual({ code: 'exists', name: 'X' });
    expect(validateName('X', () => false)).toBeUndefined();
  });
  it('isSameProject', () => {
    expect(isSameProject(core, '/s/Core/a.cs', '/s/Core/sub')).toBe(true);
    expect(isSameProject(core, '/s/Core/a.cs', '/s/Web/b.cs')).toBe(false);
    expect(isSameProject(core, '/x/a.cs', '/x/b.cs')).toBe(false);
  });
});

describe('multi-select guards', () => {
  it('dedupeNested drops children and duplicates', () => {
    expect(dedupeNested(['/a/Dir', '/a/Dir/x.cs', '/a/Dir2', '/a/Dir'])).toEqual(['/a/Dir', '/a/Dir2']);
  });
  it('canPasteInto refuses self and descendants', () => {
    expect(canPasteInto(['/a/Dir'], '/a/Dir')).toBe(false);
    expect(canPasteInto(['/a/Dir'], '/a/Dir/Sub')).toBe(false);
    expect(canPasteInto(['/a/Dir'], '/a/Dir2')).toBe(true);
  });
  it('case-only rename is the same path', () => {
    expect(isSamePathIgnoreCase('/a/foo.cs', '/a/Foo.cs')).toBe(true);
    expect(isSamePathIgnoreCase('/a/foo.cs', '/a/bar.cs')).toBe(false);
  });
  it('strips .CS case-insensitively for the type name', async () => {
    const write = vi.fn(async () => {});
    await createBuiltIn({ exists: async () => false, write }, 'class', 'Foo.CS', '/s/Core', '/s/Core', info);
    expect(write).toHaveBeenCalledWith('/s/Core/Foo.CS', renderCodeTemplate('class', 'Foo', 'MyApp.Core', true));
  });
});

describe('validateDrop', () => {
  it('refuses another project', () => {
    expect(validateDrop(core, ['/s/Core/a.cs'], '/s/Web/Models')).toBe('Files can only be moved within the same project.');
  });
  it('refuses a folder into itself or a descendant', () => {
    expect(validateDrop(core, ['/s/Core/Models'], '/s/Core/Models')).toBeTruthy();
    expect(validateDrop(core, ['/s/Core/Models'], '/s/Core/Models/Sub')).toBeTruthy();
  });
  it('allows a sibling move; a prefix-sharing folder is not a descendant', () => {
    expect(validateDrop(core, ['/s/Core/Models'], '/s/Core/Models2')).toBeUndefined();
    expect(validateDrop(core, ['/s/Core/a.cs'], '/s/Core/Models')).toBeUndefined();
  });
});

describe('newItemChoices', () => {
  it('composes Code, built-ins, Templates filtered and sorted', () => {
    const items = newItemChoices([
      { name: 'Class', shortNames: ['class'], languages: ['C#'], tags: '' },
      { name: 'VB Thing', shortNames: ['vbt'], languages: ['VB'], tags: '' },
      { name: 'Web Config', shortNames: ['webconfig'], languages: [], tags: '' },
      { name: 'API Controller', shortNames: ['apicontroller', 'ac'], languages: ['C#'], tags: '' },
    ]);
    expect(items.map((i) => i.kind === 'separator' ? `--${i.label}` : i.label)).toEqual([
      '--Code', 'Class', 'Interface', 'Enum', 'Record', 'Struct', '--Templates', 'API Controller', 'Web Config',
    ]);
    expect(items.find((i) => i.label === 'API Controller')).toMatchObject({ description: 'apicontroller, ac' });
  });
});

describe('createBuiltIn', () => {
  it('class in Models folder gets project namespace + Models', async () => {
    const write = vi.fn(async () => {});
    const p = await createBuiltIn({ exists: async () => false, write }, 'class', 'Customer', '/s/Core/Models', '/s/Core', info);
    expect(p).toBe('/s/Core/Models/Customer.cs');
    expect(write).toHaveBeenCalledWith(p, renderCodeTemplate('class', 'Customer', 'MyApp.Core.Models', true));
  });
  it('sanitizes the identifier but keeps the typed file name', async () => {
    const write = vi.fn(async () => {});
    const p = await createBuiltIn({ exists: async () => false, write }, 'class', 'my-class', '/s/Core', '/s/Core', info);
    expect(p).toBe('/s/Core/my-class.cs');
    expect(write).toHaveBeenCalledWith(p, renderCodeTemplate('class', 'my_class', 'MyApp.Core', true));
  });
  it('newItem refuses existing file', async () => {
    const write = vi.fn(async () => {});
    await expect(createBuiltIn({ exists: async () => true, write }, 'class', 'Customer', '/s/Core', '/s/Core', info))
      .rejects.toMatchObject({ code: 'exists', fileName: 'Customer.cs' });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('createFromCatalog', () => {
  it('passes --project when supported and returns only new files', async () => {
    const newTemplate = vi.fn(async () => {});
    const list = vi.fn().mockResolvedValueOnce(['/f/old.cs']).mockResolvedValueOnce(['/f/old.cs', '/f/New.cs']);
    const created = await createFromCatalog({
      cli: { newTemplate }, options: async () => ({ namespace: false, project: true }), listFiles: list,
    }, 'apicontroller', 'New', '/f', 'MyApp.Core', '/s/Core/Core.csproj');
    expect(newTemplate).toHaveBeenCalledWith('apicontroller',
      ['-n', 'New', '-o', '/f', '--project', '/s/Core/Core.csproj'], '/f');
    expect(created).toEqual(['/f/New.cs']);
  });
});
