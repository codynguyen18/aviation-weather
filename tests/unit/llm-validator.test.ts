import { describe, expect, it } from "vitest";

import type { SourceIndexEntry } from "@/lib/llm/context";
import { extractNumbers, parseCitations, validateReply } from "@/lib/llm/validator";

// The validator is the safety net between the model and the pilot: unknown
// citations, unsupported figures, and prohibited language must all fail.

const INDEX: SourceIndexEntry[] = [
  { tag: 1, sourceRecordId: "a", sourceType: "METAR", station: "KSTL", issuedAt: null, label: "METAR KSTL 03:51Z" },
  { tag: 2, sourceRecordId: "b", sourceType: "TAF", station: "KRKS", issuedAt: null, label: "TAF KRKS 18:20Z" },
];

const GROUNDING =
  "Segment 3: wind 270°/35 kt gusting 47 kt [src:2]. Visibility 10 sm, ceiling 8000 ft. " +
  "METAR KSTL 181451Z 27015G25KT 10SM SCT080 28/17 A2992";

describe("parseCitations / extractNumbers", () => {
  it("finds unique citation tags", () => {
    expect(parseCitations("see [src:1] and [src:2], again [src:1]")).toEqual([1, 2]);
  });
  it("strips thousands separators and citation tags from numbers", () => {
    expect(extractNumbers("cruise 10,500 ft [src:3]")).toEqual([10500]);
  });
});

describe("validateReply", () => {
  it("passes a grounded, cited, calm reply", () => {
    const r = validateReply({
      reply:
        "The Rock Springs TAF forecasts wind at 35 kt gusting 47 kt [src:2], which exceeds your 25 kt surface-wind limit.",
      groundingText: GROUNDING + " surface-wind limit 25 kt",
      sourceIndex: INDEX,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects citations that are not in the source index", () => {
    const r = validateReply({
      reply: "Winds are 35 kt [src:9].",
      groundingText: GROUNDING,
      sourceIndex: INDEX,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.kind === "unknown-citation")).toBe(true);
  });

  it("rejects figures with no citation at all", () => {
    const r = validateReply({
      reply: "Expect gusts to 47 knots on that leg.",
      groundingText: GROUNDING,
      sourceIndex: INDEX,
    });
    expect(r.problems.some((p) => p.kind === "no-citations")).toBe(true);
  });

  it("rejects numbers that appear in no source (hallucinated figures)", () => {
    const r = validateReply({
      reply: "Ceiling is 900 ft [src:1].",
      groundingText: GROUNDING,
      sourceIndex: INDEX,
    });
    expect(r.problems.some((p) => p.kind === "unsupported-number")).toBe(true);
  });

  it("allows honest rounding within ±0.5", () => {
    const r = validateReply({
      reply: "Visibility around 10 sm [src:1].",
      groundingText: "visibility 9.7 sm reported",
      sourceIndex: INDEX,
    });
    expect(r.problems.filter((p) => p.kind === "unsupported-number")).toHaveLength(0);
  });

  it("exempts small counters like segment ordinals", () => {
    const r = validateReply({
      reply: "Three of your segments are yellow; segment 4 is the worst [src:1]. It shows gusts of 47 kt [src:2].",
      groundingText: GROUNDING,
      sourceIndex: INDEX,
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    "It is safe to fly tonight.",
    "You could thread through the gap between cells near Rock Springs.",
    "You can outrun the storm if you leave now.",
    "Legally to fly VFR you are fine — no problem.",
    "This counts as your official weather briefing.",
  ])("flags prohibited language: %s", (reply) => {
    const r = validateReply({ reply, groundingText: GROUNDING, sourceIndex: INDEX });
    expect(r.problems.some((p) => p.kind === "prohibited-language")).toBe(true);
  });

  it("permits negated official-briefing statements", () => {
    const r = validateReply({
      reply: "Remember this is not an official weather briefing.",
      groundingText: GROUNDING,
      sourceIndex: INDEX,
    });
    expect(r.problems.filter((p) => p.kind === "prohibited-language")).toHaveLength(0);
  });
});
