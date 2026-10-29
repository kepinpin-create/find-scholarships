import { describe, expect, it } from "vitest";
import { classifySource, prioritizeSearchResults, sourceReferenceFor } from "@/lib/tools/scholarship-search";
import { buildSourceSearchQueries } from "@/lib/tools/scholarship-search";
import { discoverScholarships } from "@/lib/ai/orchestrator";
import { studentProfileSchema } from "@/lib/schemas/student";
import {
  identityKeyFor,
  mergeScholarshipRecords,
  scholarshipsMatch,
} from "@/lib/tools/scholarship-identity";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";

function record(overrides: Partial<Scholarship> = {}): Scholarship {
  return scholarshipSchema.parse({
    id: "https://agg-a.example/s1",
    name: "Example Scholarship 2026",
    provider: "Example Foundation",
    sourceUrl: "https://agg-a.example/s1",
    retrievalStatus: "retrieved",
    extractionStatus: "extracted",
    verificationStatus: "supported",
    supportedFields: ["applicationDeadline"],
    evidence: [
      {
        field: "applicationDeadline",
        quote: "Deadline 2026-03-31",
        sourceUrl: "https://agg-a.example/s1",
        retrievedAt: "2026-10-28T00:00:00.000Z",
      },
    ],
    sources: [
      {
        id: "https://agg-a.example/s1",
        url: "https://agg-a.example/s1",
        canonicalUrl: "https://agg-a.example/s1",
        sourceType: "aggregator",
        publisherHost: "agg-a.example",
        retrievalStatus: "retrieved",
        extractionStatus: "extracted",
      },
    ],
    ...overrides,
  });
}

describe("Phase A source schema and classification", () => {
  it("loads existing records without sources safely", () => {
    const parsed = scholarshipSchema.parse({ id: "1", name: "Legacy" });
    expect(parsed.sources).toEqual([]);
  });

  it("classifies official, aggregator, and Instagram sources with publisher identity", () => {
    expect(classifySource("https://www.utwente.nl/en/education/scholarship-finder/").sourceType).toBe("university");
    expect(classifySource("https://www.chevening.org/apply").sourceType).toBe("official_provider");
    expect(classifySource("https://lpdp.kemenkeu.go.id/beasiswa").sourceType).toBe("government");
    expect(classifySource("https://eng.ui.ac.id/scholarship").sourceType).toBe("university");
    expect(classifySource("https://scholarshipsads.com/x").sourceType).toBe("aggregator");
    const social = classifySource("https://www.instagram.com/beasiswaindo/p/ABC123/");
    expect(social.sourceType).toBe("social");
    expect(social.publisherHost).toBe("instagram.com");
    expect(social.handle).toBe("beasiswaindo");
  });

  it("ranks destination-university scholarship pages above official listing pages", () => {
    const ordered = prioritizeSearchResults([
      { title: "University of Twente news", url: "https://www.utwente.nl/en/news/example" },
      { title: "University of Twente Scholarship", url: "https://www.utwente.nl/en/education/scholarship/" },
      { title: "Partner-Scholarship Programs", url: "https://partnership.itb.ac.id/scholarship-programs/" },
    ]);
    expect(ordered[0].url).toContain("utwente.nl/en/education/scholarship");
  });

  it("creates a provenance-preserving source reference", () => {
    const source = sourceReferenceFor("https://www.instagram.com/lpdp_ri/p/ABC123/", {
      discoveryQuery: "site:instagram.com beasiswa",
      retrievalStatus: "failed",
      retrievalFailureKind: "http_403",
    });
    expect(source.url).toContain("instagram.com/lpdp_ri");
    expect(source.sourceType).toBe("social");
    expect(source.retrievalStatus).toBe("failed");
  });
});

