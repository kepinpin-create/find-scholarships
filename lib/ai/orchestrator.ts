import { createMetaClient, isMetaConfigured, type MetaModelClient } from "./meta-client";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";
import type { StudentProfile } from "@/lib/schemas/student";
import {
  fetchPage,
  PageFetchError,
  retrievalFailureSummary,
  type FetchedPage,
  type PageFetcherDeps,
} from "@/lib/tools/page-fetcher";
import { verifyEvidence } from "@/lib/tools/evidence-verifier";
import { extractScholarship, ExtractionError } from "@/lib/tools/scholarship-extractor";
import {
  createUnavailableEligibility,
  evaluateEligibility,
} from "@/lib/tools/eligibility-checker";
import { mergeScholarshipRecords } from "@/lib/tools/scholarship-identity";
import {
  buildSourceSearchQueries,
  canonicalizeUrl,
  createSearchProvider,
  deduplicateSearchResults,
  limitPerDomain,
  prioritizeSearchResults,
  sourcePriority,
  sourceReferenceFor,
  type SearchProvider,
  type SearchResultItem,
  type SearchLane,
  classifySource,
} from "@/lib/tools/scholarship-search";

/**
 * Central discovery orchestrator (FR-02/FR-03). One workflow, reusable tools:
 * queries -> search -> safe fetch -> model extraction -> schema validation
 * -> evidence association -> deduplication. No autonomous sub-agents.
 */

export type DiscoveryStatus = "ok" | "empty" | "not_configured" | "failed";

export interface DiscoveryResult {
  status: DiscoveryStatus;
  opportunities: Scholarship[];
  queries: string[];
  warnings: string[];
  /** Env var names that must be set before live discovery can run. */
  missingConfiguration: string[];
  generatedAt: string;
}

export interface DiscoveryDeps {
  searchProvider?: SearchProvider | null;
  metaClient?: MetaModelClient | null;
  fetchDeps?: PageFetcherDeps;
  maxResults?: number;
  /** Total discovery budget in ms. Defaults to DISCOVERY_BUDGET_MS or 90s. */
  budgetMs?: number;
  env?: Record<string, string | undefined>;
}

export function getMissingConfiguration(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const missing: string[] = [];
  const provider = (env.SEARCH_PROVIDER?.trim() || "brave").toLowerCase();
  if (provider === "meta") {
    if (!isMetaConfigured(env)) missing.push("MODEL_API_KEY");
    return missing;
  }
  if (provider !== "brave") {
    missing.push("SEARCH_PROVIDER (only 'brave' or 'meta' are implemented)");
  } else if (!(env.BRAVE_SEARCH_API_KEY ?? env.SEARCH_API_KEY)?.trim()) {
    missing.push("BRAVE_SEARCH_API_KEY");
  }
  if (!isMetaConfigured(env)) missing.push("MODEL_API_KEY");
  return missing;
}

function candidateFromSearchResult(item: SearchResultItem): Scholarship {
  return {
    id: item.url,
    name: item.title,
    sourceUrl: item.url,
    sourceTitle: item.title,
    officialUrl: undefined,
    sources: [sourceReferenceFor(item.url, { discoveryQuery: item.discoveryQuery })],
    evidence: [],
    verificationStatus: "unverified",
    extractionStatus: "not_attempted",
    retrievalStatus: "not_attempted",
    availabilityStatus: "unknown",
  };
}

function logStage(
  stage: string,
  startedAt: number,
  details: Record<string, string | number> = {},
) {
  console.info(
    "[discovery]",
    JSON.stringify({
      stage,
      durationMs: Math.round(Date.now() - startedAt),
      ...details,
    }),
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}

export function laneOf(item: SearchResultItem): SearchLane {
  if (item.sourceLane) return item.sourceLane;
  return classifySource(item.url).sourceType === "social" ? "social" : "official";
}

/**
 * Reserve one early processing slot for a social lead when social results
 * exist, without displacing official-priority candidates: the replaced
 * candidate is the lowest-priority non-social item in the window.
 */
export function ensureLaneRepresentation(
  items: SearchResultItem[],
  windowSize: number,
): SearchResultItem[] {
  if (windowSize <= 0 || items.length <= windowSize) return items;
  const window = items.slice(0, windowSize);
  if (window.some((item) => laneOf(item) === "social")) return items;
  const socialIndex = items.findIndex((item) => laneOf(item) === "social");
  if (socialIndex === -1) return items;

  let replaceIndex = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (laneOf(window[i]) !== "social" && sourcePriority(window[i]) < 3) {
      replaceIndex = i;
      break;
    }
  }
  if (replaceIndex === -1) return items;

  const reordered = [...items];
  const [social] = reordered.splice(socialIndex, 1);
  reordered.splice(replaceIndex, 0, social);
  return reordered;
}

