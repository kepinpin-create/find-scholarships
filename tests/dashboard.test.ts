import { describe, expect, it } from "vitest";
import { summarizeDashboard } from "@/lib/dashboard";
import {
  loadOpportunities,
  mergeDiscoveryResults,
  toggleSavedScholarship,
  type StorageLike,
} from "@/lib/storage";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";
import { studentProfileSchema } from "@/lib/schemas/student";

function memoryStorage(values: Record<string, string> = {}): StorageLike {
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

function record(overrides: Partial<Scholarship> = {}): Scholarship {
  return scholarshipSchema.parse({
    id: "https://provider.example/s1",
    name: "Example Scholarship",
    sourceUrl: "https://provider.example/s1",
    retrievalStatus: "retrieved",
    extractionStatus: "extracted",
    evidence: [{ field: "applicationDeadline", quote: "Apply by 2027-01-15", sourceUrl: "https://provider.example/s1", retrievedAt: "2026-10-28T00:00:00.000Z" }],
    ...overrides,
  });
}

const profile = studentProfileSchema.parse({
  currentEducationLevel: "bachelor",
  academicStatus: "student",
  intendedDegreeLevel: "master",
  fieldOfStudy: "Computer Science",
  citizenship: "Indonesia",
});

describe("storage validation and protection", () => {
  it("recovers valid records and reports discarded invalid entries", () => {
    const storage = memoryStorage({
      "scholarship-navigator:opportunities": JSON.stringify([
        JSON.parse(JSON.stringify(record())),
        { id: 42 },
        "garbage",
      ]),
    });
    const loaded = loadOpportunities(storage);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.discarded).toBe(2);
    // Loader does not delete the raw stored value.
    expect(storage.getItem("scholarship-navigator:opportunities")).toContain("garbage");
  });

  it("returns empty results for corrupt JSON without throwing", () => {
    const storage = memoryStorage({ "scholarship-navigator:opportunities": "{not json" });
    expect(loadOpportunities(storage)).toEqual({ records: [], discarded: 0 });
  });

  it("never lets an empty search overwrite previous results", () => {
    const previous = [record()];
    expect(mergeDiscoveryResults(previous, [])).toEqual({
      merged: previous,
      added: 0,
      discarded: 0,
    });
  });

  it("merges only genuinely new valid records and preserves existing evidence", () => {
    const previous = [record()];
    const duplicateWithLessEvidence = record({ name: "Changed Name", evidence: [] });
    const genuinelyNew = record({
      id: "https://provider.example/s2",
      sourceUrl: "https://provider.example/s2",
      name: "New Scholarship",
    });
    const result = mergeDiscoveryResults(previous, [
      duplicateWithLessEvidence,
      genuinelyNew,
      { broken: true },
    ]);
    expect(result.added).toBe(1);
    expect(result.discarded).toBe(1);
    expect(result.merged).toHaveLength(2);
    expect(result.merged[0].evidence).toHaveLength(1);
    expect(result.merged[0].name).toBe("Example Scholarship");
  });

  it("toggles bookmarks without touching scholarship records", () => {
    const saved = toggleSavedScholarship({}, "https://provider.example/s1", new Date("2026-10-28T00:00:00.000Z"));
    expect(saved["https://provider.example/s1"].saved).toBe(true);
    const unsaved = toggleSavedScholarship(saved, "https://provider.example/s1");
    expect(unsaved["https://provider.example/s1"].saved).toBe(false);
  });
});

describe("dashboard summary", () => {
  it("keeps unknown eligibility unknown and only shows supported upcoming deadlines", () => {
    const summary = summarizeDashboard({
      profile,
      opportunities: [
        record({
          applicationDeadline: "2027-01-15",
          availabilityStatus: "upcoming",
          supportedFields: ["applicationDeadline"],
        }),
        record({
          id: "https://provider.example/s2",
          sourceUrl: "https://provider.example/s2",
          applicationDeadline: "2027-02-01",
          availabilityStatus: "upcoming",
          supportedFields: [],
        }),
        record({
          id: "https://provider.example/s3",
          sourceUrl: "https://provider.example/s3",
          applicationDeadline: "2020-01-01",
          availabilityStatus: "expired",
          supportedFields: ["applicationDeadline"],
        }),
      ],
      savedBookmarks: 1,
      fundingInput: null,
      now: new Date("2026-10-28T00:00:00.000Z"),
    });
    expect(summary.eligibility.unknown).toBe(3);
    expect(summary.eligibility.meets).toBe(0);
    expect(summary.upcomingDeadlines).toHaveLength(1);
    expect(summary.fundingGap).toBeNull();
    expect(summary.nextAction.href).toBe("/funding");
  });

  it("counts Instagram testimonial links without treating them as evidence", () => {
    const summary = summarizeDashboard({
      profile,
      opportunities: [
        record({
          sources: [
            {
              id: "https://www.instagram.com/beasiswaindo/p/ABC123/",
              url: "https://www.instagram.com/beasiswaindo/p/ABC123/",
              canonicalUrl: "https://www.instagram.com/beasiswaindo/p/ABC123/",
              sourceType: "social",
              publisherHost: "instagram.com",
              handle: "beasiswaindo",
              retrievalStatus: "failed",
              extractionStatus: "not_attempted",
            },
          ],
        }),
      ],
      savedBookmarks: 0,
      fundingInput: null,
    });
    expect(summary.socialMentions).toBe(1);
    expect(summary.eligibility.unknown).toBe(1);
    expect(summary.upcomingDeadlines).toHaveLength(0);
  });

  it("calculates a funding gap only when saved costs exist", () => {
    const withCosts = summarizeDashboard({
      profile,
      opportunities: [],
      savedBookmarks: 0,
      fundingInput: {
        targetCurrency: "USD",
        studyPeriodYears: "2",
        costs: [
          {
            id: "c1",
            category: "tuition",
            label: "Tuition",
            amount: 1000,
            currency: "USD",
            frequency: "annual",
            recurring: true,
          },
        ],
        confirmed: [],
        rates: [],
      },
    });
    expect(withCosts.fundingGap).toBe(2000);
    expect(withCosts.fundingCurrency).toBe("USD");
  });

  it("chooses profile completion as the first next action", () => {
    const summary = summarizeDashboard({
      profile: null,
      opportunities: [],
      savedBookmarks: 0,
      fundingInput: null,
    });
    expect(summary.nextAction.href).toBe("/profile");
  });
});
