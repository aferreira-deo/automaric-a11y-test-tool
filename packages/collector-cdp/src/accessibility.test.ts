import { describe, expect, it } from 'vitest';
import { inDocumentOrder } from './accessibility.js';

describe('the order of the nodes of an accessibility tree', () => {
  // A form with a deep question first and two checkboxes after it, as `Accessibility.getFullAXTree`
  // gives it: level by level.
  const levelByLevel = [
    { nodeId: 'root', childIds: ['form'] },
    { nodeId: 'form', parentId: 'root', childIds: ['wrap', 'box1', 'box2'] },
    { nodeId: 'wrap', parentId: 'form', childIds: ['inner'] },
    { nodeId: 'box1', parentId: 'form' },
    { nodeId: 'box2', parentId: 'form', childIds: [] },
    { nodeId: 'inner', parentId: 'wrap', childIds: ['yes', 'no'] },
    { nodeId: 'yes', parentId: 'inner' },
    { nodeId: 'no', parentId: 'inner' },
  ];
  const ids = (nodes: { nodeId?: string }[]): (string | undefined)[] => nodes.map((node) => node.nodeId);

  it('is that of the document: each node before what it holds, and before what follows it', () => {
    expect(ids(inDocumentOrder(levelByLevel))).toEqual(['root', 'form', 'wrap', 'inner', 'yes', 'no', 'box1', 'box2']);
  });
  it('keeps every node once, also those that hang on nothing, name a child that is missing, or go round in a circle', () => {
    const odd = [
      { nodeId: 'a', childIds: ['b', 'missing', 'b'] },
      { nodeId: 'b', parentId: 'a', childIds: ['a'] },
      { nodeId: 'orphan', parentId: 'nowhere' },
      {},
      { nodeId: 'loop1', parentId: 'loop2', childIds: ['loop2'] },
      { nodeId: 'loop2', parentId: 'loop1', childIds: ['loop1'] },
    ];
    const ordered = inDocumentOrder(odd);
    expect(ordered).toHaveLength(odd.length);
    expect(new Set(ordered).size).toBe(odd.length);
    expect(ids(ordered).slice(0, 3)).toEqual(['a', 'b', 'orphan']);
  });
  it('is quick on a deep tree and on a wide one', () => {
    const deep = Array.from({ length: 20000 }, (_, index) => ({ nodeId: String(index), ...(index > 0 ? { parentId: String(index - 1) } : {}), childIds: [String(index + 1)] }));
    expect(inDocumentOrder(deep)).toHaveLength(20000);
    const wide = [{ nodeId: 'r', childIds: Array.from({ length: 20000 }, (_, index) => `c${index}`) }, ...Array.from({ length: 20000 }, (_, index) => ({ nodeId: `c${index}`, parentId: 'r' }))];
    expect(ids(inDocumentOrder(wide)).slice(0, 3)).toEqual(['r', 'c0', 'c1']);
  });
});
