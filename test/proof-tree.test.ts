import { describe, expect, it } from 'vitest';
import { parseTree } from '../src/proof-tree.js';

const OID = 'a'.repeat(40);
const caps = { maxBytes: 1000, maxFiles: 3 };
const line = (mode: string, type: string, size: string, path: string) =>
  `${mode} ${type} ${OID} ${size.padStart(7)}\t${path}\0`;

describe('a tree for a proof command', () => {
  it('plain files are listed with their size and mode', () => {
    expect(
      parseTree(
        line('100644', 'blob', '12', 'a/b.txt') + line('100755', 'blob', '3', 'run.sh'),
        caps,
      ),
    ).toEqual([
      { mode: '100644', oid: OID, size: 12, path: 'a/b.txt' },
      { mode: '100755', oid: OID, size: 3, path: 'run.sh' },
    ]);
    expect(parseTree('', caps)).toEqual([]);
  });
  it('a link, a submodule or another mode refuses the tree', () => {
    expect(parseTree(line('120000', 'blob', '9', 'l'), caps)).toMatch(/^a symbolic link/);
    expect(parseTree(line('160000', 'commit', '-', 'sub'), caps)).toMatch(/^a submodule/);
    expect(parseTree(line('100664', 'blob', '1', 'x'), caps)).toMatch(/^an entry of mode 100664/);
  });
  it('a path that leaves the tree, names .git or holds a control character refuses it', () => {
    for (const p of [
      '../x',
      'a/../../x',
      '/etc/x',
      'a//b',
      './a',
      '.git/config',
      'a/.GIT/hooks/x',
      'a\x01b',
      'a\\b',
    ]) {
      expect(parseTree(line('100644', 'blob', '1', p), caps), p).toEqual(expect.any(String));
    }
  });
  it('two paths that differ only in case refuse it', () => {
    expect(
      parseTree(line('100644', 'blob', '1', 'A.txt') + line('100644', 'blob', '1', 'a.txt'), caps),
    ).toBe('two paths that differ only in case');
  });
  it('over the size or the file cap, nothing is written', () => {
    expect(
      parseTree(line('100644', 'blob', '600', 'a') + line('100644', 'blob', '600', 'b'), caps),
    ).toMatch(/^more than/);
    const four = ['a', 'b', 'c', 'd'].map((p) => line('100644', 'blob', '1', p)).join('');
    expect(parseTree(four, caps)).toBe('more than 3 files');
  });
  it('a listing that cannot be read refuses it', () => {
    expect(parseTree('garbage\0', caps)).toBe('a tree listing that cannot be read');
  });
});
