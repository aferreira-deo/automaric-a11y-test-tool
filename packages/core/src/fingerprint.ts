import type { FindingDraft } from './types.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over UTF-16 code units. Not cryptographic; pure and dependency-free. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Identity of a finding across runs: which rule fired on which element.
 * Status, measurements and message are deliberately excluded, so a baseline entry
 * survives a change of measured ratio or a status downgrade.
 *
 * A check whose rule name follows the status gives one constant name in its place
 * (`FindingDraft.fingerprintRule`), so that the same holds for it.
 */
export function fingerprint(draft: Pick<FindingDraft, 'rule' | 'wcag' | 'frame' | 'selector'>): string {
  return fnv1a64([draft.rule, draft.wcag?.sc ?? '', draft.frame, draft.selector].join('\u0000'));
}
