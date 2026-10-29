import { describe, expect, it } from "vitest";
import { discoverScholarships } from "@/lib/ai/orchestrator";
import type { MetaModelClient } from "@/lib/ai/meta-client";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";
import { studentProfileSchema, type StudentProfile } from "@/lib/schemas/student";
import { evaluateEligibility } from "@/lib/tools/eligibility-checker";
import { extractScholarship, normalizeEvidenceInput } from "@/lib/tools/scholarship-extractor";
import type { FetchedPage } from "@/lib/tools/page-fetcher";

const profile: StudentProfile = studentProfileSchema.parse({
  currentEducationLevel: "bachelor",
  academicStatus: "student",
  intendedDegreeLevel: "master",
  fieldOfStudy: "Computer Science",
  citizenship: "Indonesia",
  preferredDestinations: ["Japan"],
  gpa: 3.7,
  gpaScale: 4,
  languageProficiency: "IELTS 7.0",
});

function scholarship(overrides: Partial<Scholarship> = {}): Scholarship {
  return scholarshipSchema.parse({
    id: "https://provider.example/scholarship",
    name: "Example Scholarship",
    sourceUrl: "https://provider.example/scholarship",
    officialUrl: "https://provider.example/scholarship",
    retrievalStatus: "retrieved",
    extractionStatus: "extracted",
    evidence: [],
    ...overrides,
  });
}

function byCategory(result: Awaited<ReturnType<typeof evaluateEligibility>>, category: string) {
  return result.requirements.find((item) => item.category === category);
}

describe("eligibility deterministic evaluation", () => {
  it("matches citizenship and rejects a mismatch only with supported evidence", async () => {
    const base = {
      eligibleCitizenships: ["Indonesia"],
      supportedFields: ["eligibleCitizenships"],
    };
    expect(byCategory(await evaluateEligibility(profile, scholarship(base)), "citizenship")?.evaluation).toBe("meets");
    expect(
      byCategory(
        await evaluateEligibility(
          { ...profile, citizenship: "Malaysia" },
          scholarship(base),
        ),
        "citizenship",
      )?.evaluation,
    ).toBe("does_not_meet");

    const unsupported = await evaluateEligibility(
      profile,
      scholarship({ eligibleCitizenships: ["Malaysia"] }),
    );
    expect(byCategory(unsupported, "citizenship")?.evaluation).toBe("unknown");
    expect(unsupported.overallStatus).not.toBe("does_not_meet");
  });

  it("matches degree level and destination", async () => {
    const result = await evaluateEligibility(
      profile,
      scholarship({
        eligibleDegreeLevels: ["Master's"],
        studyDestinations: ["Japan"],
        supportedFields: ["eligibleDegreeLevels"],
        evidence: [
          {
            field: "studyDestinations",
            quote: "Study in Japan",
            sourceUrl: "https://provider.example/scholarship",
            retrievedAt: "2026-10-28T00:00:00.000Z",
          },
        ],
      }),
      { pageText: "Programs are open. Study in Japan for two years." },
    );
    expect(byCategory(result, "degree_level")?.evaluation).toBe("meets");
    expect(byCategory(result, "destination")?.evaluation).toBe("meets");
  });

  it("returns unknown for missing GPA and language scores", async () => {
    const noScores = studentProfileSchema.parse({
      currentEducationLevel: "bachelor",
      academicStatus: "student",
      intendedDegreeLevel: "master",
      fieldOfStudy: "Computer Science",
      citizenship: "Indonesia",
    });
    const result = await evaluateEligibility(
      noScores,
      scholarship({
        academicRequirements: "Minimum GPA 3.0 out of 4.0",
        languageRequirements: "IELTS 6.5 required",
        supportedFields: ["academicRequirements", "languageRequirements"],
      }),
    );
    expect(byCategory(result, "gpa")?.evaluation).toBe("unknown");
    expect(byCategory(result, "language")?.evaluation).toBe("unknown");
  });

  it("compares GPA and language when both sides are normalized", async () => {
    const result = await evaluateEligibility(
      profile,
      scholarship({
        academicRequirements: "Minimum GPA 3.0 out of 4.0",
        languageRequirements: "IELTS 6.5 required",
        supportedFields: ["academicRequirements", "languageRequirements"],
      }),
    );
    expect(byCategory(result, "gpa")?.evaluation).toBe("meets");
    expect(byCategory(result, "language")?.evaluation).toBe("meets");
  });

  it("does not use evidence quotes absent from fetched page text", async () => {
    const result = await evaluateEligibility(
      profile,
      scholarship({
        eligibleCitizenships: ["Malaysia"],
        evidence: [
          {
            field: "eligibleCitizenships",
            quote: "Only Malaysian citizens may apply",
            sourceUrl: "https://provider.example/scholarship",
            retrievedAt: "2026-10-28T00:00:00.000Z",
          },
        ],
      }),
      { pageText: "This page says something else entirely." },
    );
    const citizenship = byCategory(result, "citizenship");
    expect(citizenship?.evidenceStatus).toBe("unsupported");
    expect(citizenship?.evaluation).toBe("unknown");
  });

  it("marks expired supported deadlines as not actionable", async () => {
    const result = await evaluateEligibility(
      profile,
      scholarship({
        applicationDeadline: "2022-08-01",
        availabilityStatus: "expired",
        supportedFields: ["applicationDeadline"],
      }),
      { now: new Date("2026-10-28T00:00:00.000Z") },
    );
    expect(byCategory(result, "application_deadline")?.evaluation).toBe("does_not_meet");
    expect(result.overallStatus).toBe("does_not_meet");
  });

  it("turns invalid Meta interpretation output into unknown", async () => {
    const metaClient: MetaModelClient = { complete: async () => "not json" };
    const result = await evaluateEligibility(
      profile,
      scholarship({
        eligibilityRequirements: "Applicants must be under 30 years old",
        supportedFields: ["eligibilityRequirements"],
      }),
      { metaClient },
    );
    expect(result.requirements.some((item) => item.evaluation === "unknown")).toBe(true);
    expect(result.overallStatus).not.toBe("meets_known_requirements");
  });

  it("does not evaluate unavailable scholarships", async () => {
    const result = await evaluateEligibility(
      profile,
      scholarship({ retrievalStatus: "failed", extractionStatus: "not_attempted" }),
    );
    expect(result.overallStatus).toBe("insufficient_information");
    expect(result.limitation).toContain("could not be retrieved");
    expect(result.requirements).toEqual([]);
  });
});

