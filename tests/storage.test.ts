import { describe, expect, it } from "vitest";
import { mergeDiscoveryResults } from "@/lib/storage";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";

function record(overrides: Partial<Scholarship> = {}): Scholarship {
  return scholarshipSchema.parse({
    id: "https://agg-a.example/s1",
    name: "MEXT Scholarship 2027",
    provider: "Japanese Government (MEXT)",
    sourceUrl: "https://agg-a.example/s1",
    retrievalStatus: "retrieved",
    extractionStatus: "extracted",
    evidence: [
      {
        field: "applicationDeadline",
        quote: "Apply by 2026-11-30",
        sourceUrl: "https://agg-a.example/s1",
        retrievedAt: "2026-10-28T00:00:00.000Z",
      },
    ],
    ...overrides,
  });
}

describe("explicit-save merge with identity dedupe", () => {
  it("does not duplicate the same scholarship arriving from a different domain", () => {
    const previous = [record()];
    const sameScholarshipOtherDomain = record({
      id: "https://agg-b.example/totally-different-path",
      sourceUrl: "https://agg-b.example/totally-different-path",
      officialUrl: undefined,
      evidence: [],
    });
    const result = mergeDiscoveryResults(previous, [sameScholarshipOtherDomain]);
    expect(result.added).toBe(0);
    expect(result.merged).toHaveLength(1);
    // Existing evidence is preserved, never replaced by the duplicate.
    expect(result.merged[0].evidence).toHaveLength(1);
  });

  it("still adds a genuinely different scholarship from the same provider", () => {
    const previous = [record()];
    const different = record({
      id: "https://agg-b.example/other",
      sourceUrl: "https://agg-b.example/other",
      name: "MEXT Undergraduate Scholarship 2027",
    });
    const result = mergeDiscoveryResults(previous, [different]);
    expect(result.added).toBe(1);
    expect(result.merged).toHaveLength(2);
  });

  it("is stable when the same merge runs twice (refresh-safe)", () => {
    const incoming = [record()];
    const first = mergeDiscoveryResults([], incoming);
    const second = mergeDiscoveryResults(first.merged, incoming);
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.merged).toEqual(first.merged);
  });
});
