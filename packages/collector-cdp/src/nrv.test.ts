import { describe, expect, it } from 'vitest';
import { axOf } from './nrv.js';

describe('what a node of the accessibility tree says', () => {
  const root = { nodeId: '1', role: { value: 'RootWebArea' } };
  const list = { nodeId: '2', parentId: '1', role: { value: 'tablist' } };
  const generic = { nodeId: '3', parentId: '2', role: { value: 'generic' } };
  const byId = new Map(
    [root, list, generic].map((node) => [node.nodeId, node]),
  );

  it('takes the source of the name that is not superseded, the states, and the context without generic nodes', () => {
    const node = {
      nodeId: '4',
      parentId: '3',
      backendDOMNodeId: 9,
      role: { value: 'tab' },
      name: {
        value: '  Phone   number ',
        sources: [
          { type: 'attribute', attribute: 'aria-labelledby' },
          { type: 'attribute', attribute: 'title', value: { type: 'computedString', value: 'Phone number' } },
          { type: 'attribute', attribute: 'title', superseded: true, value: { type: 'computedString', value: 'Phone number' } },
        ],
      },
      properties: [
        { name: 'focusable', value: { value: true } },
        { name: 'selected', value: { value: false } },
        { name: 'expanded', value: { value: true } },
        { name: 'level', value: { value: 2 } },
      ],
    };
    expect(axOf(node, byId, 160)).toEqual({
      role: 'tab',
      name: 'Phone number',
      nameSource: 'attribute:title',
      focusable: true,
      disabled: false,
      states: { selected: 'false', expanded: 'true' },
      context: ['tablist', 'RootWebArea'],
    });
  });

  it('keeps the reasons Chrome gives for an ignored node, and an empty name has no source', () => {
    const node = { nodeId: '5', parentId: '1', ignored: true, ignoredReasons: [{ name: 'ariaHiddenSubtree' }], role: { value: 'none' }, name: { value: '', sources: [{ type: 'contents', value: { value: '' } }] } };
    expect(axOf(node, byId, 160)).toMatchObject({ role: 'none', name: '', nameSource: '', ignored: ['ariaHiddenSubtree'] });
  });
});
