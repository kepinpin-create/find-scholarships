import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/discover/route";
import {
  discoverScholarships,
  ensureLaneRepresentation,
  getMissingConfiguration,
  mapWithConcurrency,
} from "@/lib/ai/orchestrator";
import { studentProfileSchema } from "@/lib/schemas/student";
import { scholarshipSchema } from "@/lib/schemas/scholarship";
import {
  assertPublicUrl,
  fetchPage,
  isHeaderParseFailure,
  PageFetchError,
} from "@/lib/tools/page-fetcher";
import {
  buildSearchQueries,
  createSearchProvider,
  deduplicateSearchResults,
  limitPerDomain,
  measureMetaSearchResults,
  MetaSearchProvider,
  parseMetaSearchResults,
  prioritizeSearchResults,
} from "@/lib/tools/scholarship-search";
import { determineAvailabilityStatus } from "@/lib/tools/deadline-status";
import { extractScholarship, ExtractionError } from "@/lib/tools/scholarship-extractor";
import { verifyEvidence } from "@/lib/tools/evidence-verifier";
import type { MetaModelClient } from "@/lib/ai/meta-client";
import type { FetchedPage } from "@/lib/tools/page-fetcher";

const validProfile = {
  currentEducationLevel: "bachelor",
  academicStatus: "student",
  intendedDegreeLevel: "master",
  fieldOfStudy: "Computer Science",
  citizenship: "Indonesia",
} as const;

const publicLookup = async () => [{ address: "93.184.216.34" }];
const privateLookup = async () => [{ address: "10.0.0.5" }];

