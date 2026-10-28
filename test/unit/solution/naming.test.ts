import { describe, expect, it } from 'vitest';
import { namespaceFor, toIdentifier } from '../../../src/solution/naming';

describe('toIdentifier', () => {
  it('sanitises', () => {
    expect(toIdentifier('2Customer')).toBe('_2Customer');
    expect(toIdentifier('my-class')).toBe('my_class');
    expect(toIdentifier('class')).toBe('@class');
    expect(toIdentifier('Café_1')).toBe('Café_1');
    expect(toIdentifier('')).toBe('_');
    expect(toIdentifier('My Folder')).toBe('My_Folder');
  });
});

describe('namespaceFor', () => {
  it('appends sanitised segments', () => {
    expect(namespaceFor('MyApp.Core', '/p', '/p/My Folder/Sub')).toBe('MyApp.Core.My_Folder.Sub');
  });
  it('returns root when folder is project dir or outside', () => {
    expect(namespaceFor('MyApp', '/p', '/p')).toBe('MyApp');
    expect(namespaceFor('MyApp', '/p', '/q/x')).toBe('MyApp');
  });
  it('sanitises root segments', () => {
    expect(namespaceFor('My-App.1x', '/p', '/p/a')).toBe('My_App._1x.a');
  });
});
