export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Encoded PNG bytes. */
export type Png = Uint8Array;

export type Status = 'fail' | 'likely' | 'advisory' | 'info';

export type CheckId =
  | 'noop'
  | 'focus-indicator'
  | 'icon-contrast'
  | 'headings'
  | 'lists'
  | 'grouping';

/** CSS pixels, relative to the top-left of the document of the frame the node lives in. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WcagRef {
  /** Success criterion number, e.g. "2.4.7". */
  sc: string;
  level: 'A' | 'AA';
}

export interface SnapshotNode {
  id: number;
  /** Stable CSS selector, unique within its frame and shadow scope. */
  selector: string;
  frameId: string;
  /** Selectors of the shadow hosts to traverse, outermost first. Empty in the light DOM. */
  shadowPath: string[];
  box: Box | null;
  /** Subset of computed styles, keyed by CSS property name. */
  styles: Record<string, string>;
  /** Text of the node's own text-node children, not of its descendants. */
  ownText: string;
}

export interface AxNode {
  id: string;
  role: string;
  name: string;
  /** Matching SnapshotNode id, when the accessibility node maps to a DOM node. */
  nodeId: number | null;
  childIds: string[];
  properties: Record<string, JsonValue>;
}

export interface Screenshot {
  box: Box;
  /** Device pixels per CSS pixel in `png`. */
  scale: number;
  png: Png;
}

export interface Environment {
  url: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  colorScheme: 'light' | 'dark';
  /**
   * Present when the page went to another document while it was being read (a redirect by
   * script or by `meta refresh` after it had loaded) and was read again there: the address the
   * scan started on. `url` is the address of the document the findings are about.
   */
  navigatedFrom?: string;
}

/** One element that received focus during collection. All boxes are CSS pixels in page coordinates. */
export interface FocusStop {
  selector: string;
  /** Selectors of the enclosing same-origin iframes, outermost first, joined with " >>> ". Empty in the main frame. */
  frame: string;
  /** Border box while focused. */
  box: Box;
  /** `tab`: reached with real Tab presses. `forced`: pseudo-state forced through CDP, lower confidence. */
  reachedBy: 'tab' | 'forced';
  /** Text field, textarea or contenteditable: the (hidden) caret may be its only focus cue. */
  textEntry: boolean;
  /** An author rule matched in the focused state declares an outline or has :focus in its selector. */
  authorModified: boolean;
  /** Cross-origin iframe: focus went inside and could not be followed. */
  opaqueFrame: boolean;
  /**
   * Where the browser left the element when it received focus, before collection scrolled it:
   * how many of the sampled points were covered by fixed or sticky content, and under how many
   * of those the covering content is demonstrably opaque (see `obscuredInfo` in the collector).
   * Null when not sampled.
   */
  obscured: { covered: number; sampled: number; by: string; opaque: number } | null;
  /**
   * While it was captured, after scrolling, the element was entirely under fixed or sticky
   * content that is not demonstrably opaque. The captures then show what gets through that content.
   */
  coveredAtCapture?: boolean;
  /**
   * The element was still focused after it was blurred (a script gives focus back), so the
   * "unfocused" capture does not show the unfocused state and nothing can be concluded from the pair.
   */
  unfocusedNotCaptured?: boolean;
  /** Once scrolled for capture, the border box still reached beyond the viewport on at least one side. */
  clippedByViewport?: boolean;
  /**
   * The stabilising styles (no transitions, no animations, no caret) did not take effect on this
   * element: an author `!important` rule outweighs them, or the style sheet could not be attached.
   */
  unstabilised?: boolean;
  /** The box moved or resized between the unfocused and the focused state. */
  geometryChanged: boolean;
  /** Crop ids of the two captures of the same region; null when the element could not be captured. */
  crops: { focused: string; unfocused: string } | null;
  /**
   * Why `crops` is null. `transformed-frame`: the element is inside an iframe that is scaled,
   * rotated or zoomed, where page coordinates cannot be worked out from the frame's box.
   */
  notCaptured?: 'no-box' | 'obscured' | 'outside-viewport' | 'transformed-frame';
  /**
   * While it was captured, something the 2.4.11 sampling cannot see lay over the element, or
   * that could not be ruled out: content of a parent document over the iframe it is in, a layer
   * with `pointer-events: none`, a pseudo-element of an ancestor. The captures may show that
   * content, so no `fail` is drawn from them.
   */
  possiblyCovered?: boolean;
  /**
   * Evaluated only when the two crops are identical: bounding box of what changed elsewhere
   * in the viewport, or null when nothing did. Undefined when not evaluated.
   */
  outsideChange?: Box | null;
}

export interface FocusWalk {
  stops: FocusStop[];
  /**
   * `cycle`: focus came back to a visited element. `limit`: `maxTabStops` was hit.
   * `opaque-frame`: focus stayed inside a cross-origin iframe and could not be moved past it.
   */
  stoppedBy: 'cycle' | 'limit' | 'opaque-frame' | 'no-focusable';
  /** Focusable elements the Tab walk never reached. */
  unreached: number;
  /** How many of those were measured with a forced state. */
  forced: number;
}

/** What draws the graphic of an icon control. */
export type IconSource =
  | 'svg'
  | 'img'
  | 'font-glyph'
  | 'background-image'
  | 'mask-image'
  | 'pseudo-element'
  | 'css-shape';

export type IconHint = 'inactive' | 'logo' | 'home-link' | 'plain-shape' | 'visible-label' | 'duplicate-link';

export type BoundaryControl = 'text-field' | 'select' | 'checkbox' | 'radio' | 'switch';

/**
 * One control collected for the icon-contrast check: an interactive element without visible
 * text that renders a graphic (`icon`), or a form control identified by its boundary
 * (`boundary`). All boxes are CSS pixels in page coordinates, taken while it was captured.
 */
export interface IconCandidate {
  selector: string;
  /** Same convention as FocusStop.frame. */
  frame: string;
  /** Border box of the control. */
  box: Box;
  kind: 'icon' | 'boundary';
  /** `disabled`, inside a disabled fieldset, or `aria-disabled="true"` on it or an ancestor. Not measured. */
  disabled: boolean;
  icon?: {
    /** Distinct sources found in the control, in a fixed order. */
    sources: IconSource[];
    /** Box of the graphic: the union of the elements that draw it, or the padding box of the control. */
    box: Box;
    /** Where `box` comes from. `control`: a source without a box of its own (pseudo-element, background). */
    boxFrom: 'graphic' | 'control';
    /** Padding box of the control: what lies inside it and around the graphic is the control's own fill. */
    room: Box;
    /**
     * #rrggbb when the collector could read one opaque colour for the whole graphic from computed
     * styles: SVG shapes that all paint the same solid colour, an icon-font glyph, the background
     * colour under a mask. Null when opacity, a filter, a blend mode, a gradient, an image or
     * several colours are involved: then only pixels can tell.
     */
    declaredColor: string | null;
  };
  boundary?: {
    control: BoundaryControl;
    /**
     * False for a native control on which no author rule declares a border, background,
     * box-shadow, appearance or accent colour: its look is the browser default.
     */
    authorModified: boolean;
    /** Boxes whose edges are measured: the control first, then its tight wrappers, innermost first. */
    boxes: Box[];
  };
  /**
   * Signs in styles and markup that the control may be exempt, or may not be identified by its
   * graphic, although nothing says so programmatically. Any of them keeps a finding from being a `fail`.
   * - `inactive`: no pointer events, a not-allowed cursor, or a class naming it disabled.
   * - `logo`: a class, id, name or file name says logo.
   * - `home-link`: a link to the root of the site or with `rel="home"`, or a link in the page
   *   header named "home" or after the site: where a logotype usually is.
   * - `plain-shape`: the graphic is a single element drawn with CSS (a colour swatch).
   * - `visible-label`: visible text outside the control is its label (`aria-labelledby`, `label`).
   * - `duplicate-link`: a link hidden from assistive technology (`aria-hidden`, `tabindex="-1"`)
   *   next to a text link with the same target.
   */
  hints?: IconHint[];
  /** Crop id of the capture; null when the control could not be captured. */
  crop: string | null;
  /**
   * Why `crop` is null. `cover-unknown`: the hit test that proves nothing lies in front of the
   * control gave no answer. `detached`: the control was removed from the page during the scan.
   * `transformed-frame`: see FocusStop.notCaptured.
   */
  notCaptured?: 'no-box' | 'outside-viewport' | 'covered' | 'cover-unknown' | 'moving' | 'detached' | 'transformed-frame';
  /** Once scrolled for capture, the measured region still reached beyond the viewport. */
  clippedByViewport?: boolean;
  /** See FocusStop.unstabilised. */
  unstabilised?: boolean;
}