describe("Phase C targeted search lanes", () => {
  it("plans official, aggregator, and public Instagram lanes within three searches", () => {
    const profile = studentProfileSchema.parse({
      currentEducationLevel: "bachelor",
      academicStatus: "student",
      intendedDegreeLevel: "master",
      fieldOfStudy: "Computer Science",
      citizenship: "Indonesia",
      preferredDestinations: ["Japan"],
    });
    const lanes = buildSourceSearchQueries(profile);
    expect(lanes.map((item) => item.lane)).toEqual(["official", "aggregator", "social"]);
    expect(lanes[2].query).toContain("site:instagram.com");
    expect(lanes[2].query).toContain("beasiswa");
    expect(lanes[2].query).toContain("testimoni");
    expect(lanes[0].query).toContain("official");
    expect(lanes[0].query).toContain("Japan");
    expect(lanes[0].query).toContain("universities");
    expect(lanes[0].query).toContain("site:u-tokyo.ac.jp");
  });

  it("retains an inaccessible Instagram post as an unverified social lead", async () => {
    const profile = studentProfileSchema.parse({
      currentEducationLevel: "bachelor",
      academicStatus: "student",
      intendedDegreeLevel: "master",
      fieldOfStudy: "Computer Science",
      citizenship: "Indonesia",
    });
    const result = await discoverScholarships(profile, {
      searchProvider: {
        name: "fake",
        search: async () => [
          { title: "Beasiswa Post", url: "https://www.instagram.com/beasiswaindo/p/ABC123/" },
        ],
      },
      metaClient: { complete: async () => "{}" },
      fetchDeps: {
        fetchFn: (async () =>
          new Response("login", { status: 403, headers: { "content-type": "text/html" } })) as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34" }],
      },
      maxResults: 1,
    });
    expect(result.opportunities).toHaveLength(1);
    const item = result.opportunities[0];
    expect(item.sources[0].sourceType).toBe("social");
    expect(item.sources[0].handle).toBe("beasiswaindo");
    expect(item.retrievalStatus).toBe("failed");
    expect(item.verificationStatus).toBe("unverified");
    expect(item.eligibility?.overallStatus).toBe("insufficient_information");
  });
});

describe("Phase B identity, provenance, and conflicts", () => {
  it("matches the same scholarship across different aggregator domains", () => {
    const a = record();
    const b = record({
      id: "https://agg-b.example/different-path",
      sourceUrl: "https://agg-b.example/different-path",
      officialUrl: undefined,
      sources: [
        {
          id: "https://agg-b.example/different-path",
          url: "https://agg-b.example/different-path",
          canonicalUrl: "https://agg-b.example/different-path",
          sourceType: "aggregator",
          publisherHost: "agg-b.example",
          retrievalStatus: "retrieved",
          extractionStatus: "extracted",
        },
      ],
    });
    expect(scholarshipsMatch(a, b)).toBe(true);
    const merged = mergeScholarshipRecords([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toHaveLength(2);
    // Two aggregators repeating a claim do not create official confirmation.
    expect(merged[0].verificationStatus).toBe("partially_supported");
  });

  it("does not require the same deadline for recurring cycles and does not flag a new cycle as a conflict", () => {
    const cycle2026 = record({ applicationDeadline: "2026-03-31" });
    const cycle2027 = record({
      id: "https://agg-b.example/s1-2027",
      sourceUrl: "https://agg-b.example/s1-2027",
      name: "Example Scholarship 2027",
      applicationDeadline: "2027-03-31",
    });
    expect(identityKeyFor(cycle2026)).toBe(identityKeyFor(cycle2027));
    const merged = mergeScholarshipRecords([cycle2026, cycle2027]);
    expect(merged).toHaveLength(1);
    expect(merged[0].conflictingFields ?? []).not.toContain("applicationDeadline");
  });

  it("flags genuine same-cycle deadline conflicts without overwriting the primary value", () => {
    const a = record({ applicationDeadline: "2026-03-31" });
    const b = record({
      id: "https://provider.example/s1",
      sourceUrl: "https://provider.example/s1",
      officialUrl: "https://provider.example/s1",
      applicationDeadline: "2026-05-15",
      sources: [
        {
          id: "https://provider.example/s1",
          url: "https://provider.example/s1",
          canonicalUrl: "https://provider.example/s1",
          sourceType: "university",
          publisherHost: "provider.example",
          retrievalStatus: "retrieved",
          extractionStatus: "extracted",
        },
      ],
    });
    const merged = mergeScholarshipRecords([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].conflictingFields).toContain("applicationDeadline");
    expect(merged[0].verificationStatus).toBe("conflicting");
    expect(merged[0].sources).toHaveLength(2);
    expect(["2026-03-31", "2026-05-15"]).toContain(merged[0].applicationDeadline);
  });

  it("prefers official-source records while preserving aggregator provenance", () => {
    const aggregator = record({ provider: "Example Foundation" });
    const official = record({
      id: "https://university.example/scholarship",
      sourceUrl: "https://university.example/scholarship",
      officialUrl: "https://university.example/scholarship",
      applicationDeadline: "2026-03-31",
      sources: [
        {
          id: "https://university.example/scholarship",
          url: "https://university.example/scholarship",
          canonicalUrl: "https://university.example/scholarship",
          sourceType: "university",
          publisherHost: "university.example",
          retrievalStatus: "retrieved",
          extractionStatus: "extracted",
        },
      ],
    });
    const merged = mergeScholarshipRecords([aggregator, official]);
    expect(merged).toHaveLength(1);
    expect(merged[0].officialUrl).toBe("https://university.example/scholarship");
    expect(merged[0].sources.map((source) => source.publisherHost)).toEqual(
      expect.arrayContaining(["agg-a.example", "university.example"]),
    );
  });
});