/** Bounded-concurrency map: at most `limit` tasks run at once, order kept. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker),
  );
  return results;
}

export async function discoverScholarships(
  profile: StudentProfile,
  deps: DiscoveryDeps = {},
): Promise<DiscoveryResult> {
  const env = deps.env ?? process.env;
  const generatedAt = new Date().toISOString();
  const missingConfiguration =
    deps.searchProvider === undefined || deps.metaClient === undefined
      ? getMissingConfiguration(env)
      : [
          ...(deps.searchProvider
            ? []
            : [
                (env.SEARCH_PROVIDER?.trim().toLowerCase() ?? "brave") === "meta"
                  ? "MODEL_API_KEY"
                  : "BRAVE_SEARCH_API_KEY",
              ]),
          ...(deps.metaClient ? [] : ["MODEL_API_KEY"]),
        ];

  const searchProvider =
    deps.searchProvider === undefined
      ? createSearchProvider(env)
      : deps.searchProvider;
  const metaClient =
    deps.metaClient === undefined ? createMetaClient(env) : deps.metaClient;

  if (!searchProvider || !metaClient) {
    return {
      status: "not_configured",
      opportunities: [],
      queries: [],
      warnings: [
        "Live discovery is not configured. Set the missing environment variables in .env.local and restart the server.",
      ],
      missingConfiguration,
      generatedAt,
    };
  }
  const activeMetaClient: MetaModelClient = metaClient;

  const plannedQueries = buildSourceSearchQueries(profile);
  const queries = plannedQueries.map((item) => item.query);
  const maxResults = deps.maxResults ?? 8;
  const warnings: string[] = [];
  const discoveryStartedAt = Date.now();
  const configuredBudget = Number(env.DISCOVERY_BUDGET_MS);
  const budgetMs =
    deps.budgetMs ??
    (Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : 90_000);
  // Reserve the final slice of the budget for response assembly.
  const workDeadline = discoveryStartedAt + Math.max(budgetMs - 2_000, 0);

  const searchStartedAt = Date.now();
  const settled = await Promise.allSettled(
    plannedQueries.map(async (planned, index) => {
      const startedAt = Date.now();
      try {
        const results = await searchProvider.search(planned.query, 20);
        const tagged = results.map((item) => ({
          ...item,
          discoveryQuery: planned.query,
          sourceLane: planned.lane,
        }));
        logStage("search", startedAt, {
          queryIndex: index,
          lane: planned.lane,
          results: tagged.length,
          uniqueUrls: new Set(
            tagged.map((item) => canonicalizeUrl(item.url) ?? item.url),
          ).size,
        });
        return tagged;
      } catch (error) {
        logStage("search", startedAt, { queryIndex: index, lane: planned.lane, results: 0, failed: 1 });
        throw error;
      }
    }),
  );
  const fulfilled = settled.filter(
    (item): item is PromiseFulfilledResult<Array<SearchResultItem & { discoveryQuery: string; sourceLane: SearchLane }>> =>
      item.status === "fulfilled",
  );
  if (fulfilled.length === 0) {
    logStage("total", discoveryStartedAt, { status: "failed" });
    return {
      status: "failed",
      opportunities: [],
      queries,
      warnings: ["Search provider request failed. No results were fabricated."],
      missingConfiguration: [],
      generatedAt,
    };
  }
  if (fulfilled.length < queries.length) {
    warnings.push(
      `${queries.length - fulfilled.length} of ${queries.length} searches failed; showing results from the rest.`,
    );
  }
  const candidatePool = ensureLaneRepresentation(
    prioritizeSearchResults(
      limitPerDomain(deduplicateSearchResults(fulfilled.flatMap((item) => item.value)), 2),
    ),
    3,
  );
  const candidates = candidatePool.slice(0, maxResults);
  logStage("search_total", searchStartedAt, {
    queries: queries.length,
    candidates: candidates.length,
    pool: candidatePool.length,
  });

  // In-request fetch cache: the same canonical URL is fetched at most once.
  const fetchCache = new Map<string, Promise<FetchedPage>>();
  function fetchOnce(url: string) {
    const key = canonicalizeUrl(url) ?? url;
    const cached = fetchCache.get(key);
    if (cached) return cached;
    const promise = fetchPage(url, deps.fetchDeps);
    fetchCache.set(key, promise);
    return promise;
  }

  async function withEligibility(item: Scholarship): Promise<Scholarship> {
    if (item.eligibility) return item;
    return {
      ...item,
      eligibility:
        item.retrievalStatus === "retrieved" &&
        (item.extractionStatus === "extracted" || item.extractionStatus === "partial")
          ? item.eligibility
          : createUnavailableEligibility(
              item,
              item.retrievalStatus === "failed"
                ? "The source page could not be retrieved, so eligibility requirements were not evaluated."
                : item.retrievalStatus === "not_attempted"
                  ? "This source was not checked, so eligibility requirements were not evaluated."
                  : "Scholarship details could not be extracted, so eligibility requirements are unavailable.",
            ),
    };
  }

  async function processCandidate(candidate: SearchResultItem): Promise<Scholarship> {
    const base = candidateFromSearchResult(candidate);
    const withSource = (
      item: Scholarship,
      retrievalStatus: "not_attempted" | "retrieved" | "failed",
      extractionStatus: Scholarship["extractionStatus"],
      failureKind?: string,
    ): Scholarship => ({
      ...item,
      sources: base.sources.map((source) => ({
        ...source,
        retrievalStatus,
        retrievalFailureKind: failureKind,
        extractionStatus,
        retrievedAt:
          retrievalStatus === "retrieved" ? new Date().toISOString() : source.retrievedAt,
      })),
    });
    if (Date.now() >= workDeadline) {
      logStage("fetch", Date.now(), { host: safeHost(candidate.url), skipped: "budget" });
      return withEligibility(withSource({
        ...base,
        retrievalStatus: "not_attempted" as const,
        extractionStatus: "not_attempted" as const,
        extractionError:
          "Discovery time budget reached before this source could be checked; its content was not verified.",
      }, "not_attempted", "not_attempted"));
    }
    const fetchStartedAt = Date.now();
    let page: FetchedPage;
    try {
      page = await fetchOnce(candidate.url);
      logStage("fetch", fetchStartedAt, { host: safeHost(candidate.url) });
    } catch (error) {
      logStage("fetch", fetchStartedAt, { host: safeHost(candidate.url), failed: 1 });
      const kind = error instanceof PageFetchError ? error.kind : "unknown";
      const summary = retrievalFailureSummary(kind);
      warnings.push(`${candidate.url}: ${summary}`);
      return withEligibility(withSource({
        ...base,
        retrievalStatus: "failed" as const,
        retrievalFailureKind: kind,
        retrievalError: summary,
        extractionStatus: "not_attempted" as const,
      }, "failed", "not_attempted", kind));
    }

    const extractionStartedAt = Date.now();
    try {
      const extracted = await extractScholarship(
        activeMetaClient,
        page,
        candidate.title,
      );
      logStage("extraction", extractionStartedAt, { host: safeHost(candidate.url) });
      const verifyStartedAt = Date.now();
      const verified = verifyEvidence(
        { ...extracted, retrievalStatus: "retrieved" as const },
        page.text,
      );
      logStage("verification", verifyStartedAt, { host: safeHost(candidate.url) });
      const eligibilityStartedAt = Date.now();
      const eligibility = await evaluateEligibility(profile, verified, {
        pageText: page.text,
        metaClient: activeMetaClient,
      });
      logStage("eligibility", eligibilityStartedAt, {
        host: safeHost(candidate.url),
        overallStatus: eligibility.overallStatus,
      });
      return withSource({ ...verified, eligibility }, "retrieved", verified.extractionStatus);
    } catch (error) {
      logStage("extraction", extractionStartedAt, {
        host: safeHost(candidate.url),
        failed: 1,
        kind: error instanceof ExtractionError ? error.kind : "unknown",
        issues:
          error instanceof ExtractionError ? error.issues.join(",") : "",
      });
      warnings.push(`Extraction failed for ${candidate.url}`);
      return withEligibility(withSource({
        ...base,
        extractionStatus: "failed" as const,
        extractionError: "Structured extraction failed or returned invalid data",
        retrievalStatus: "retrieved" as const,
        retrievedAt: page.retrievedAt,
      }, "retrieved", "failed"));
    }
  }

  // Bounded backfill: after failures, try further prioritized candidates
  // until maxResults successful extractions, 12 attempts, or budget end.
  const opportunities: Scholarship[] = [];
  const attemptedByLane: Record<SearchLane, number> = { official: 0, aggregator: 0, social: 0 };
  const extractedByLane: Record<SearchLane, number> = { official: 0, aggregator: 0, social: 0 };
  const failureCategories: Record<string, number> = {};
  const countFailure = (category: string) => {
    failureCategories[category] = (failureCategories[category] ?? 0) + 1;
  };
  const maxAttempts = Math.min(candidatePool.length, maxResults + 4);
  let poolIndex = 0;
  let successfulExtractions = 0;
  while (
    poolIndex < maxAttempts &&
    successfulExtractions < maxResults &&
    opportunities.length < maxAttempts
  ) {
    const batchSize = Math.min(3, maxAttempts - opportunities.length);
    const batch = candidatePool.slice(poolIndex, poolIndex + batchSize);
    poolIndex += batch.length;
    const batchResults = await mapWithConcurrency(batch, 3, processCandidate);
    opportunities.push(...batchResults);
    batch.forEach((candidate, index) => {
      const lane = laneOf(candidate);
      attemptedByLane[lane]++;
      const item = batchResults[index];
      if (item.extractionStatus === "extracted" || item.extractionStatus === "partial") {
        extractedByLane[lane]++;
      } else if (item.retrievalStatus === "failed") {
        countFailure(`fetch_${item.retrievalFailureKind ?? "unknown"}`);
      } else if (item.extractionStatus === "failed") {
        countFailure("extraction_failed");
      } else if (item.retrievalStatus === "not_attempted") {
        countFailure("budget_not_attempted");
      }
    });
    successfulExtractions += batchResults.filter(
      (item) =>
        item.extractionStatus === "extracted" || item.extractionStatus === "partial",
    ).length;
    if (Date.now() >= workDeadline) break;
  }
  logStage("candidates", discoveryStartedAt, {
    pool: candidatePool.length,
    attempted: opportunities.length,
    successfulExtractions,
    attemptedOfficial: attemptedByLane.official,
    attemptedAggregator: attemptedByLane.aggregator,
    attemptedSocial: attemptedByLane.social,
    extractedOfficial: extractedByLane.official,
    extractedAggregator: extractedByLane.aggregator,
    extractedSocial: extractedByLane.social,
  });
  logStage("failures", discoveryStartedAt, { ...failureCategories });

  const unfinished = opportunities.filter(
    (item) => item.retrievalStatus === "not_attempted",
  ).length;
  if (unfinished > 0) {
    warnings.push(
      `Discovery time budget (${Math.round(budgetMs / 1000)}s) was reached; ${unfinished} source${unfinished === 1 ? " was" : "s were"} not checked and remain unverified.`,
    );
  }

  const mergedRecords = mergeScholarshipRecords(opportunities);
  if (mergedRecords.length !== opportunities.length) {
    logStage("merge", discoveryStartedAt, {
      before: opportunities.length,
      after: mergedRecords.length,
    });
  }

  const seen = new Set<string>();
  const deduped = mergedRecords.filter((item) => {
    const key =
      canonicalizeUrl(item.officialUrl ?? item.sourceUrl ?? item.id) ??
      item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return scholarshipSchema.safeParse(item).success;
  });

  logStage("total", discoveryStartedAt, {
    status: deduped.length ? "ok" : "empty",
    opportunities: deduped.length,
    budgetMs,
  });

  return {
    status: deduped.length ? "ok" : "empty",
    opportunities: deduped,
    queries,
    warnings,
    missingConfiguration: [],
    generatedAt,
  };
}
