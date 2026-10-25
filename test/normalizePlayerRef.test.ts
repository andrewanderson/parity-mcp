import { describe, expect, it } from "vitest";
import { normalizePlayerRef, parseLocalTimestamp } from "../src/data/normalize.js";

describe("normalizePlayerRef", () => {
  it("strips a terminal substitute marker", () => {
    const ref = normalizePlayerRef("Nadine Cann(S)");
    expect(ref.raw).toBe("Nadine Cann(S)");
    expect(ref.name).toBe("Nadine Cann");
    expect(ref.isSubstitute).toBe(true);
  });

  it("preserves a plain name exactly", () => {
    const ref = normalizePlayerRef("Nadine cann");
    expect(ref.raw).toBe("Nadine cann");
    expect(ref.name).toBe("Nadine cann");
    expect(ref.isSubstitute).toBe(false);
  });

  it("strips the marker from another substitute name", () => {
    const ref = normalizePlayerRef("Alisha Zhao(S)");
    expect(ref.name).toBe("Alisha Zhao");
    expect(ref.isSubstitute).toBe(true);
  });

  it("handles an empty string", () => {
    const ref = normalizePlayerRef("");
    expect(ref.name).toBe("");
    expect(ref.isSubstitute).toBe(false);
  });
});

describe("parseLocalTimestamp", () => {
  it("parses a real fixture timestamp", () => {
    const parsed = parseLocalTimestamp("3/15/2026, 6:13:40 PM");
    expect(parsed.timestampSec).not.toBeNull();
    expect(parsed.timestampLocal).toBe("3/15/2026, 6:13:40 PM");
  });

  it("handles an empty string", () => {
    const parsed = parseLocalTimestamp("");
    expect(parsed.timestampSec).toBeNull();
    expect(parsed.timestampLocal).toBe("");
  });
});
