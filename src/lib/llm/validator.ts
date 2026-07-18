import type { SourceIndexEntry } from "@/lib/llm/context";

// Post-generation validator (PLAN.md §12.4): deterministic checks that run on
// every model reply BEFORE the user sees it. The model is never trusted to
// self-certify; a reply that fails here is regenerated once and then replaced
// by the deterministic fallback card.

export interface ValidationProblem {
  kind: "unknown-citation" | "no-citations" | "unsupported-number" | "prohibited-language";
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  problems: ValidationProblem[];
}

const CITATION_RE = /\[src:(\d+)\]/g;

export function parseCitations(text: string): number[] {
  const tags: number[] = [];
  for (const m of text.matchAll(CITATION_RE)) tags.push(Number(m[1]));
  return [...new Set(tags)];
}

// Phrases the product must never emit (PLAN.md §12.4): implied go/no-go
// authority, convective-tactics advice, and reassurance language.
const PROHIBITED: { re: RegExp; label: string }[] = [
  { re: /\bsafe to (fly|go|depart|launch|continue|proceed)\b/i, label: "declares flight safe" },
  { re: /\bit(?: i|')s safe\b/i, label: "declares conditions safe" },
  { re: /\byou (?:will|'ll) be fine\b/i, label: "reassurance language" },
  { re: /\bshould be fine\b/i, label: "reassurance language" },
  { re: /\bno problem\b/i, label: "reassurance language" },
  { re: /\bdon'?t worry\b/i, label: "reassurance language" },
  { re: /\bgap between (?:the )?cells\b/i, label: "convective-gap tactics" },
  { re: /\bbetween the cells\b/i, label: "convective-gap tactics" },
  { re: /\b(?:thread|sneak|squeeze|shoot) (?:through|past|between)\b/i, label: "convective-gap tactics" },
  { re: /\bnarrow(?:ing)? corridor\b/i, label: "convective-gap tactics" },
  { re: /\b(?:beat|outrun|outclimb|race) the (?:storm|weather|cells?|front)\b/i, label: "convective-tactics advice" },
  { re: /\blegal(?:ly)? to fly\b/i, label: "legality ruling" },
  { re: /\bgo for it\b/i, label: "go/no-go authority" },
  { re: /\bcleared to\b/i, label: "clearance language" },
];

/** All numeric literals in a text, commas stripped ("10,500" -> 10500). */
export function extractNumbers(text: string): number[] {
  const cleaned = text
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(CITATION_RE, " "); // citation tags are not measurements
  const out: number[] = [];
  for (const m of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  return out;
}

export interface ValidatorInput {
  reply: string;
  /** Everything the model was shown: context text + all tool outputs. */
  groundingText: string;
  sourceIndex: SourceIndexEntry[];
}

export function validateReply(input: ValidatorInput): ValidationReport {
  const problems: ValidationProblem[] = [];
  const { reply, groundingText, sourceIndex } = input;

  // 1. Every cited tag must exist in the source index.
  const known = new Set(sourceIndex.map((s) => s.tag));
  for (const tag of parseCitations(reply)) {
    if (!known.has(tag)) {
      problems.push({ kind: "unknown-citation", detail: `[src:${tag}] is not in this briefing's source list` });
    }
  }

  // 2. A reply that states figures must cite something. (Pure prose answers —
  //    "what does yellow mean?" — legitimately carry no citations.)
  const replyNumbers = extractNumbers(reply);
  if (replyNumbers.length > 0 && parseCitations(reply).length === 0) {
    problems.push({ kind: "no-citations", detail: "reply contains figures but cites no sources" });
  }

  // 3. Numeric cross-check: every figure in the reply must appear in the
  //    grounding text (tolerance ±0.5 to allow honest rounding). Small
  //    counters (0-12) are exempt — segment counts and list ordinals.
  const grounded = extractNumbers(groundingText);
  for (const n of replyNumbers) {
    if (n >= 0 && n <= 12 && Number.isInteger(n)) continue;
    const supported = grounded.some((g) => Math.abs(g - n) <= 0.5);
    if (!supported) {
      problems.push({ kind: "unsupported-number", detail: `figure ${n} does not appear in any provided source` });
    }
  }

  // 4. Prohibited-language lint.
  for (const p of PROHIBITED) {
    const m = p.re.exec(reply);
    if (m) problems.push({ kind: "prohibited-language", detail: `${p.label}: "${m[0]}"` });
  }
  // "Official briefing" claims are fine only when negated in the same
  // sentence ("this is NOT an official weather briefing").
  for (const sentence of reply.split(/[.!?]/)) {
    if (
      /\bofficial (?:weather )?briefing\b/i.test(sentence) &&
      !/\b(?:not|isn'?t|no|never)\b/i.test(sentence)
    ) {
      problems.push({
        kind: "prohibited-language",
        detail: `claims official-briefing status: "${sentence.trim().slice(0, 80)}"`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}