export interface IconSurvey {
  candidates: IconCandidate[];
  /** Controls that qualified, including those beyond `maxCandidates`. */
  total: number;
  /** Controls looked at and left out, by reason (`hidden`, `small`, `large`, `noGraphic`, `unsupported`). */
  skipped: Record<string, number>;
}

/** Computed text style of a block: that of most of its characters. */
export interface TextStyle {
  /** First family of the computed `font-family`, lower case, without quotes. */
  family: string;
  /** Computed font size, CSS px. */
  size: number;
  /** Computed font weight, 1 to 1000. */
  weight: number;
  /** Computed colour: #rrggbb, or #rrggbbaa when it is translucent. */
  color: string;
  /** Computed `text-transform`. */
  transform: string;
  italic: boolean;
}

/**
 * Where a text block sits in the page, read from its ancestors (across shadow roots and frames).
 * A block has a context only when all of its text is inside one.
 * - `label`: `label` or `legend`. `caption`: `caption` or `figcaption`.
 * - `tableHeader`, `tableCell`: by tag or by role. `term`: `dt`.
 * - `button`: `button`, `summary`, or a widget role (button, tab, menuitem, option, switch, checkbox, radio, treeitem).
 * - `link`: `a[href]` or the role link.
 * - `quote`: `blockquote` or `q`. `code`: `pre`, `code`, `kbd` or `samp`.
 * - `navigation`: `nav`, or the role navigation, menu, menubar, tablist, toolbar, tree or listbox.
 * - `ariaHidden`: `aria-hidden="true"` or `inert`: not exposed to assistive technology at all.
 */
export type TextContext =
  | 'label'
  | 'caption'
  | 'tableHeader'
  | 'tableCell'
  | 'term'
  | 'button'
  | 'link'
  | 'quote'
  | 'code'
  | 'navigation'
  | 'ariaHidden';

/**
 * One block of visible text: the text nodes that are laid out together in one block container,
 * between two block-level boundaries, whatever their tags. A forced line break splits a block
 * only where the style changes across it. All boxes are CSS pixels in page coordinates.
 */
export interface TextBlock {
  /** The lowest element that holds all the text of the block, or the block container when the block is all its text. */
  selector: string;
  /** Same convention as FocusStop.frame. */
  frame: string;
  /** Local name of that element. */
  tag: string;
  /** Text with white space collapsed, cut to `maxTextChars`. */
  text: string;
  /** Characters of the whole text that are not white space. */
  chars: number;
  /** Runs of characters separated by white space, in the whole text. */
  words: number;
  /** Union of the painted line boxes. */
  box: Box;
  /** Painted lines. */
  lines: number;
  firstLine: Box;
  lastLine: Box;
  /** Forced line breaks (`br`) inside the block. */
  breaks: number;
  style: TextStyle;
  /** Share of the characters that have `style`, 0 to 1. Under 1, the block mixes styles (a bold lead-in). */
  styleShare: number;
  contexts: TextContext[];
  /** Inside `main` or the role main. */
  inMain: boolean;
  /** Inside a list item (`li`, or the role listitem). */
  inListItem: boolean;
  /**
   * The nearest enclosing region (a landmark element or role, `article`, `dialog`), as frame and
   * selector; empty outside any. Heading levels are compared inside one region only.
   */
  region: string;
  /**
   * Set when the accessibility tree exposes the block as a heading: an ancestor of all its text
   * is a node with the role heading that is not ignored. `selector` is that of the heading element.
   */
  heading: { level: number; selector: string } | null;
  /** Crop id of the capture of the block with what surrounds it; null when it was not captured. */
  crop: string | null;
  /**
   * Where the text of the block is inside that capture: CSS pixels from the top-left corner of
   * the capture, as measured when it was taken (the block was scrolled to first, so `box` does
   * not say). Absent when there is no capture.
   */
  cropTarget?: Box;
  /** Other content lay over the middle of the block when it was to be captured (a banner, a dialog), so it was not. */
  covered?: boolean;
  /**
   * The text has exactly the colour of the background behind it, as far as styles tell: the
   * nearest opaque background colour among its ancestors, with no background image, translucent
   * colour, text shadow or text stroke on the way. It may still sit over a picture positioned
   * behind it, so it is read as text and only held back.
   */
  sameColourAsBackground?: boolean;
}

export interface HeadingSurvey {
  /** Visible text blocks in document order, frames in place. */
  blocks: TextBlock[];
  /** Blocks found, including those beyond `maxBlocks`. */
  total: number;
  /**
   * False when the accessibility tree of a document the survey looked into could not be read, or
   * one of its headings could not be matched to its element: which text is exposed as a heading
   * is then not known for certain, and nothing is reported above `info`.
   */
  axComplete: boolean;
}

/**
 * What stands before a line of text where a bullet or a number would, when it is not a character
 * of the text itself.
 * - `pseudo-text`: generated content of `::before` that is text (`text`).
 * - `pseudo-counter`: generated content of `::before` that uses a CSS counter.
 * - `pseudo-shape`: a `::before` without text that paints a small box (a dot, a square, an image).
 * - `image`: a small `img` or inline `svg`, or an empty element that shows an icon-font glyph.
 * - `shape`: a small empty element that paints a box.
 * - `list-item`: the element is displayed as a list item with a visible marker, outside a list.
 */
export interface ListMarker {
  kind: 'pseudo-text' | 'pseudo-counter' | 'pseudo-shape' | 'image' | 'shape' | 'list-item';
  /** The generated text, for `pseudo-text`; empty otherwise. */
  text: string;
  /** Two markers with the same key look the same: the same content, image or shape. */
  key: string;
}

/** One line of a block: the text between two forced line breaks, or all of it. */
export interface ListLine {
  /** The start of its text, white space collapsed, cut to `lineStartChars`. */
  start: string;
  /** Its first painted line, page coordinates. */
  box: Box;
  marker?: ListMarker;
  /** The end of its text, white space collapsed: the last `lineEndChars` characters. Absent: `start` is all of it. */
  end?: string;
  /** Colour of the first characters of the line, as `TextStyle.color`: of a bullet that is a character of the text. */
  startColor?: string;
  /**
   * For a line that holds a colon (`keySeparatorChars`): the style signatures of the text before
   * the first one, in order of first use, one per line of this string. A name set in one style
   * gives one signature.
   */
  keyStyle?: string;
}

/**
 * A block of visible text as the lists check needs it: read as `TextBlock` is, with the lines
 * that forced line breaks cut it into and its place among the elements of the page.
 */
export interface ListBlock {
  selector: string;
  /** Same convention as FocusStop.frame. */
  frame: string;
  tag: string;
  text: string;
  chars: number;
  words: number;
  box: Box;
  /** Painted lines. */
  lines: number;
  firstLine: Box;
  style: TextStyle;
  contexts: TextContext[];
  /** All of its text is inside an element the accessibility tree exposes as a list or a description list. */
  inList: boolean;
  /** The accessibility tree exposes it as a heading. */
  heading: boolean;
  /** Text direction of its element is right to left. */
  rtl: boolean;
  /** The pointer over its element is the hand of a link (`cursor: pointer`, its own or inherited): something that is clicked. */
  clickable?: boolean;
  /**
   * Its element and the ancestors of that element in its document, innermost first, at most
   * `maxAncestorLevels` of them, as pairs of numbers: the position of the element among the
   * elements of the page in document order, and the position of the last element inside it.
   * An element holds another when the position of the other lies between its two numbers.
   */
  chain: number[];
  /** At least one: the block itself when it has no forced line break. */
  segments: ListLine[];
}

/** One of several sibling elements of one shape. */
export interface ListGroupItem {
  /** Border box, page coordinates. */
  box: Box;
  /** Position of the element and of the last element inside it (see `ListBlock.chain`). */
  ord: number;
  end: number;
  /** Blocks of visible text that have text inside it. */
  blocks: number;
  /** Characters of visible text inside it, white space apart. */
  chars: number;
  /** Links inside it, itself included. */
  links: number;
  /** Characters of its visible text that are inside a link, and inside a button. */
  linkChars: number;
  buttonChars: number;
  /** Form fields inside it. */
  controls: number;
  /** Images and other graphics inside it. */
  graphics: number;
  /** Lists and tables inside it. */
  lists: number;
  /**
   * The first heading inside it that the accessibility tree exposes: `link` when that heading is
   * or holds a link (the title of a teaser or of a search result), `plain` when it is not (the
   * heading of a section), `none` when there is no heading.
   */
  heading: 'none' | 'plain' | 'link';
  /** The start of its text, cut to `itemTextMaxChars`. */
  text: string;
}

