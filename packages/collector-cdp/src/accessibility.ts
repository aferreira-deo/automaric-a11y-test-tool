import { AGENT_GLOBAL } from './agent.js';
import type { StablePage } from './page.js';

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

interface AxNode {
  ignored?: boolean;
  role?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

/** Remote objects of marked elements and frame elements are held under this group and released at the end. */
const OBJECT_GROUP = 'a11y-vision-ax';
/** Level of an element with the role heading and no `aria-level` (WAI-ARIA). Chrome reports it itself; this is the fallback. */
const DEFAULT_HEADING_LEVEL = 2;
/**
 * The roles under which Chrome exposes list containers (verified against Chrome with
 * `Accessibility.getFullAXTree`): `list` for `ul`, `ol`, `menu` and the ARIA role, also when
 * `list-style` is `none` or the list is laid out as a row; `DescriptionList` for `dl`. A `ul`
 * with `role="presentation"` or `role="none"` is not exposed under either, unless it also has
 * `aria-label` or `tabindex`, in which case the presentational role is ignored and it is a list.
 */
const LIST_ROLES = ['list', 'DescriptionList'];
/** Elements marked in the page at once. */
const BATCH = 24;

export interface AccessibilityMarks {
  /** False when a document could not be read or a heading could not be matched to its element. */
  headings: boolean;
  /** False when a document could not be read, a list could not be matched, or a document has more lists than `maxLists`. */
  lists: boolean;
}

/**
 * Tells the agent which elements the accessibility tree exposes as headings and, when `lists` is
 * asked for, as lists: it reads the tree of the page and of every same-origin frame the agent can
 * look into (`Accessibility.getFullAXTree` covers one frame per call), and marks each such
 * element in the page. What a check then knows about semantics is what the browser exposes, not
 * what the tags say: an `h2` or a `ul` with `role="presentation"` is not marked, a `div` with
 * the role is.
 *
 * Only containers are marked for lists. A page can have thousands of list items, and an item is
 * inside list semantics exactly when a marked list holds it.
 */
export async function markAccessibility(page: StablePage, want: { lists: boolean; maxLists: number }): Promise<AccessibilityMarks> {
  const { cdp } = page;
  const complete: AccessibilityMarks = { headings: true, lists: true };

  /** Calls a method of the agent with a DOM node as its first argument. */
  const onNode = async (backendNodeId: number, call: string): Promise<unknown> => {
    const { object } = (await cdp.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId: page.contextId,
      objectGroup: OBJECT_GROUP,
    })) as { object: { objectId?: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () { return globalThis.${AGENT_GLOBAL}.${call}; }`,
      returnByValue: true,
    })) as { result: { value?: unknown } };
    return result.value;
  };

  const readFrame = async (tree: FrameTree, top: boolean): Promise<void> => {
    if (!top) {
      // Only documents the agent can look into matter: it reads no text from the others.
      const readable = await cdp
        .send('DOM.getFrameOwner', { frameId: tree.frame.id })
        .then(async (owner) => (await onNode((owner as { backendNodeId: number }).backendNodeId, 'frameReadable(this)')) === true)
        .catch(() => false);
      if (!readable) return;
    }
    try {
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree', { frameId: tree.frame.id })) as { nodes: AxNode[] };
      const lists: number[] = [];
      for (const node of nodes) {
        if (node.ignored || node.backendDOMNodeId === undefined) continue;
        const role = node.role?.value;
        if (role === 'heading') {
          const level = node.properties?.find((property) => property.name === 'level')?.value?.value;
          const marked = await onNode(
            node.backendDOMNodeId,
            `markHeading(this, ${typeof level === 'number' && Number.isInteger(level) && level > 0 ? level : DEFAULT_HEADING_LEVEL})`,
          ).catch(() => false);
          if (marked !== true) complete.headings = false;
        } else if (want.lists && typeof role === 'string' && LIST_ROLES.includes(role)) {
          lists.push(node.backendDOMNodeId);
        }
      }
      // Bounded: beyond the limit, which elements are lists is not known for this document.
      if (lists.length > want.maxLists) complete.lists = false;
      const bounded = lists.slice(0, want.maxLists);
      for (let start = 0; start < bounded.length; start += BATCH) {
        const marked = await Promise.all(bounded.slice(start, start + BATCH).map((id) => onNode(id, 'markList(this)').catch(() => false)));
        if (marked.some((value) => value !== true)) complete.lists = false;
      }
    } catch {
      complete.headings = false;
      complete.lists = false;
    }
    for (const child of tree.childFrames ?? []) await readFrame(child, false);
  };

  try {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    await readFrame(frameTree, true);
  } catch {
    complete.headings = false;
    complete.lists = false;
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  }
  return complete;
}