describe("extraction evidence normalization", () => {
  it("normalizes object-map evidence and discards bare strings", () => {
    expect(
      normalizeEvidenceInput({
        applicationDeadline: "Deadline is 2027-01-15",
        provider: { quote: "Example Foundation" },
      }),
    ).toEqual([
      { field: "applicationDeadline", quote: "Deadline is 2027-01-15" },
      { field: "provider", quote: "Example Foundation" },
    ]);
    expect(normalizeEvidenceInput("https://example.com")).toEqual([]);
  });

  it("extracts when evidence is an object map instead of an array", async () => {
    const page: FetchedPage = {
      url: "https://provider.example/scholarship",
      finalUrl: "https://provider.example/scholarship",
      status: 200,
      title: "Example Scholarship",
      text: "Deadline 2027-01-15. Award USD 5000.",
      retrievedAt: "2026-10-28T00:00:00.000Z",
    };
    const client: MetaModelClient = {
      complete: async () =>
        JSON.stringify({
          name: "Example Scholarship",
          provider: null,
          eligibleCitizenships: null,
          eligibleDegreeLevels: null,
          eligibleFieldsOfStudy: null,
          studyDestinations: null,
          academicRequirements: null,
          languageRequirements: null,
          eligibilityRequirements: null,
          applicationOpeningDate: null,
          applicationDeadline: "2027-01-15",
          awardAmount: 5000,
          awardCurrency: "USD",
          fundingCoverage: null,
          fundingDuration: null,
          requiredDocuments: null,
          applicationInstructions: null,
          officialUrl: null,
          evidence: { applicationDeadline: "Deadline 2027-01-15" },
        }),
    };
    const extracted = await extractScholarship(client, page, "Fallback");
    expect(extracted.evidence).toEqual([
      {
        field: "applicationDeadline",
        quote: "Deadline 2027-01-15",
        sourceUrl: page.finalUrl,
        retrievedAt: page.retrievedAt,
      },
    ]);
  });
});

describe("bounded backfill", () => {
  it("retains a failed candidate and backfills the next prioritized source", async () => {
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("blocked")) {
        return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
      }
      return new Response("<html><head><title>Example</title></head><body>Example Scholarship</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const extractionJson = JSON.stringify({
      name: "Example Scholarship",
      provider: null,
      eligibleCitizenships: null,
      eligibleDegreeLevels: null,
      eligibleFieldsOfStudy: null,
      studyDestinations: null,
      academicRequirements: null,
      languageRequirements: null,
      eligibilityRequirements: null,
      applicationOpeningDate: null,
      applicationDeadline: null,
      awardAmount: null,
      awardCurrency: null,
      fundingCoverage: null,
      fundingDuration: null,
      requiredDocuments: null,
      applicationInstructions: null,
      officialUrl: null,
      evidence: [],
    });

    const result = await discoverScholarships(profile, {
      searchProvider: {
        name: "fake",
        search: async () => [
          { title: "Blocked", url: "https://example.com/blocked" },
          { title: "Example", url: "https://example.com/example" },
        ],
      },
      metaClient: { complete: async () => extractionJson },
      fetchDeps: {
        fetchFn,
        lookupFn: async () => [{ address: "93.184.216.34" }],
      },
      maxResults: 1,
    });

    expect(result.opportunities).toHaveLength(2);
    expect(result.opportunities[0].retrievalFailureKind).toBe("http_403");
    expect(result.opportunities[0].eligibility?.overallStatus).toBe("insufficient_information");
    expect(result.opportunities[1].extractionStatus).toBe("partial");
    expect(result.opportunities[1].eligibility).toBeDefined();
  });
});