/**
 * Consecutive sibling elements with the same DOM shape, outside list semantics, tables, grids
 * and composite widgets. Whether they are laid out as a series is worked out in core, from `items`.
 */
export interface ListGroup {
  /** Their parent; the first of them when the parent holds more than one such series. */
  selector: string;
  frame: string;
  /** Position of the parent and of the last element inside it. */
  ord: number;
  end: number;
  /** How many siblings the series has; `items` holds at most `maxGroupItems` of them. */
  count: number;
  /** Characters of visible text that the parent holds itself, outside any child element: separators between links, or the prose the links are part of. */
  looseChars: number;
  items: ListGroupItem[];
  /** Inside `nav` or a navigation role. */
  navigation: boolean;
  /** Handle for the capture. */
  target: number;
}

/**
 * A `ul`, `ol` or `menu` that is of interest.
 * - `presentational`: its role was removed with `role="presentation"` or `role="none"` and the
 *   accessibility tree does not expose it as a list.
 * - `unstyled`: it is exposed as a list, has no explicit role, shows no marker on any item and
 *   is outside navigation: the lists Safari does not expose as lists (see the README).
 */
export interface ListElement {
  kind: 'presentational' | 'unstyled';
  selector: string;
  frame: string;
  tag: string;
  box: Box;
  /** Position of the element among the elements of the page. */
  ord: number;
  /** Visible `li` children. */
  items: number;
  /** Those that show a marker: displayed as list items, with a list style, in a colour that paints, with room for it. */
  markers: number;
  /** All of those markers are inside the box of their item (`list-style-position: inside`). */
  markersInside: boolean;
  /** Handle for the capture. */
  target: number;
}

/** The capture of something the lists check reports. */
export interface ListCapture {
  /** Crop id, or null when it could not be captured. */
  crop: string | null;
  /** Where the reported content is inside the capture, CSS pixels from its top-left corner. */
  cropTarget?: Box;
  /** Other content lay over it (a banner, a dialog). */
  covered?: boolean;
}

export interface ListSurvey {
  /** Visible text blocks in document order, frames in place. */
  blocks: ListBlock[];
  /** Blocks found, including those beyond `headings.maxBlocks`. */
  totalBlocks: number;
  groups: ListGroup[];
  /** Series found, including those beyond `maxGroups`. */
  totalGroups: number;
  /**
   * Elements with `minRepeatedItems` children or more: how many were looked at for series of
   * siblings of one shape (at most `maxGroupParents`, in document order), and how many there are.
   */
  parents: number;
  totalParents: number;
  lists: ListElement[];
  /** `ul`, `ol` and `menu` of interest found, including those beyond `maxListElements`. */
  totalLists: number;
  /** Elements the accessibility tree exposes as a list or a description list, with visible content. */
  exposedLists: number;
  /**
   * False when the accessibility tree of a document the survey looked into could not be read:
   * what has list semantics is then not known, and nothing is reported above `info`.
   */
  axComplete: boolean;
  /**
   * Selectors of the elements that hold what is reported, by their position (`ListBlock.chain`).
   * Filled by the collector for the elements core names (`ListCandidate.container`).
   */
  containers: Record<string, string>;
  /** Captures, by `ListCandidate.key`. */
  captures: Record<string, ListCapture>;
}

/**
 * What a form control is to the grouping check.
 * - `radio`: the role radio. `checkbox`: the roles checkbox and switch.
 * - `field`: a control that takes a value: text fields, `select`, comboboxes, spin buttons, date and time inputs.
 */
export type GroupingControlKind = 'radio' | 'checkbox' | 'field';

/**
 * A form control the accessibility tree exposes, with what the tree says about it. Role, name
 * and description are those Chrome computed (`Accessibility.getFullAXTree`), never worked out
 * from attributes here. Boxes are CSS pixels in page coordinates.
 */
export interface GroupingControl {
  selector: string;
  /** Same convention as FocusStop.frame. */
  frame: string;
  /** Position among the elements of the page, in document order, frames in place. Text blocks use the same scale (`GroupingBlock.at`). */
  ord: number;
  /** The element and its ancestors in its document, innermost first: position, and position of the last element inside, for each (`maxAncestorLevels` at most). */
  chain: number[];
  /** What shows of it: its own box, or that of its labels when the control itself is visually hidden (`proxied`). */
  box: Box;
  /** The box is that of the labels: a native control hidden under a styled label. */
  proxied?: boolean;
  kind: GroupingControlKind;
  /** Role in the accessibility tree, as Chrome names it (`radio`, `textbox`, `combobox`, `Date`, …). */
  role: string;
  /** Tag, and for `input` its type: `input:radio`, `select`, `div`. For messages only. */
  element: string;
  /** Accessible name, white space collapsed, cut to `maxNameChars`. Empty when it has none. */
  name: string;
  /** Accessible description, likewise. */
  description: string;
  /**
   * What ties a radio or a checkbox to its set, when markup says so: form and `name` attribute of
   * a native control, or the element with the role radiogroup around a custom one. Empty otherwise.
   */
  setKey: string;
  /** Form owner, as an index that only tells forms apart; -1 for none. */
  form: number;
  /** The region (`headings.regionSelector`) the control is in, as for text blocks; empty for none. */
  region: string;
  /** Position of the table cell the control is in, or -1. */
  cell: number;
  /** Inside a composite widget: a toolbar, a menu, a tab list, a tree, a grid, a list box. */
  inWidget: boolean;
  /** Computed font size of the control, CSS px: the unit of the distances that are measured from it. */
  fontSize: number;
  rtl: boolean;
  /** The role is switch: an on/off setting, which stands for itself more often than an option of a set does. */
  switch?: boolean;
}

/** An element the accessibility tree exposes as a container that can name what it holds. */
export interface GroupingGroup {
  selector: string;
  frame: string;
  /** Position of the element, and of the last element inside it. A control is inside when its position is between the two. */
  ord: number;
  end: number;
  /** `group` (also what a `fieldset` is), `radiogroup`, or one of `region`, `form`, `dialog`, `alertdialog`, `tabpanel`, `search`. */
  role: string;
  /** Accessible name, as for controls. Empty when it has none: an unnamed group names nothing. */
  name: string;
}

/** A block of visible text, as the grouping check needs it. Read by the same walk as for headings. */
export interface GroupingBlock {
  frame: string;
  /** Where the text starts among the elements of the page: it comes before every control whose `ord` is at least this. */
  at: number;
  /** Where it ends: it comes after every control whose `ord` is less than this. */
  end: number;
  text: string;
  chars: number;
  words: number;
  lines: number;
  box: Box;
  style: TextStyle;
  contexts: TextContext[];
  /** Level when the accessibility tree exposes the block as a heading, else 0. */
  heading: number;
  /** Controls (indexes into `controls`) this text is the label of: through `label`, or as a target of `aria-labelledby`. */
  labels: number[];
  /** Group (index into `groups`) this text names: its `legend`, or a target of its `aria-labelledby`; -1 for none. */
  group: number;
  /** A target of `aria-describedby` of a control or a group. */
  describes: boolean;
  /** Inside a `label` that belongs to a control which is not among `controls` (not exposed, or beyond the limit). */
  otherLabel: boolean;
  /** Inside a control: the text of a custom radio, the value of an editable box. */
  inControl: boolean;
  /** The text of a button that opens and closes something (`aria-expanded`), or of a `summary`. */
  disclosure: boolean;
  /**
   * Some of the text is tied to nothing: it is no label of a control, names and describes
   * nothing, and is not inside a control. Only such text can be the visible label of a set.
   */
  free: boolean;
  /**
   * That part of the text, when the block also holds text that is tied to something: in
   * "Gender: ( ) Male ( ) Female" set as one line, with "Male" and "Female" in labels, it is "Gender:".
   */
  freeText?: string;
}

/** The capture of something the grouping check reports. */
export type GroupingCapture = ListCapture;

