import { AGENT_GLOBAL } from './agent.js';
import type { StablePage } from './page.js';

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

interface AxNode {
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  description?: { value?: unknown };
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
/**
 * The roles under which Chrome exposes the form controls the grouping check looks at (verified
 * against Chrome with `Accessibility.getFullAXTree`): `radio`, `checkbox` and `switch` for native
 * inputs and for the ARIA roles; `textbox` for text, email, tel, url and password inputs,
 * `textarea` and editable boxes with the role; `searchbox`; `spinbutton` for number inputs;
 * `combobox` for a `select` that drops down, an input with a `datalist` and the ARIA role;
 * `listbox` for a `select` shown as a list (and for the ARIA role, which the agent leaves out);
 * `Date`, `DateTime` (datetime-local, month, week) and `InputTime` for the date and time inputs.
 * The parts of a date input that Chrome builds itself are spin buttons too; they live in a
 * shadow tree of the browser, which the survey never walks into. Controls that are not rendered
 * (`display: none`, `visibility: hidden`), inert or under `aria-hidden` have no node here, so
 * they are never marked; one that is only made transparent or clipped to a pixel has.
 */
const CONTROL_ROLES = ['radio', 'checkbox', 'switch', 'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'Date', 'DateTime', 'InputTime'];
/**
 * Containers that can name what they hold. `group` is what Chrome exposes for a `fieldset`
 * (named from its `legend`) and for the ARIA role, with an empty name when there is none; a
 * `fieldset` with `role="presentation"` has no node. `details` and `address` are groups without
 * a name as well. The others count only when they have a name.
 */
const GROUP_ROLES = ['group', 'radiogroup'];
const NAMED_CONTAINER_ROLES = ['region', 'form', 'dialog', 'alertdialog', 'tabpanel', 'search'];
/** Elements marked in the page at once. */
const BATCH = 24;

export interface AccessibilityMarks {
  /** False when a document could not be read or a heading could not be matched to its element. */
  headings: boolean;
  /** False when a document could not be read, a list could not be matched, or a document has more lists than `maxLists`. */
  lists: boolean;
  /** False when a document could not be read, a control or a group could not be matched, or a document has more of either than `grouping.maxMarks`. */
  grouping: boolean;
}

/**
 * Tells the agent which elements the accessibility tree exposes as headings, when `lists` is
 * asked for as lists, and when `grouping` is asked for as form controls and as groups, with the
 * name and the description the browser computed for them: it reads the tree of the page and of every same-origin frame the agent can
 * look into (`Accessibility.getFullAXTree` covers one frame per call), and marks each such
 * element in the page. What a check then knows about semantics is what the browser exposes, not
 * what the tags say: an `h2` or a `ul` with `role="presentation"` is not marked, a `div` with
 * the role is.
 *
 * Only containers are marked for lists. A page can have thousands of list items, and an item is
 * inside list semantics exactly when a marked list holds it.
 */
export async function markAccessibility(
  page: StablePage,
  want: { lists: boolean; maxLists: number; grouping?: { maxMarks: number; maxNameChars: number } | null },
): Promise<AccessibilityMarks> {
  const { cdp } = page;
  const complete: AccessibilityMarks = { headings: true, lists: true, grouping: true };
  /** A name or a description as the tree gives it, white space collapsed, cut to the limit. */
  const textOf = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

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
      const controls: { id: number; call: string }[] = [];
      const groups: { id: number; call: string }[] = [];
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
        } else if (want.grouping && typeof role === 'string') {
          const max = want.grouping.maxNameChars;
          const name = textOf(node.name?.value, max);
          if (CONTROL_ROLES.includes(role)) {
            controls.push({
              id: node.backendDOMNodeId,
              call: `markControl(this, ${JSON.stringify(role)}, ${JSON.stringify(name)}, ${JSON.stringify(textOf(node.description?.value, max))})`,
            });
          } else if (GROUP_ROLES.includes(role) || (NAMED_CONTAINER_ROLES.includes(role) && name !== '')) {
            groups.push({ id: node.backendDOMNodeId, call: `markGroup(this, ${JSON.stringify(role)}, ${JSON.stringify(name)})` });
          }
        }
      }
      // Bounded, as for lists: beyond the limit, names and groups are not known in full for this document.
      for (const marks of want.grouping ? [controls, groups] : []) {
        if (marks.length > want.grouping!.maxMarks) complete.grouping = false;
        const bounded = marks.slice(0, want.grouping!.maxMarks);
        for (let start = 0; start < bounded.length; start += BATCH) {
          const marked = await Promise.all(bounded.slice(start, start + BATCH).map((mark) => onNode(mark.id, mark.call).catch(() => false)));
          if (marked.some((value) => value !== true)) complete.grouping = false;
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
      complete.grouping = false;
    }
    for (const child of tree.childFrames ?? []) await readFrame(child, false);
  };

  try {
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    await readFrame(frameTree, true);
  } catch {
    complete.headings = false;
    complete.lists = false;
    complete.grouping = false;
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  }
  return complete;
}