describe("student profile validation", () => {
  it("accepts a profile without university or budget", () => {
    expect(studentProfileSchema.safeParse(validProfile).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    expect(
      studentProfileSchema.safeParse({ ...validProfile, fieldOfStudy: "" })
        .success,
    ).toBe(false);
  });

  it("still loads profiles saved before countryOfResidence was removed", () => {
    const parsed = studentProfileSchema.safeParse({
      ...validProfile,
      countryOfResidence: "Indonesia",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("countryOfResidence" in parsed.data).toBe(false);
    }
  });

  it("accepts profiles without the now-optional level/status and strips removed fields", () => {
    const parsed = studentProfileSchema.safeParse({
      intendedDegreeLevel: "master",
      fieldOfStudy: "Computer Science",
      citizenship: "Indonesia",
      achievements: "Olympiad winner",
      experience: "2 years",
      preferredUniversity: "Example University",
      fundingPreferences: "Fully funded",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("achievements" in parsed.data).toBe(false);
      expect(parsed.data.currentEducationLevel ?? null).toBeNull();
    }
  });

  it("requires citizenship", () => {
    const { citizenship: _citizenship, ...withoutCitizenship } = validProfile;
    expect(studentProfileSchema.safeParse(withoutCitizenship).success).toBe(false);
    expect(
      studentProfileSchema.safeParse({ ...validProfile, citizenship: "" }).success,
    ).toBe(false);
  });

  it("rejects a GPA above its scale", () => {
    expect(
      studentProfileSchema.safeParse({ ...validProfile, gpa: 5, gpaScale: 4 }).success,
    ).toBe(false);
    expect(
      studentProfileSchema.safeParse({ ...validProfile, gpa: 3.5, gpaScale: 4 }).success,
    ).toBe(true);
  });
});

describe("scholarship schema", () => {
  it("keeps unknown fields undefined instead of inventing them", () => {
    const parsed = scholarshipSchema.parse({ id: "1", name: "Example" });
    expect(parsed.applicationDeadline).toBeUndefined();
    expect(parsed.awardAmount).toBeUndefined();
    expect(parsed.verificationStatus).toBe("unverified");
    expect(parsed.evidence).toEqual([]);
  });

  it("rejects a malformed source URL", () => {
    expect(
      scholarshipSchema.safeParse({
        id: "1",
        name: "Example",
        officialUrl: "not-a-url",
      }).success,
    ).toBe(false);
  });
});

describe("search queries and deduplication", () => {
  it("builds queries from profile without requiring a university", () => {
    const profile = studentProfileSchema.parse({
      ...validProfile,
      citizenship: "Indonesia",
      preferredDestinations: ["Japan"],
    });
    const queries = buildSearchQueries(profile);
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.join(" ")).toContain("Indonesia");
    expect(queries.join(" ")).toContain("Japan");
  });

  it("plans at most two queries, and one without a destination", () => {
    const withDestination = studentProfileSchema.parse({
      ...validProfile,
      citizenship: "Indonesia",
      preferredDestinations: ["Japan", "Germany"],
    });
    expect(buildSearchQueries(withDestination)).toHaveLength(2);
    expect(buildSearchQueries(studentProfileSchema.parse(validProfile))).toHaveLength(1);
    expect(buildSearchQueries(withDestination).join(" ")).not.toContain(
      "fully funded scholarship Computer Science Indonesia official application",
    );
  });

  it("caps results at two URLs per domain after deduplication", () => {
    const capped = limitPerDomain(
      deduplicateSearchResults([
        { title: "A", url: "https://agg.example/a" },
        { title: "A dup", url: "https://agg.example/a?utm_source=x" },
        { title: "B", url: "https://agg.example/b" },
        { title: "C", url: "https://agg.example/c" },
        { title: "D", url: "https://other.example/d" },
      ]),
      2,
    );
    expect(capped.map((item) => item.url)).toEqual([
      "https://agg.example/a",
      "https://agg.example/b",
      "https://other.example/d",
    ]);
  });

  it("deduplicates URLs that differ only by tracking params", () => {
    const results = deduplicateSearchResults([
      { title: "A", url: "https://example.com/a?utm_source=x" },
      { title: "A duplicate", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" },
    ]);
    expect(results).toHaveLength(2);
  });
});

describe("page fetcher SSRF protections", () => {
  it("rejects malformed URLs", async () => {
    await expect(assertPublicUrl("not a url", publicLookup)).rejects.toThrow(
      PageFetchError,
    );
  });

  it("blocks localhost and metadata addresses", async () => {
    await expect(
      assertPublicUrl("http://localhost/admin", publicLookup),
    ).rejects.toThrow(PageFetchError);
    await expect(
      assertPublicUrl("http://169.254.169.254/latest", async () => [
        { address: "169.254.169.254" },
      ]),
    ).rejects.toThrow(PageFetchError);
  });

  it("blocks hostnames resolving to private addresses", async () => {
    await expect(
      assertPublicUrl("https://scholarships.example.com", privateLookup),
    ).rejects.toThrow(PageFetchError);
  });

  it("blocks redirects to private destinations", async () => {
    const fetchFn = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    await expect(
      fetchPage("https://example.com/start", {
        fetchFn: fetchFn as typeof fetch,
        lookupFn: async (host) =>
          host === "127.0.0.1" ? [{ address: "127.0.0.1" }] : publicLookup(),
      }),
    ).rejects.toThrow(PageFetchError);
  });

  it("reports inaccessible pages as errors, never fabricated content", async () => {
    const fetchFn = async () =>
      new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
    await expect(
      fetchPage("https://example.com/missing", {
        fetchFn: fetchFn as typeof fetch,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow("HTTP 404");
  });

  it("falls back to the native transport only after a header-parse failure", async () => {
    const primaryError = new TypeError("fetch failed");
    (primaryError as { cause?: unknown }).cause = new Error(
      "Response does not match the HTTP/1.1 protocol (Invalid header value char)",
    );
    expect(isHeaderParseFailure(primaryError)).toBe(true);

    let nativeCalls = 0;
    const page = await fetchPage("https://example.com/scholarship", {
      fetchFn: (async () => {
        throw primaryError;
      }) as typeof fetch,
      nativeFetchFn: async () => {
        nativeCalls++;
        return new Response("<html><head><title>Recovered</title></head><body>OK</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      lookupFn: publicLookup,
    });
    expect(nativeCalls).toBe(1);
    expect(page.title).toBe("Recovered");
  });

  it("classifies header-parse failures when no fallback succeeds", async () => {
    const primaryError = new TypeError("fetch failed");
    (primaryError as { cause?: unknown }).cause = new Error("Invalid header value char");
    await expect(
      fetchPage("https://example.com/scholarship", {
        fetchFn: (async () => {
          throw primaryError;
        }) as typeof fetch,
        nativeFetchFn: async () => {
          throw new Error("native failed");
        },
        lookupFn: publicLookup,
      }),
    ).rejects.toMatchObject({ kind: "upstream_protocol" });
  });

  it("does not use the native fallback for ordinary network failures", async () => {
    let nativeCalls = 0;
    await expect(
      fetchPage("https://example.com/scholarship", {
        fetchFn: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
        nativeFetchFn: async () => {
          nativeCalls++;
          return new Response("x", { status: 200 });
        },
        lookupFn: publicLookup,
      }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(nativeCalls).toBe(0);
  });

  it("extracts text and title from accessible HTML", async () => {
    const fetchFn = async () =>
      new Response("<html><head><title>Example Scholarship</title></head><body><p>Apply by 2027-01-15</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const page = await fetchPage("https://example.com/scholarship", {
      fetchFn: fetchFn as typeof fetch,
      lookupFn: publicLookup,
    });
    expect(page.title).toBe("Example Scholarship");
    expect(page.text).toContain("2027-01-15");
  });
});

describe("extraction and evidence", () => {
  const page: FetchedPage = {
    url: "https://example.com/scholarship",
    finalUrl: "https://example.com/scholarship",
    status: 200,
    title: "Example Scholarship",
    text: "Example Scholarship. Deadline 2027-01-15. Award USD 5000.",
    retrievedAt: "2026-10-28T00:00:00.000Z",
  };

  it("rejects invalid model output", async () => {
    const client: MetaModelClient = { complete: async () => "not json" };
    await expect(extractScholarship(client, page, "Fallback")).rejects.toThrow(
      ExtractionError,
    );
  });

  it("accepts model prose fields returned as arrays", async () => {
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
          eligibilityRequirements: ["Indonesian citizen", "GPA above 3.0"],
          applicationOpeningDate: null,
          applicationDeadline: null,
          awardAmount: null,
          awardCurrency: null,
          fundingCoverage: ["Tuition", "Monthly stipend"],
          fundingDuration: null,
          requiredDocuments: "Passport copy",
          applicationInstructions: null,
          officialUrl: null,
          evidence: [],
        }),
    };
    const extracted = await extractScholarship(client, page, "Fallback");
    expect(extracted.eligibilityRequirements).toContain("Indonesian citizen");
    expect(extracted.fundingCoverage).toContain("Monthly stipend");
    expect(extracted.requiredDocuments).toEqual(["Passport copy"]);
  });

  it("accepts formatted amount strings and malformed official URLs without failing extraction", async () => {
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
          applicationDeadline: null,
          awardAmount: "$5,000",
          awardCurrency: "USD",
          fundingCoverage: null,
          fundingDuration: null,
          requiredDocuments: null,
          applicationInstructions: null,
          officialUrl: "/relative/apply",
          evidence: [],
        }),
    };
    const extracted = await extractScholarship(client, page, "Fallback");
    expect(extracted.awardAmount).toBe(5000);
    expect(extracted.officialUrl).toBeUndefined();
  });

  it("only marks claims supported when quotes appear in the page", async () => {
    const client: MetaModelClient = {
      complete: async () =>
        JSON.stringify({
          name: "Example Scholarship",
          provider: "Example Foundation",
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
          officialUrl: "https://example.com/scholarship",
          evidence: [
            { field: "applicationDeadline", quote: "Deadline 2027-01-15" },
            { field: "awardAmount", quote: "Award USD 99999" },
          ],
        }),
    };
    const extracted = await extractScholarship(client, page, "Fallback");
    const verified = verifyEvidence(extracted, page.text);
    expect(verified.verificationStatus).toBe("partially_supported");
    expect(verified.unverifiedFields).toContain("awardAmount");
  });
});

describe("Meta-native search provider", () => {
  it("parses web_search_call results and cited sources", () => {
    const results = parseMetaSearchResults(
      {
        output: [
          {
            type: "web_search_call",
            status: "completed",
            results: [
              { type: "text_result", title: "LPDP", url: "https://lpdp.example/scholarship", snippet: "Official" },
              { type: "text_result", title: "Dup", url: "https://lpdp.example/scholarship?utm_source=x" },
            ],
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "answer",
                annotations: [
                  { type: "url_citation", title: "Chevening", url: "https://chevening.example/apply", start_index: 0, end_index: 6 },
                ],
              },
            ],
          },
        ],
      },
      8,
    );
    expect(results).toHaveLength(2);
    expect(results[0].url).toContain("lpdp.example");
  });

  it("returns no candidates when the model did not search", () => {
    expect(parseMetaSearchResults({ output: [{ type: "message", content: [] }] }, 8)).toEqual([]);
  });

  it("sends the documented Responses web_search request", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn = async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(
        JSON.stringify({
          output: [
            { type: "web_search_call", status: "completed", results: [{ type: "text_result", title: "A", url: "https://a.example" }] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new MetaSearchProvider("test-key", "muse-spark-1.3", "https://api.meta.ai/v1", fetchFn as typeof fetch);
    const results = await provider.search("master scholarship Indonesia", 6);
    expect(results).toHaveLength(1);
    expect(seenUrl).toBe("https://api.meta.ai/v1/responses");
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(seenInit?.body));
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
    expect(body.include).toEqual(["web_search_call.results"]);
    expect(body.input).toContain("exactly one web search");
  });

  it("returns up to 20 raw results so prioritization sees official sources", () => {
    const results = parseMetaSearchResults(
      {
        output: [
          {
            type: "web_search_call",
            status: "completed",
            results: Array.from({ length: 15 }, (_, i) => ({
              type: "text_result",
              title: `Result ${i}`,
              url: `https://site${i}.example/page`,
            })),
          },
        ],
      },
      20,
    );
    expect(results).toHaveLength(15);
    expect(
      measureMetaSearchResults({
        output: [
          {
            type: "web_search_call",
            results: [{ url: "https://a.example" }, { url: "https://a.example" }],
          },
          { type: "web_search_call", results: [{ url: "https://b.example" }] },
        ],
      }),
    ).toEqual({ webSearchCalls: 2, rawResults: 3, uniqueUrls: 2 });
  });

  it("configures meta mode without a Brave key", () => {
    expect(
      createSearchProvider({ SEARCH_PROVIDER: "meta", MODEL_API_KEY: "k" })?.name,
    ).toBe("meta");
    expect(
      getMissingConfiguration({ SEARCH_PROVIDER: "meta", MODEL_API_KEY: "k" }),
    ).toEqual([]);
    expect(getMissingConfiguration({ SEARCH_PROVIDER: "meta" })).toEqual(["MODEL_API_KEY"]);
  });
});

describe("deadline availability", () => {
  const now = new Date("2026-10-28T00:00:00.000Z");

  it("marks an evidence-supported past deadline expired", () => {
    expect(
      determineAvailabilityStatus(
        { applicationDeadline: "2022-08-01", supportedFields: ["applicationDeadline"] },
        now,
      ),
    ).toBe("expired");
  });

  it("does not mark an unsupported past deadline expired", () => {
    expect(
      determineAvailabilityStatus(
        { applicationDeadline: "2022-08-01", supportedFields: [] },
        now,
      ),
    ).toBe("unknown");
  });

  it("keeps unknown dates unknown", () => {
    expect(determineAvailabilityStatus({}, now)).toBe("unknown");
    expect(
      determineAvailabilityStatus(
        { applicationDeadline: "2027-01-15", supportedFields: ["applicationDeadline"] },
        now,
      ),
    ).toBe("unknown");
  });

  it("requires supported opening dates for upcoming and open", () => {
    const deadline = {
      applicationDeadline: "2027-01-15",
      supportedFields: ["applicationDeadline", "applicationOpeningDate"],
    };
    expect(
      determineAvailabilityStatus(
        { ...deadline, applicationOpeningDate: "2026-09-01" },
        now,
      ),
    ).toBe("open");
    expect(
      determineAvailabilityStatus(
        { ...deadline, applicationOpeningDate: "2026-12-01" },
        now,
      ),
    ).toBe("upcoming");
    expect(
      determineAvailabilityStatus(
        {
          applicationDeadline: "2027-01-15",
          applicationOpeningDate: "2026-09-01",
          supportedFields: ["applicationDeadline"],
        },
        now,
      ),
    ).toBe("unknown");
  });
});

describe("retrieval failures and partial results", () => {
  const htmlFetch = (status: number, body = "", contentType = "text/html") =>
    (async () =>
      new Response(body, {
        status,
        headers: { "content-type": contentType },
      })) as typeof fetch;

  it("classifies HTTP 403 without invalidating the candidate", async () => {
    const profile = studentProfileSchema.parse(validProfile);
    const result = await discoverScholarships(profile, {
      searchProvider: {
        name: "fake",
        search: async () => [
          { title: "Blocked Scholarship", url: "https://example.com/blocked" },
        ],
      },
      metaClient: { complete: async () => "{}" },
      fetchDeps: { fetchFn: htmlFetch(403), lookupFn: publicLookup },
      maxResults: 1,
    });
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].retrievalStatus).toBe("failed");
    expect(result.opportunities[0].retrievalFailureKind).toBe("http_403");
    expect(result.opportunities[0].extractionStatus).toBe("not_attempted");
    expect(result.opportunities[0].sourceUrl).toBe("https://example.com/blocked");
    expect(result.opportunities[0].availabilityStatus).toBe("unknown");
  });

  it("separates extraction failure from a successful retrieval", async () => {
    const profile = studentProfileSchema.parse(validProfile);
    const result = await discoverScholarships(profile, {
      searchProvider: {
        name: "fake",
        search: async () => [
          { title: "Example", url: "https://example.com/scholarship" },
        ],
      },
      metaClient: { complete: async () => "not json" },
      fetchDeps: {
        fetchFn: htmlFetch(200, "<html><body>Scholarship</body></html>"),
        lookupFn: publicLookup,
      },
      maxResults: 1,
    });
    expect(result.opportunities[0].retrievalStatus).toBe("retrieved");
    expect(result.opportunities[0].extractionStatus).toBe("failed");
    expect(result.opportunities[0].verificationStatus).toBe("unverified");
  });

  it("returns partial results when one search fails", async () => {
    const profile = studentProfileSchema.parse({
      ...validProfile,
      preferredDestinations: ["Japan"],
    });
    let calls = 0;
    const result = await discoverScholarships(profile, {
      searchProvider: {
        name: "fake",
        search: async () => {
          calls++;
          if (calls === 1) throw new Error("search failed");
          return [{ title: "Example", url: "https://example.com/a" }];
        },
      },
      metaClient: { complete: async () => "not json" },
      fetchDeps: {
        fetchFn: htmlFetch(200, "<html><body>Scholarship</body></html>"),
        lookupFn: publicLookup,
      },
      maxResults: 1,
    });
    expect(result.status).toBe("ok");
    expect(result.opportunities).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("searches failed");
  });

  it("classifies PDFs as unsupported content, retained but unverified", async () => {
    await expect(
      fetchPage("https://example.com/guide.pdf", {
        fetchFn: htmlFetch(200, "%PDF", "application/pdf"),
        lookupFn: publicLookup,
      }),
    ).rejects.toMatchObject({ kind: "unsupported_content" });
  });

  it("bounds concurrency at three and preserves order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("reserves a social slot without displacing official candidates", () => {
    const items = [
      { title: "Official", url: "https://university.example/a", sourceLane: "official" as const },
      { title: "Agg1", url: "https://agg.example/1", sourceLane: "aggregator" as const },
      { title: "Agg2", url: "https://agg.example/2", sourceLane: "aggregator" as const },
      { title: "Agg3", url: "https://agg.example/3", sourceLane: "aggregator" as const },
      { title: "Social", url: "https://www.instagram.com/beasiswa/p/1/", sourceLane: "social" as const },
    ];
    const reordered = ensureLaneRepresentation(items, 4);
    expect(reordered.slice(0, 4).some((item) => item.sourceLane === "social")).toBe(true);
    expect(reordered[0].sourceLane).toBe("official");
  });

  it("prioritizes official sources before aggregators", () => {
    const ordered = prioritizeSearchResults([
      { title: "Agg", url: "https://scholarshipsads.com/x" },
      { title: "Gov", url: "https://www.daad.de/scholarship" },
      { title: "Uni", url: "https://www.example.ac.uk/funding" },
      { title: "Blog", url: "https://blog.example.com/x" },
    ]);
    expect(ordered[0].url).toContain("daad.de");
    expect(ordered[ordered.length - 1].url).toContain("scholarshipsads.com");
  });

  it("never assigns an aggregator URL as the official application URL", async () => {
    const makeClient = (officialUrl: string | null) => ({
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
          applicationDeadline: null,
          awardAmount: null,
          awardCurrency: null,
          fundingCoverage: null,
          fundingDuration: null,
          requiredDocuments: null,
          applicationInstructions: null,
          officialUrl,
          evidence: [],
        }),
    });
    const aggregatorPage: FetchedPage = {
      url: "https://scholarshipsads.com/example",
      finalUrl: "https://scholarshipsads.com/example",
      status: 200,
      text: "Example",
      retrievedAt: "2026-10-28T00:00:00.000Z",
    };
    const fromAggregator = await extractScholarship(
      makeClient("https://scholarshipsads.com/example"),
      aggregatorPage,
      "Fallback",
    );
    expect(fromAggregator.officialUrl).toBeUndefined();
    expect(fromAggregator.sourceUrl).toBe("https://scholarshipsads.com/example");

    const withOfficialLink = await extractScholarship(
      makeClient("https://www.chevening.org/apply"),
      aggregatorPage,
      "Fallback",
    );
    expect(withOfficialLink.officialUrl).toBe("https://www.chevening.org/apply");

    const officialPage: FetchedPage = {
      ...aggregatorPage,
      url: "https://www.chevening.org/scholarships",
      finalUrl: "https://www.chevening.org/scholarships",
    };
    const fromOfficial = await extractScholarship(
      makeClient(null),
      officialPage,
      "Fallback",
    );
    expect(fromOfficial.officialUrl).toBe("https://www.chevening.org/scholarships");
  });

  it("returns unfinished candidates when the discovery budget is exhausted", async () => {
    const profile = studentProfileSchema.parse(validProfile);
    const result = await discoverScholarships(profile, {
      searchProvider: {
        name: "fake",
        search: async () => [
          { title: "A", url: "https://a.example/1" },
          { title: "B", url: "https://b.example/2" },
        ],
      },
      metaClient: { complete: async () => "{}" },
      fetchDeps: { fetchFn: htmlFetch(200, "<html></html>"), lookupFn: publicLookup },
      budgetMs: 1,
    });
    expect(result.opportunities).toHaveLength(2);
    expect(
      result.opportunities.every(
        (item) =>
          item.retrievalStatus === "not_attempted" &&
          item.verificationStatus === "unverified" &&
          item.availabilityStatus === "unknown",
      ),
    ).toBe(true);
    expect(result.warnings.join(" ")).toContain("time budget");
  });

  it("does not fully support a record based on one minor field", async () => {
    const extracted = await extractScholarship(
      {
        complete: async () =>
          JSON.stringify({
            name: "Example Scholarship",
            provider: "Example Foundation",
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
            evidence: [{ field: "provider", quote: "Example Foundation" }],
          }),
      },
      {
        url: "https://example.com/s",
        finalUrl: "https://example.com/s",
        status: 200,
        text: "Example Foundation offers this.",
        retrievedAt: "2026-10-28T00:00:00.000Z",
      },
      "Fallback",
    );
    expect(
      verifyEvidence(extracted, "Example Foundation offers this.")
        .verificationStatus,
    ).not.toBe("supported");
  });
});

describe("missing credentials", () => {
  it("reports every missing env var by name", () => {
    expect(getMissingConfiguration({})).toEqual(
      expect.arrayContaining(["BRAVE_SEARCH_API_KEY", "MODEL_API_KEY"]),
    );
  });

  it("orchestrator returns not_configured instead of fake results", async () => {
    const profile = studentProfileSchema.parse(validProfile);
    const result = await discoverScholarships(profile, { env: {} });
    expect(result.status).toBe("not_configured");
    expect(result.opportunities).toEqual([]);
    expect(result.missingConfiguration).toContain("MODEL_API_KEY");
  });
});

describe("API request validation", () => {
  it("rejects invalid JSON and invalid profiles with 400", async () => {
    const badJson = await POST(
      new Request("http://localhost/api/discover", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(badJson.status).toBe(400);

    const badProfile = await POST(
      new Request("http://localhost/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: { fieldOfStudy: "" } }),
      }),
    );
    expect(badProfile.status).toBe(400);
  });

  it("returns 503 when discovery is not configured", async () => {
    const response = await POST(
      new Request("http://localhost/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: validProfile }),
      }),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("not_configured");
    expect(body.opportunities).toEqual([]);
  });
});