export interface GroupingSurvey {
  /** In document order. */
  controls: GroupingControl[];
  /** Controls found, including those beyond `maxControls`. */
  totalControls: number;
  groups: GroupingGroup[];
  blocks: GroupingBlock[];
  /** Blocks found, including those beyond `headings.maxBlocks`. */
  totalBlocks: number;
  /**
   * False when the accessibility tree of a document the survey looked into could not be read, or
   * held more controls or groups than can be marked: names and groups are then not known in full,
   * and nothing is reported above `info`.
   */
  axComplete: boolean;
  /** Selectors of the elements that hold what is reported, by their position. Filled by the collector for the elements core names. */
  containers: Record<string, string>;
  /** Captures, by `GroupingCandidate.key`. */
  captures: Record<string, GroupingCapture>;
}

export interface Snapshot {
  environment: Environment;
  /** Present when the grouping check was collected. */
  grouping?: GroupingSurvey;
  /** Present when the lists check was collected. */
  lists?: ListSurvey;
  /** Present when the headings check was collected. */
  headings?: HeadingSurvey;
  /** Present when the focus-indicator check was collected. */
  focus?: FocusWalk;
  /** Present when the icon-contrast check was collected. */
  icons?: IconSurvey;
  nodes: SnapshotNode[];
  axTree: AxNode[];
  screenshots: {
    tiles: Screenshot[];
    /** On-demand clips, keyed by the crop id that findings reference in `evidence.crops`. */
    clips: Record<string, Screenshot>;
  };
}

export interface Evidence {
  /** Crop ids (keys of `Snapshot.screenshots.clips`); reporters turn them into file paths. */
  crops: string[];
  /** Measured colours as #rrggbb, keyed by role (e.g. "indicator", "outer"). */
  colors: Record<string, string>;
  /** Measured contrast ratios, keyed by role. */
  ratios: Record<string, number>;
  /** e.g. "forced", "authorModified". */
  flags: string[];
  /** Other measured values and what was read from the page, keyed by name (font size, word count, text). */
  values?: Record<string, string | number | boolean>;
}

export type Verdict = 'yes' | 'no' | 'unsure';

/**
 * Why a call to a model gave no usable vote. A fixed list of codes: nothing a server answered and
 * no error message is ever copied into a finding, so neither a key nor text of an endpoint can end up there.
 * - `timeout`: no answer within `timeoutMs`.
 * - `network`: the request did not get through (connection refused, a redirect, a broken response).
 * - `http`: an HTTP status that is not 2xx.
 * - `invalid-output`: the answer is not the JSON object that was asked for.
 * - `refusal`: the model declined, or a content filter cut the answer.
 * - `truncated`: the answer stopped at the token limit.
 * - `too-large`: the answer is longer than `maxResponseChars`.
 * - `stopped`: nothing was sent for this vote, because adjudication of the page had been stopped
 *   (`maxConsecutiveFailures` calls in a row got no answer, or `pageBudgetMs` ran out).
 */
export type AiProblem = 'timeout' | 'network' | 'http' | 'invalid-output' | 'refusal' | 'truncated' | 'too-large' | 'stopped';

/**
 * What a model said about a finding. Present only when a model was asked. The measurements of
 * the finding (`evidence`) are never changed by it, and `statusBefore` keeps what deterministic
 * code had reported.
 */
export interface AiEvidence {
  /** Label of the provider, as configured (`providerLabel`), or the kind of adapter. Never a URL. */
  provider: string;
  /** Model name exactly as configured. */
  model: string;
  /** Version of the instructions and of the question that were sent. */
  promptVersion: string;
  /** One entry per vote taken. A vote that failed counts as `unsure`. */
  votes: Verdict[];
  /** All votes agree on `yes` or on `no`, with high confidence: that. Anything else: `unsure`. */
  verdict: Verdict;
  /**
   * `high` only when every vote was given with high confidence and they agree. It is a word the
   * model picks from two, not a number: no number is taken from a model.
   */
  confidence: 'high' | 'low';
  /** The model's own words, cut to `maxRationaleChars`. Untrusted text: display it escaped, never act on it. */
  rationale: string;
  /** Status reported by deterministic code, before the verdict was applied. */
  statusBefore: Status;
  /** What was sent: the context alone, or the context with the capture. */
  inputs: 'text' | 'text+image';
  /**
   * True when the verdict was read from the verdict cache and no model was asked in this run.
   * A cache is a local file that anyone can edit: a verdict that came from it is only as good as
   * that file. With `timestamp`, the one thing in a result that differs between a first run and
   * the next one on an unchanged page.
   */
  fromCache: boolean;
  /** Why votes failed, when some did; sorted, without repeats. */
  problems?: AiProblem[];
}

export interface Finding {
  /** Stable fingerprint, see fingerprint.ts. */
  id: string;
  check: CheckId;
  /** The rule that fired, namespaced by check: "focus-indicator/no-visible-change". */
  rule: string;
  status: Status;
  /** Null only for inventory findings that relate to no success criterion. */
  wcag: WcagRef | null;
  selector: string;
  /** Frame id; empty string for the main frame. */
  frame: string;
  box: Box | null;
  evidence: Evidence;
  /** Absent when no model was involved. */
  ai?: AiEvidence;
  message: string;
  help: string;
}

/** A finding before its fingerprint is computed. */
export type FindingDraft = Omit<Finding, 'id'> & {
  /**
   * Takes the place of `rule` in the fingerprint, for a check that reports one thing under two
   * rule names depending on its status (a heading candidate): the id then survives the change.
   * Not part of the finding.
   */
  fingerprintRule?: string;
};

export interface Check {
  id: CheckId;
  /** Pure: same snapshot and config give the same findings. */
  evaluate(snapshot: Snapshot, config: Config): FindingDraft[];
}

export interface FocusConfig {
  /**
   * Device pixels per CSS pixel while measuring. At 2, a 1 CSS px line is two device pixels
   * wide, so it has pixels of its true colour and not only anti-aliased ones.
   */
  deviceScaleFactor: number;
  /** Margin captured around the element (and its labels). Larger outline offsets fall back to the viewport diff. */
  clipMarginCssPx: number;
  /** The Tab walk stops after this many elements. */
  maxTabStops: number;
  /** At most this many unreached focusable elements are measured with a forced state. */
  maxForced: number;
  /** Tab presses spent inside one cross-origin iframe before the walk moves focus past it. */
  maxTabsInOpaqueFrame: number;
  /**
   * A capture may differ by this many pixels, per side, from its clip size times the scale:
   * Chrome rounds the edges of a clip to device pixels. Beyond that, the scale is worked out from
   * the capture itself.
   */
  captureSizeTolerancePx: number;
  /** Animation frames to wait after each state change before capturing. */
  settleFrames: number;
  /** Upper bound for that wait, for pages where animation frames do not fire. */
  settleTimeoutMs: number;
  /** Longest wait for web fonts before the walk starts. */
  fontsTimeoutMs: number;
  /**
   * Longest wait for a document: for one that is still being parsed when the scan starts, and
   * for the one the page went to while it was being read, before it is read again from the start.
   */
  navigationTimeoutMs: number;
  /** CIEDE2000 difference above which a pixel counts as changed. Around 1 is just noticeable. */
  diffDeltaE: number;
  /** Changed regions smaller than this many square CSS pixels are discarded as noise. */
  minComponentAreaCssPx2: number;
  /** Changed regions measured per element, largest first. */
  maxComponents: number;
  /** Skipped next to an indicator before sampling adjacent colours: blended edge pixels. */
  adjacentGapCssPx: number;
  /** Width of the band sampled for adjacent colours. Kept under a 2px outline-offset. */
  adjacentBandCssPx: number;
  /** Colours closer than this (CIEDE2000) are the same colour when looking for dominant ones. */
  clusterDeltaE: number;
  /** A colour inside an indicator is considered only above this share of it. */
  minIndicatorShare: number;
  /** Below that share, a colour still counts if it reaches this share and forms a solid block (a bar, a ring). */
  minorPartMinShare: number;
  /** Side of that solid block. */
  minorPartSolidCssPx: number;
  /** An adjacent colour is considered only above this share of the sampled band. */
  minAdjacentShare: number;
  /** WCAG 1.4.11. */
  contrastThreshold: number;
  /** From here up to the threshold a low ratio is `likely`, not `fail`: absorbs anti-aliasing error. */
  likelyBandFloor: number;
  /** A changed region thicker than this in both directions, and covering its box, is a fill. */
  strokeMaxThicknessCssPx: number;
  /** Share of its bounding box a region must cover to be a fill. */
  fillMinCoverage: number;
  /** An unmodified browser indicator stays within this distance of the element box. */
  defaultRingMaxCssPx: number;
  /** Points per side of the grid sampled for 2.4.11. */
  obscuredGrid: number;
  /**
   * Points per side of the grid hit-tested from the top document before the captures, to find
   * content over the element that the 2.4.11 sampling cannot see (see FocusStop.possiblyCovered).
   */
  coverGrid: number;
  /**
   * Alpha of a background colour, and cumulated opacity of an element and its ancestors, from
   * which fixed or sticky content counts as opaque. Only opaque content can `fail` 2.4.11.
   */
  opaqueCoverMinAlpha: number;
  /** Cumulated opacity at or below which covering content is invisible and ignored. */
  invisibleCoverMaxOpacity: number;
  /** Box movement below this is not a geometry change. */
  geometryToleranceCssPx: number;
}

