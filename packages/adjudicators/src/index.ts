import type { CheckId, JsonValue, Png, Verdict } from '@a11y-vision/core';

/** Interface from the brief, section 6. Adapters arrive in M4. */
export interface Adjudicator {
  judge(input: {
    check: CheckId;
    /** Fixed per check, versioned. */
    question: string;
    /** Target outlined, plus context. */
    crops: Png[];
    /** Compact: text, accessibility subtree, style summary. */
    context: JsonValue;
  }): Promise<{ verdict: Verdict; rationale: string }>;
}