export interface IconConfig {
  /** At most this many controls are captured and measured, in document order. */
  maxCandidates: number;
  /** Margin captured around the control. */
  clipMarginCssPx: number;
  /** Controls smaller than this on either side are not looked at (visually hidden inputs, 1px links). */
  minControlSizeCssPx: number;
  /**
   * A graphic larger than this on either side is not an icon (a linked picture, a logo, a card
   * that is one link) and is left out.
   */
  maxGraphicSizeCssPx: number;
  /**
   * A text node or pseudo-element whose first font family matches this pattern (case-insensitive)
   * is an icon-font glyph even when its characters are letters (ligature icon fonts). Characters
   * of the Private Use Areas are glyphs whatever the font.
   */
  iconFontFamilyPattern: string;
  /**
   * A control whose class, or whose parent's class, matches this pattern (case-insensitive) may
   * be inactive without saying so with `disabled` or `aria-disabled`. Inactive controls are exempt.
   */
  inactiveHintPattern: string;
  /**
   * A control or graphic whose class, id, name or file name matches this pattern
   * (case-insensitive) may be a logotype, which is exempt.
   */
  logoHintPattern: string;
  /**
   * The accessible name of a link in the page header (`header`, `role="banner"`) matching this
   * pattern (case-insensitive) marks it as the home link, where a logotype usually is.
   */
  homeLinkNamePattern: string;
  /** Text clipped to less than this on either side is not visible text. */
  minVisibleTextCssPx: number;
  /** Wrappers of a field, up to this many levels, whose edges may be its boundary. */
  boundaryWrapperLevels: number;
  /** A wrapper counts only if it is at most this much taller than the field, above and below together. */
  boundaryWrapperSlackCssPx: number;
  /** Points per side of the grid hit-tested to make sure nothing else covers the graphic. */
  coverGrid: number;
  /** A graphic, or a part of one, smaller than this on either side paints nothing worth measuring; so does text of a smaller font size. */
  minPaintedSizeCssPx: number;
  /**
   * Slack when two boxes are compared for containment or equal size: an element laid over a
   * field counts as around it within this, and a box is untransformed when its layout size and
   * its size on screen agree within this.
   */
  boxToleranceCssPx: number;
  /** How far inside each side of a boundary control the point lies that is hit-tested for content in front of it. */
  boundaryProbeInsetCssPx: number;
  /** A control whose box moved by more than this between measuring it and capturing it is captured again. Sub-pixel differences are rounding. */
  sameBoxToleranceCssPx: number;
  /**
   * CSS properties (pattern on the property name) through which an author changes what the
   * boundary of a native control looks like. A native control with none of them declared by an
   * author rule has the browser default look, which is exempt.
   */
  boundaryAuthorPropertyPattern: string;

  /** Colours closer than this (CIEDE2000) are the same colour. */
  clusterDeltaE: number;
  /** Skipped between the graphic box and the band sampled for its background. */
  backgroundGapCssPx: number;
  /** Width of that band. */
  backgroundBandCssPx: number;
  /** The background is one colour when its most common colour reaches this share of the band. */
  uniformBackgroundMinShare: number;
  /** On a background of several colours, the icon is compared with those above this share of the band. */
  minBackgroundShare: number;
  /** Below this share of the graphic box, what differs from the background is noise, not a graphic. */
  minInkShare: number;
  /** A colour is a part of the icon (not anti-aliasing residue) from this share of its ink. */
  minPartShare: number;
  /**
   * Below `minPartShare`, a colour is still a part from this share if it forms a solid block: a
   * small detail can be the part that matters (a dark glyph on a pale disc).
   */
  minSolidPartShare: number;
  /**
   * A colour within this distance (Euclidean, 8-bit RGB) of the line between two other colours
   * is their anti-aliasing blend, not a colour of its own.
   */
  blendToleranceRgb: number;
  /**
   * A colour read from pixels is trusted as a true colour only if this share of its pixels is
   * interior (surrounded by pixels of the graphic). Strokes of about 1 CSS px and less have no
   * interior at the capture scale: every pixel of theirs may be blended with the background.
   */
  minInteriorShare: number;
  /**
   * A colour that forms a solid square of this side is a flat area of its own even when it lies
   * between two other colours (a gradient, a lighter tone of the same hue). Anti-aliasing never does.
   */
  flatBlockCssPx: number;
  /** Fewest interior pixels (see `minInteriorShare`) for a colour to be trusted, whatever its share. */
  minInteriorPixels: number;
  /** Smallest side of the solid square of `flatBlockCssPx`, in device pixels, whatever the scale: anti-aliasing can fill a smaller one. */
  flatBlockMinPx: number;
  /** More parts than this, and the graphic is a picture rather than an icon. */
  maxParts: number;
  /** Share of the ink that belongs to no part and no blend above which the graphic is a picture. */
  complexResidualShare: number;
  /**
   * A declared colour is taken as the colour of the icon when pixels of it are found, or when at
   * least this share of the ink is a blend of it with the background (strokes too thin to show it).
   */
  declaredBlendMinShare: number;
  /** WCAG 1.4.11. */
  contrastThreshold: number;
  /** From here up to the threshold a low ratio is `likely`, not `fail`. */
  likelyBandFloor: number;

  /** How far outside a boundary box its edge is looked for (outer shadows, rings). */
  boundaryReachCssPx: number;
  /** How far inside. Kept small so that the content of the control stays out. */
  boundaryDepthCssPx: number;
  /** Share of each side, around its middle, that is sampled: stays clear of rounded corners. */
  boundarySideShare: number;
  /** Shortest length sampled on a side, whatever its share. */
  boundaryMinSideCssPx: number;
  /** A colour counts on an edge from this share of the sampled zone: a 0.5px line still does. */
  boundaryMinShare: number;
  /**
   * Colours on an edge closer than this (CIEDE2000) are one colour. Smaller than `clusterDeltaE`:
   * a pale fill next to a white page must stay two colours, or a line is compared with their mix.
   */
  boundaryClusterDeltaE: number;
  /** Times a control is captured again when its box moved between measuring it and capturing it. */
  captureAttempts: number;
}

export interface HeadingsConfig {
  /** At most this many text blocks are read from the page, in document order. */
  maxBlocks: number;
  /** Text of a block kept in the snapshot, in characters. */
  maxTextChars: number;
  /** At most this many candidates are reported and captured: likely ones first, then in document order. */
  maxCandidates: number;
  /** At most this many contradictions between heading levels are reported and captured, in document order. */
  maxInversions: number;
  /** Text smaller than this on either side, once clipped by its containers, is not visible text. */
  minVisibleTextCssPx: number;
  /** Text of a smaller font size paints nothing worth reading. */
  minFontSizeCssPx: number;
  /**
   * Elements that bound a region (CSS selector). The visual rank and the level of two headings are
   * compared only inside one region, and text of two regions never shares a line.
   */
  regionSelector: string;
  /** Margin captured to the left and right of a candidate. */
  clipMarginCssPx: number;
  /** Captured above a candidate, to show what it follows. */
  clipAboveCssPx: number;
  /** Captured below a candidate, to show what it heads. */
  clipBelowCssPx: number;
  /** Text of the block before a candidate that is given as context (`HeadingCandidate.context.textBefore`), in characters. */
  contextBeforeMaxChars: number;
  /** Text of the block after a candidate that is given as context and as evidence (`textAfter`, `followedBy`), in characters. */
  contextAfterMaxChars: number;
  /** Text of a block quoted in the message of a finding, in characters. */
  messageTextMaxChars: number;

  /**
   * Fewest characters (white space apart) in the most common style of a pool of text for that
   * style to be taken as the body style. Under it inside `main`, the whole page is measured; under
   * it on the whole page, the body style is not trusted and no candidate is above `info`
   * (`lowText`).
   */
  baselineMinChars: number;
  /** `main` sets the body style only if it holds at least this share of the plain text of the page. */
  baselineMainMinShare: number;

  /**
   * A block is larger than body text from this ratio of font sizes. Set well above the ratio
   * that tells two sizes apart: text slightly larger than body text and no bolder is usually a
   * lead paragraph or a tagline (seen on real pages), not a heading.
   */
  minSizeRatio: number;
  /** A block is bolder than body text from this difference of font weights. */
  minWeightDelta: number;
  /** Bold text counts as prominent from this ratio to the body size: bold text of body size, not bold small print. */
  boldMinSizeRatio: number;
  /** The same for bold text in capitals (`text-transform: uppercase`), which is commonly set smaller. */
  uppercaseBoldMinSizeRatio: number;
  /** Longest heading, in words. Longer text is body text however it is styled. */
  maxWords: number;
  /** Longest heading, in characters that are not white space: the limit for text without spaces between words. */
  maxChars: number;
  /** Longest heading, in painted lines. */
  maxLines: number;
  /** Tighter word limit for text that is only bolder than body text: not larger, and not styled as a real heading. */
  maxBoldOnlyWords: number;
  /** Share of the characters of a block that must have its style: under it the block mixes styles. */
  uniformStyleMinShare: number;
  /** From this many forced line breaks, a block is lines of text (an address), not a heading. */
  maxBreaks: number;
  /**
   * Text ending like this (pattern, Unicode flag) reads as a sentence or a clause, not as a heading.
   * Question and exclamation marks are left out: headings do end with them.
   */
  sentenceEndPattern: string;
  /** Text ending like this introduces what follows (a lead-in). Whether it heads it is a judgement. */
  leadInEndPattern: string;
  /** Text opening like this is a quotation. */
  quoteStartPattern: string;
  /** Share of digits among letters and digits from which text is a number (a price, a statistic, a date). */
  numericMinDigitShare: number;
  /**
   * Text that starts with a number and has at most this many words may be a statistic
   * ("15 years", "3x faster") as well as a title ("2026 roadmap"): it is held back, and left to
   * a judgement.
   */
  statisticMaxWords: number;
  /**
   * Text opening like this is numbered, not a statistic: "1. Scope", "2) Method", and a number
   * of one or two digits, with or without parts after dots, before a capital letter
   * ("1 Introduction", "1.2 Requirements"). Scripts without capitals only have the first form.
   */
  ordinalStartPattern: string;
  /**
   * From this many blocks with the same text in the same style on a page, each of them is a label
   * (a badge under every product, "Read more" over every teaser), not a heading.
   */
  repeatedTextMinCount: number;
  /**
   * Text that is only bolder than body text heads little when what follows it is one block of at
   * most this many lines...
   */
  shortFollowerMaxLines: number;
  /** ...and at most this many words. Text no longer than the candidate itself always counts as little. */
  shortFollowerMaxWords: number;
  /**
   * True: one short line that ends like a sentence (`sentenceEndPattern`) is content, as a
   * paragraph of several lines is, so bold text over it can be `likely`. That keeps titles over
   * one-line paragraphs, and also the title of a callout or a name over one sentence. False: any
   * single short line under bold text holds it back, at the price of those titles (on the
   * mutation fixtures, 22 of 34 stripped headings are then `likely`, against 31).
   * Bold text smaller than body text is held back either way.
   */
  sentenceFollowerIsContent: boolean;
  /**
   * At most this many buttons or links that sit beside a candidate on its line (a "View all"
   * link at the end of the row of a title) are passed over to find what the candidate heads.
   */
  besideControlsMax: number;
  /**
   * Boxes of one style on one line inside one parent are one block of text when they are no
   * further apart than this many times the font size: the words of a title set as inline blocks
   * or flex items. Peers in a row (tabs, a menu) are set further apart.
   */
  mergeMaxGapEm: number;
  /**
   * A candidate is taken for a number when at least this share of the other blocks with its
   * exact style are numbers: "Free" among prices, "On request" among statistics.
   */
  peerDemotionMinShare: number;
  /** Fewest such look-alikes for that to apply. */
  peerDemotionMinPeers: number;
  /**
   * Two boxes are on one line when they overlap vertically by this share of the lower of the two.
   * Used for the painted lines of a block as well as for blocks that share a line.
   */
  sameLineMinOverlap: number;
  /**
   * Text before a candidate on its line, and no further from it than this many times its font
   * size, shares the line with it. Further away it is in another column.
   */
  sameLineMaxGapEm: number;
  /** Slack when boxes are compared: stacked, aligned, overlapping. */
  boxToleranceCssPx: number;
  /** Font sizes closer than this are one size. */
  sizeToleranceCssPx: number;
  /**
   * Open decision (section 10.3 of the brief): status of a heading level that contradicts the
   * visual order. `advisory` or `likely`; never `fail`.
   */
  inversionStatus: 'advisory' | 'likely';
  /** Status when the contradiction is extreme (both limits below). */
  extremeInversionStatus: 'advisory' | 'likely';
  /** A heading is visually above another from this ratio of font sizes. */
  inversionMinSizeRatio: number;
  /** Extreme: at least this ratio of font sizes... */
  extremeInversionMinSizeRatio: number;
  /** ...and at least this many levels apart. */
  extremeInversionMinLevelGap: number;
}

export interface ListsConfig {
  /** Characters kept from the start of each line of text, to look for a bullet or a number in. */
  lineStartChars: number;
  /** Characters kept from the end of each line of text, to tell a sentence from an item. */
  lineEndChars: number;
  /** Ancestors recorded for each text block. Two lines are sibling items only when the element that holds both is among them. */
  maxAncestorLevels: number;
  /** Ancestors of a line whose `::before` and list-item marker are looked at. */
  markerAncestorLevels: number;
  /** At most this many series of sibling elements of one shape are read from the page, in document order. */
  maxGroups: number;
  /** At most this many items of each such series are measured. */
  maxGroupItems: number;
  /**
   * At most this many elements with `minRepeatedItems` children or more are looked at for such
   * series, in document order. Each costs a look at its place in the page and at the box and
   * the shape of every child, which adds up on a page of tens of thousands of elements.
   */
  maxGroupParents: number;
  /** At most this many `ul`, `ol` and `menu` of interest are read from the page. */
  maxListElements: number;
  /** Elements whose accessibility role is marked in the page (lists, description lists) per document; beyond it the accessibility tree counts as not read. */
  maxAxMarks: number;
  /** At most this many findings above the inventory are reported: likely first, then advisory, then info, each in document order. */
  maxCandidates: number;
  /** At most this many real lists without markers are listed (`lists/list-style-none`). */
  maxUnstyledLists: number;
  /** At most this many captures are taken, in the order of the findings. */
  maxCaptures: number;
  /** Blocks of text named for one capture: beyond it, the capture shows the first ones. */
  maxTargetBlocks: number;
  /** Margin captured around what is reported. */
  clipMarginCssPx: number;
  /** Captured on top of that before and after lines of text, where a bullet that is not a character of the text stands. */
  clipMarkerRoomCssPx: number;
  /** Items quoted in a message and kept as evidence, and characters of each. */
  messageItems: number;
  itemTextMaxChars: number;
  /** Items given to a model as context. */
  contextMaxItems: number;

  /** An image, an icon or a drawn shape is a bullet from this size... */
  markerMinSizeCssPx: number;
  /** ...up to this size, on both sides. Larger, it is a picture beside text. */
  markerMaxSizeCssPx: number;
  /** A graphic is at the start of a line when it is on that line and no further before the text than this many times the font size. */
  markerMaxGapEm: number;
  /**
   * A marker outside its list item shows only when there is room for it before the item: this many
   * times the font size between the content of the item and whatever clips it, or the edge of the page.
   */
  markerRoomEm: number;
  /** Depth to which the tags of two sibling elements are compared to say they have one shape. */
  shapeDepth: number;

  /**
   * A line that opens like this (pattern, Unicode flag) starts with a bullet: a character whose
   * only common use at the start of a line is that. No letters, no words of any language.
   */
  bulletPattern: string;
  /**
   * A line that opens like this may start with a bullet: a hyphen, an en dash, an asterisk, a
   * middle dot, an angle. These also open asides, footnotes, the lines of a dialogue and quoted
   * replies, so such lines are `likely` only when there are `weakMinItems` of them and they read
   * as items (see `sentenceEndPattern`); otherwise they are held back as `info`. The em dash and
   * the horizontal bar are left out on purpose: they open the lines of a dialogue and little else.
   */
  weakBulletPattern: string;
  /** Among the weak bullets, the one that quotes a message in plain-text mail (">"): lines that open with it are `info`, however many. */
  quotePrefixPattern: string;
  /**
   * Among the bullets, those that are also icons: arrows, triangles, pictograms, dingbats and
   * emoji. A warning sign opens a message, an arrow a link, a triangle the title of a panel that
   * opens. Lines that open with one are `likely` from `symbolMinItems`, and not when each is
   * nothing but a link or something that is clicked.
   */
  symbolBulletPattern: string;
  /**
   * The text after a hyphen or an asterisk is a figure when it opens like this: a number and the
   * sign of a unit (degree, percent, currency, minutes and seconds), or a currency sign and a number.
   */
  figureStartPattern: string;
  /**
   * A line that ends like this ends as a sentence does: a full stop, a question mark, an
   * exclamation mark, an ellipsis, in any script, with or without a closing quotation mark or
   * bracket. Lines after a weak bullet are items when none ends like this...
   */
  sentenceEndPattern: string;
  /** ...or when every line but the last ends like this: the semicolon or the comma of an enumeration. */
  itemSeparatorEndPattern: string;
  /** A line that reads like this is an initial and a name, not an item with a letter before it: "A. Martin", "B. Nguyen, Lyon". */
  initialNamePattern: string;
  /** A bullet or a number is taken to stand alone in its box when the box holds no more characters than this. */
  loneMarkerMaxChars: number;
  /** Generated text of `::before` that is one of these characters is a bullet, with or without anything after it. */
  pseudoBulletPattern: string;
  /** Generated text made of these characters only is an icon-font glyph (Private Use Areas). */
  iconGlyphPattern: string;
  /** A line that opens like this is numbered with digits of any script: "1.", "2)", "(3)", "1.2.", "4/". The first group is the number. */
  numberPattern: string;
  /** Numbered with one letter of any script: "a)", "(b)", "C.". The first group is the letter, the second what closes it. */
  letterPattern: string;
  /** Numbered with a roman numeral: "ii.", "(IV)". The first group is the numeral. */
  romanPattern: string;
  /** Numbered with Chinese or Japanese numerals: "一、", "二．". The first group is the numeral. */
  ideographicNumberPattern: string;
  /** Numbered with an enclosed number: "①", "⑵". The first group is the character. */
  enclosedNumberPattern: string;
  /** Letters a sequence of letters starts with, in the scripts whose letters follow each other in Unicode. */
  firstLetters: string;
  /**
   * Letters that number items in an order that is not the order of their code points, each
   * sequence from its first letter: kana in gojūon and in iroha order, hangul.
   */
  letterSequences: string[];
  /** After a hyphen or an asterisk, text with at least this share of digits among letters and digits is a figure ("- 15"), not an item; so is text that opens as `figureStartPattern` says ("- 20 %"). */
  numericMinDigitShare: number;

  /** Fewest lines with a bullet or a number for a list. Section 5.4 of the brief: two. */
  minItems: number;
  /** Fewest lines for a list when every bullet is one of `weakBulletPattern`; fewer are `info`. */
  weakMinItems: number;
  /** Fewest lines for a list when every bullet is one of `symbolBulletPattern`; fewer are `info`. */
  symbolMinItems: number;
  /** Fewest lines for a list numbered with single letters followed by a full stop ("A. Lovelace" is also a name); fewer are `info`. */
  letterMinItems: number;
  /**
   * Fewest lines for a list when the bullet is an image or a drawn shape and not a character:
   * two links with the same icon before each are common outside lists; fewer are `info`.
   */
  graphicMinItems: number;
  /**
   * Lines with a bullet that each have at least this many blocks of text (the line included) head
   * a block of content each, as the title of a section or of a panel does with an icon before it:
   * `info`. Numbered lines are held back from two blocks (`itemsHeadText`).
   */
  headedItemMinBlocks: number;
  /** Slack when the start edges of lines or boxes are compared for alignment. */
  alignToleranceCssPx: number;
  /** Two boxes are on one row when they overlap vertically by this share of the lower of the two. */
  sameRowMinOverlap: number;

  /** Fewest sibling elements of one shape for a series. Section 5.4 of the brief: three. */
  minRepeatedItems: number;
  /** Gaps between the items of a series are constant when they differ by no more than this... */
  gapToleranceCssPx: number;
  /** ...or by no more than this share of the largest gap. */
  gapToleranceShare: number;
  /**
   * Links are a group of their own when their parent holds no more text of its own than this many
   * characters per link: a separator. With more, they are links inside a sentence.
   */
  linkSeparatorMaxChars: number;
  /** A series whose items hold more text than this (median, characters apart from white space) is prose in sections, not a series of items. */
  repeatedItemMaxChars: number;
  /**
   * Open decision (section 10.2 of the brief): status of a series of blocks of one shape whose
   * items are more than a link each: card grids and search results. `advisory` or `likely`;
   * never `fail`. Rows of links (navigation, breadcrumbs, tag clouds, pagination) are always `advisory`.
   */
  cardListStatus: 'advisory' | 'likely';

  /** Fewest pairs for a key-value layout. */
  keyValueMinPairs: number;
  /**
   * Longest name of a pair, in words. The names of a run of pairs also have to differ from each
   * other and, where the page tells, to be set in one style each and all in the same one: "Bob:"
   * that comes back is a speaker, a name in bold with a verb after it is an entry of a feed.
   */
  keyMaxWords: number;
  /** The characters that end a name on a line that reads name, colon, value: what the page reads the style of the name up to. */
  keySeparatorChars: string;
  /**
   * A line that reads like this is a name, a colon and a value. The first group is the name. The
   * colon has to be followed by white space, which leaves out hours ("09:30") and addresses of pages.
   */
  keyValueLinePattern: string;
  /** A name that ends like this needs no style of its own to be told from its value. */
  keyEndPattern: string;
}

/**
 * The adjudicator layer (section 6 of the brief): a model judges candidates that deterministic
 * code found. Nothing is sent anywhere while `provider` is `none`, which is the default.
 */
export interface AdjudicationConfig {
  /** `none`: no model is asked, and results are those of deterministic code alone. */
  provider: 'none' | 'openai-compatible';
  /** Base URL of the endpoint, up to and including the version segment (`.../v1`). No default: it is never guessed. */
  baseUrl: string;
  /** Model name, passed through as it is. No default. */
  model: string;
  /**
   * NAME of the environment variable that holds the API key; empty for an endpoint that takes
   * none. The key itself is never part of the configuration, of a report or of a message.
   */
  apiKeyEnv: string;
  /** Shown in findings as the provider; empty for the kind of adapter. */
  providerLabel: string;
  /**
   * Open decision (section 10.6 of the brief): whether an endpoint that is not on this machine
   * may be used. False, the conservative choice, refuses every host but loopback (`localhost`,
   * `127.0.0.0/8`, `::1`), so page text and captures cannot leave the machine by a
   * configuration slip. True allows another host over https only: plain http to another machine
   * is refused whatever this says.
   */
  allowRemote: boolean;
  /** Votes per candidate. Votes that disagree give `unsure`. */
  votes: number;
  temperature: number;
  /** Sent as `seed` when not null. Left out by default: two votes with one seed would only repeat each other. */
  seed: number | null;
  /** One request may take this long. At most 2147483647 (what a timer holds); a larger value is cut to that. */
  timeoutMs: number;
  /**
   * Adjudication of a page stops when this many requests in a row got no answer at all (`timeout`
   * or `network`): an endpoint that hangs or is gone is not asked about every remaining candidate.
   * The candidates that are left keep their status and say `stopped`. 0 never stops.
   */
  maxConsecutiveFailures: number;
  /**
   * Time allowed for the adjudication of one page, in milliseconds. It is checked before each
   * request: once it has run out nothing more is sent, and the candidates that are left keep
   * their status and say `stopped`. A request already in flight is not cut short, so a page can
   * take up to this plus `timeoutMs`. 0 sets no limit.
   */
  pageBudgetMs: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** A request that failed in a way worth trying again (network, 408, 429, 5xx) is sent again at most this many times. Timeouts are not retried. */
  maxRetries: number;
  /** Wait before the first retry; doubled for each further one, up to `retryMaxDelayMs`. */
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** Upper bound on requests for one page, retries included. Candidates beyond what it allows are left as they are. */
  maxCallsPerPage: number;
  /** Limit on the answer, sent in the field named by `maxTokensField`. */
  maxOutputTokens: number;
  /** `max_tokens` is what local servers document; `max_completion_tokens` is its replacement at OpenAI; `none` sends neither. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens' | 'none';
  /**
   * How JSON is asked for: `json_schema` (structured outputs), `json_object` (JSON mode) or
   * `none` (the instructions alone). The answer is validated the same way whichever is used.
   */
  responseFormat: 'json_schema' | 'json_object' | 'none';
  /**
   * Shape of an image part: `object` is `{"image_url": {"url": "data:..."}}`, as the chat
   * completions reference of OpenAI has it; `string` is `{"image_url": "data:..."}`, as the
   * examples of Ollama's compatibility page have it.
   */
  imageUrlShape: 'object' | 'string';
  /** False: only text is sent (a model without vision). */
  sendImages: boolean;
  /** A capture larger than this, in bytes, is not sent; the candidate is then judged from text. */
  maxImageBytes: number;
  /**
   * Whether a candidate without a capture (or with one that is not sent) is judged from its
   * context alone. False leaves such candidates as they are.
   */
  judgeWithoutImage: boolean;
  /** A longer answer is not read (`too-large`). */
  maxResponseChars: number;
  /** The rationale kept in a finding is cut to this. */
  maxRationaleChars: number;
  /** A verdict cache keeps at most this many verdicts; the oldest go first. */
  cacheMaxEntries: number;
  /** The target is outlined in the capture that is sent, in this colour (#rrggbb)... */
  outlineColor: string;
  /** ...with a line this wide... */
  outlineWidthCssPx: number;
  /** ...this far outside the box of the text, so that it covers none of it. */
  outlineGapCssPx: number;
  /**
   * Open decision of the owner. Status of a heading candidate that deterministic code reported as
   * `likely` and the model judged not to be a heading.
   * - `likely` (default): the finding stays in the tester's list, with the verdict recorded in
   *   `ai` and shown in the report. The brief only says that a judged candidate is `likely` at
   *   most; it does not say a model may take one off the list.
   * - `info`: the finding is lowered. Fewer candidates to go through, at a price: a page whose
   *   text persuades the model, or an edited cache file, then hides the page's own findings.
   */
  headingNoStatus: 'info' | 'likely';
  /**
   * The same open decision for the lists check: status of a series of lines with bullets or numbers
   * that deterministic code reported as `likely` and the model judged not to be a list. `likely`
   * (default) keeps it with the verdict recorded; `info` lowers it.
   */
  listNoStatus: 'info' | 'likely';
  /**
   * The same open decision for the grouping check: status of a set of controls under a visible
   * text that deterministic code reported as `likely` and of which the model judged that the text
   * is not the label of the set. `likely` (default) keeps it with the verdict recorded; `info` lowers it.
   */
  groupNoStatus: 'info' | 'likely';
}

/**
 * The grouping check (section 5.5 of the brief). Nothing it reports is ever a `fail`: the options
 * that hold a status take `advisory` or `likely` only.
 */
export interface GroupingConfig {
  /** At most this many form controls are read from the page, in document order. The survey says when there were more. */
  maxControls: number;
  /** At most this many controls, and this many named containers, are marked from the accessibility tree of one document. Beyond it nothing is above `info`. */
  maxAxMarks: number;
  /** Accessible names and descriptions are cut to this many characters. */
  maxNameChars: number;
  /**
   * At most this many targets of one `aria-labelledby` or `aria-describedby` are followed, this
   * many controls recorded for one label, and this many labels of one control shown in a capture.
   */
  maxLabelTargets: number;
  /** Ancestors recorded for each control, to name the element that holds a set. */
  maxAncestorLevels: number;
  /** At most this many findings are reported, `likely` first. */
  maxCandidates: number;
  /** At most this many captures are taken. */
  maxCaptures: number;
  /** Margin around what a capture shows, CSS px. */
  clipMarginCssPx: number;
  /** A control smaller than this on one side, CSS px, is taken as visually hidden: its labels stand for it. */
  minControlSizeCssPx: number;
  /** Radios or checkboxes that make a set. */
  minSetSize: number;
  /** A set with more controls than this is not looked at as one question (a long form of independent checkboxes). */
  maxSetSize: number;
  /** A text above a set is its possible label when no further above it than this, in font sizes of the text. */
  labelMaxGapEm: number;
  /**
   * A text beside a set, on the line of its first control, is its possible label when no further
   * from it than this, in font sizes. Wide on purpose: in a form laid out in two columns the
   * label stands a column away from its controls (seen on a real page: 8 font sizes), and
   * nothing else stands between the two in the document.
   */
  labelInlineMaxGapEm: number;
  /** A longer text is a paragraph and not a label: the set is then held back as `info`. */
  labelMaxChars: number;
  labelMaxLines: number;
  /**
   * A text that ends this way and has at least `labelSentenceMinWords` words is a sentence of
   * prose, and the set under it is held back as `info`: a full stop, an exclamation mark or an
   * ellipsis, of any script, with or without a closing bracket or quotation mark. A question
   * mark and a colon are left out on purpose. No word of any language.
   */
  labelSentenceEndPattern: string;
  labelSentenceMinWords: number;
  /** Hints and other text that is no label (a description, a link, a button), passed over between a set and the text before it, at most. */
  labelMaxSkipped: number;
  /**
   * A text above a set is taken for a hint of the control before it, and not for the label of
   * the set, when its distance to that control is less than this share of its distance to the set.
   */
  hintNearerShare: number;
  /** Vertical overlap, as a share of the lower of two boxes, from which they are on one row. */
  sameRowMinOverlap: number;
  /** Slack for comparisons of positions, CSS px. */
  toleranceCssPx: number;
  /**
   * A name is short when it has at most this many words and at most `shortNameMaxChars`
   * characters: "Yes", "No", "Not sure", a brand, a size. Short names say little without the
   * question they answer. No word of any language is involved.
   */
  shortNameMaxWords: number;
  shortNameMaxChars: number;
  /** The names of a set are ambiguous on their own when at least this share of them is short or empty. */
  ambiguousMinShare: number;
  /**
   * Stripped from names and from label texts before they are compared: white space, the colon
   * that ends a label, the asterisk of a required field.
   */
  nameTrimPattern: string;
  /**
   * A fieldset or a named group is the group of a set when it holds at most this many other
   * controls (a text field for "Other", say). With more, it is the group of a larger part of the
   * form, and a text of its own before the set still counts as that set's label.
   */
  groupExtraControlsMax: number;
  /** Fields side by side are the parts of one split field when no further apart than this, in font sizes of the field. */
  splitMaxGapEm: number;
  /** More fields than this in one row are a row of a grid, not a split field. */
  splitMaxParts: number;
  /** Two sections are reported when at least this many of their fields have the same accessible name. */
  duplicateMinShared: number;
  /**
   * Status when the visible label is a heading in the accessibility tree, or the button that
   * opens the set: a structure assistive technology does expose, although it is not tied to the
   * controls. `advisory` by default; `likely` reports such sets like the others.
   */
  headingLabelStatus: 'advisory' | 'likely';
  /** Names shown in a message, at most. */
  messageItems: number;
  /** Each cut to this many characters. */
  itemTextMaxChars: number;
  /** Names of controls handed to the adjudicator layer, at most. */
  contextMaxItems: number;
}

export interface Config {
  /** Checks to run, in any order. */
  checks: CheckId[];
  /**
   * Focus-indicator settings. Its capture settings (`deviceScaleFactor`, `settleFrames`,
   * `settleTimeoutMs`, `fontsTimeoutMs`) apply to every check that takes captures.
   */
  focus: FocusConfig;
  icon: IconConfig;
  headings: HeadingsConfig;
  /** The lists check reads text blocks as the headings check does, with the settings of `headings` for that part. */
  lists: ListsConfig;
  /** The grouping check reads text blocks as the headings check does, with the settings of `headings` for that part. */
  grouping: GroupingConfig;
  adjudication: AdjudicationConfig;
}

export interface ScanResult {
  tool: { name: string; version: string };
  url: string;
  /**
   * ISO 8601. The only field allowed to differ between two runs on the same page, with one
   * exception when a model is used: `ai.fromCache` of a finding.
   */
  timestamp: string;
  environment: Environment;
  findings: Finding[];
}
