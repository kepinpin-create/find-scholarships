import type { StudentProfile } from "@/lib/schemas/student";
import { getMetaConfig } from "@/lib/ai/meta-client";
import type { SourceReference, SourceType } from "@/lib/schemas/scholarship";

/**
 * Scholarship search (FR-02).
 *
 * Provider logic stays behind the SearchProvider interface so the search
 * backend can be replaced. The implemented provider is Brave Web Search,
 * verified against its official documentation:
 * - GET https://api.search.brave.com/res/v1/web/search?q=...&count=...
 * - Header: X-Subscription-Token: <BRAVE_SEARCH_API_KEY>
 * - Response: web.results[] with title, url, description
 */

export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  /** Query lane/text that discovered this result, when known. */
  discoveryQuery?: string;
  sourceLane?: "official" | "aggregator" | "social";
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResultItem[]>;
}

export class SearchConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchConfigurationError";
  }
}

export class SearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchRequestError";
  }
}

type FetchFn = typeof fetch;

export class BraveSearchProvider implements SearchProvider {
  readonly name = "brave";

  constructor(
    private apiKey: string,
    private fetchFn: FetchFn = fetch,
    private timeoutMs = 15_000,
  ) {}

  async search(query: string, limit: number): Promise<SearchResultItem[]> {
    if (!this.apiKey.trim()) {
      throw new SearchConfigurationError(
        "Brave Search is not configured: set BRAVE_SEARCH_API_KEY in .env.local",
      );
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(Math.max(limit, 1), 20)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: controller.signal,
      });
    } catch {
      throw new SearchRequestError("Search request failed or timed out");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new SearchRequestError(
        `Search provider returned HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SearchRequestError("Search provider returned invalid JSON");
    }

    const results = (payload as { web?: { results?: unknown } })?.web?.results;
    if (!Array.isArray(results)) return [];

    return results.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const { title, url: resultUrl, description } = item as {
        title?: unknown;
        url?: unknown;
        description?: unknown;
      };
      if (typeof title !== "string" || typeof resultUrl !== "string") return [];
      return [
        {
          title,
          url: resultUrl,
          snippet: typeof description === "string" ? description : undefined,
        },
      ];
    });
  }
}

/**
 * Meta-native search via the Responses API `web_search` tool.
 * Verified against official docs (dev.meta.ai/docs/search-grounding):
 * POST {baseUrl}/responses, Bearer MODEL_API_KEY,
 * tools: [{type: "web_search"}], include: ["web_search_call.results"].
 * Search is model-decided: no web_search_call means no results, never
 * model-knowledge substitutes. Citations are candidate sources only;
 * they do not become verified evidence without our own page fetch.
 */
export class MetaSearchProvider implements SearchProvider {
  readonly name = "meta";

  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string,
    private fetchFn: FetchFn = fetch,
    private timeoutMs = 90_000,
  ) {}

  async search(query: string, limit: number): Promise<SearchResultItem[]> {
    const startedAt = Date.now();
    if (!this.apiKey.trim()) {
      throw new SearchConfigurationError(
        "Meta search is not configured: set MODEL_API_KEY in .env.local",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          // Best-effort bound: the model decides whether/how often to
          // search, so this instruction is measured via call counts in
          // logs rather than assumed to be enforced.
          input: `Perform exactly one web search for official scholarship opportunities matching: ${query}. Prioritize official provider, government, and university pages. Then stop searching and summarize the sources you found with citations.`,
          tools: [{ type: "web_search", search_context_size: "medium" }],
          include: ["web_search_call.results"],
        }),
        signal: controller.signal,
      });
    } catch {
      throw new SearchRequestError("Meta search request failed or timed out");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new SearchRequestError(
        `Meta search returned HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SearchRequestError("Meta search returned invalid JSON");
    }

    const results = parseMetaSearchResults(payload, limit);
    const metrics = measureMetaSearchResults(payload);
    console.info(
      "[discovery]",
      JSON.stringify({
        stage: "search_provider",
        provider: "meta",
        durationMs: Math.round(Date.now() - startedAt),
        webSearchCalls: metrics.webSearchCalls,
        rawResults: metrics.rawResults,
        uniqueUrls: metrics.uniqueUrls,
        returnedResults: results.length,
      }),
    );
    return results;
  }
}

export function measureMetaSearchResults(payload: unknown): {
  webSearchCalls: number;
  rawResults: number;
  uniqueUrls: number;
} {
  const output = (payload as { output?: unknown })?.output;
  if (!Array.isArray(output)) {
    return { webSearchCalls: 0, rawResults: 0, uniqueUrls: 0 };
  }
  let webSearchCalls = 0;
  const urls: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: unknown; results?: unknown };
    if (record.type === "web_search_call") {
      webSearchCalls++;
      if (Array.isArray(record.results)) {
        for (const result of record.results) {
          if (
            typeof result === "object" &&
            result !== null &&
            typeof (result as { url?: unknown }).url === "string"
          ) {
            urls.push((result as { url: string }).url);
          }
        }
      }
    }
  }
  return {
    webSearchCalls,
    rawResults: urls.length,
    uniqueUrls: new Set(urls.map((url) => canonicalizeUrl(url) ?? url)).size,
  };
}

export function parseMetaSearchResults(
  payload: unknown,
  limit: number,
): SearchResultItem[] {
  const output = (payload as { output?: unknown })?.output;
  if (!Array.isArray(output)) return [];

  const items: SearchResultItem[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: unknown; results?: unknown; content?: unknown };

    if (record.type === "web_search_call" && Array.isArray(record.results)) {
      for (const result of record.results) {
        if (typeof result !== "object" || result === null) continue;
        const { title, url, snippet } = result as {
          title?: unknown;
          url?: unknown;
          snippet?: unknown;
        };
        if (typeof title === "string" && typeof url === "string") {
          items.push({
            title,
            url,
            snippet: typeof snippet === "string" ? snippet : undefined,
          });
        }
      }
    }

    // Fallback: cited sources when raw results were not returned.
    if (record.type === "message" && Array.isArray(record.content)) {
      for (const block of record.content) {
        if (typeof block !== "object" || block === null) continue;
        const annotations = (block as { annotations?: unknown }).annotations;
        if (!Array.isArray(annotations)) continue;
        for (const annotation of annotations) {
          if (typeof annotation !== "object" || annotation === null) continue;
          const { type, title, url } = annotation as {
            type?: unknown;
            title?: unknown;
            url?: unknown;
          };
          if (type === "url_citation" && typeof url === "string") {
            items.push({
              title: typeof title === "string" ? title : url,
              url,
            });
          }
        }
      }
    }
  }

  return deduplicateSearchResults(items).slice(0, Math.max(limit, 1));
}

export function createSearchProvider(
  env: Record<string, string | undefined> = process.env,
): SearchProvider | null {
  const provider = (env.SEARCH_PROVIDER?.trim() || "brave").toLowerCase();
  if (provider === "meta") {
    const config = getMetaConfig(env);
    if (!config.apiKey?.trim()) return null;
    return new MetaSearchProvider(config.apiKey, config.model, config.baseUrl);
  }
  if (provider !== "brave") return null;
  const apiKey = env.BRAVE_SEARCH_API_KEY ?? env.SEARCH_API_KEY;
  if (!apiKey?.trim()) return null;
  return new BraveSearchProvider(apiKey);
}

/** Canonical URL used for deduplication: no hash, tracking params, or trailing slash. */
export function canonicalizeUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || key === "fbclid" || key === "gclid") {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  const normalized = url.toString();
  return normalized.endsWith("/") && url.pathname === "/"
    ? normalized.slice(0, -1)
    : normalized.replace(/\/$/, "");
}

export function deduplicateSearchResults(
  items: SearchResultItem[],
): SearchResultItem[] {
  const seen = new Set<string>();
  const unique: SearchResultItem[] = [];
  for (const item of items) {
    const key = canonicalizeUrl(item.url);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

const LOW_PRIORITY_HOSTS = [
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "medium.com",
  "scholarshipsads.com",
  "scholarshippositions.com",
  "scholarpositions.com",
  "scholarsroad.org",
  "fullyscholarships.com",
  "scholarshipunion.com",
  "globalscholarships.com",
  "scholarships365.info",
  "opportunitiesinfo.com",
];

/** Recognised scholarship-provider domains treated as official sources. */
const OFFICIAL_PROVIDER_HOSTS = [
  "chevening.org",
  "lpdp.kemenkeu.go.id",
  "kemenkeu.go.id",
  "daad.de",
  "daad-indonesia.org",
  "australiaawardsindonesia.org",
  "australiaawards.gov.au",
  "aminef.or.id",
  "fulbright.org",
  "mext.go.jp",
  "studyinjapan.go.jp",
];

export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const SOCIAL_HOSTS = ["instagram.com", "facebook.com", "tiktok.com", "youtube.com", "youtu.be", "x.com", "twitter.com"];
const GOVERNMENT_HOSTS = ["lpdp.kemenkeu.go.id", "kemenkeu.go.id", "australiaawards.gov.au", "mext.go.jp", "studyinjapan.go.jp"];

/** Classify a discovered URL by publisher/source type. Host-based only. */
export function classifySource(rawUrl: string): {
  sourceType: SourceType;
  publisherHost: string;
  handle?: string;
} {
  const host = hostOf(rawUrl);
  let handle: string | undefined;
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    if (SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) {
      handle = parts[0];
    }
  } catch {
    // Invalid URLs classify as unknown below.
  }

  if (!host) return { sourceType: "unknown", publisherHost: "unknown" };
  if (SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) {
    return { sourceType: "social", publisherHost: host, handle };
  }
  if (isKnownAggregatorHost(host)) return { sourceType: "aggregator", publisherHost: host };
  if (
    GOVERNMENT_HOSTS.some((gov) => host === gov || host.endsWith(`.${gov}`)) ||
    /(^|\.)gov(\.|$)/.test(host) ||
    /(^|\.)go\.id$/.test(host)
  ) {
    return { sourceType: "government", publisherHost: host };
  }
  if (
    CURATED_UNIVERSITY_HOSTS.some((uni) => host === uni || host.endsWith(`.${uni}`)) ||
    /(^|\.)ac\.[a-z]{2}$/.test(host) ||
    /(^|\.)edu(\.[a-z]{2})?$/.test(host) ||
    host.includes("university") ||
    host.includes("universitas")
  ) {
    return { sourceType: "university", publisherHost: host };
  }
  if (isOfficialSourceUrl(rawUrl)) return { sourceType: "official_provider", publisherHost: host };
  if (host.includes("blog") || host.endsWith(".blog")) return { sourceType: "blog", publisherHost: host };
  return { sourceType: "unknown", publisherHost: host };
}

export function sourceReferenceFor(
  rawUrl: string,
  extra: Partial<SourceReference> = {},
): SourceReference {
  const classified = classifySource(rawUrl);
  const canonical = canonicalizeUrl(rawUrl) ?? rawUrl;
  return {
    id: canonical,
    url: rawUrl,
    canonicalUrl: canonical,
    sourceType: classified.sourceType,
    publisherHost: classified.publisherHost,
    handle: classified.handle,
    retrievalStatus: "not_attempted",
    extractionStatus: "not_attempted",
    ...extra,
  };
}

export function isKnownAggregatorHost(host: string): boolean {
  return LOW_PRIORITY_HOSTS.some(
    (low) => host === low || host.endsWith(`.${low}`),
  );
}

/**
 * Whether a URL host is treated as an official source for officialUrl
 * assignment. Based on the host only — never on a page title or the
 * scholarship name. Known aggregators are never official.
 */
export function isOfficialSourceUrl(rawUrl: string): boolean {
  const host = hostOf(rawUrl);
  if (!host || isKnownAggregatorHost(host)) return false;
  if (
    OFFICIAL_PROVIDER_HOSTS.some(
      (official) => host === official || host.endsWith(`.${official}`),
    )
  ) {
    return true;
  }
  return (
    CURATED_UNIVERSITY_HOSTS.some((uni) => host === uni || host.endsWith(`.${uni}`)) ||
    /(^|\.)gov(\.|$)/.test(host) ||
    /(^|\.)go\.id$/.test(host) ||
    /(^|\.)ac\.[a-z]{2}$/.test(host) ||
    /(^|\.)edu(\.[a-z]{2})?$/.test(host) ||
    host.includes("university") ||
    host.includes("universitas")
  );
}

/**
 * Deterministic official-source preference for candidate ordering.
 * Government and university hosts first, recognised providers and .org
 * foundations next, aggregators and social/video hosts last. This only
 * orders fetching; it never verifies a claim.
 */
export function sourcePriority(item: SearchResultItem): number {
  const host = hostOf(item.url);
  if (!host) return -10;

  if (isKnownAggregatorHost(host)) return 0;
  // Many destination universities use plain country domains (utwente.nl,
  // rug.nl) with no .edu/.ac marker. For ranking only, a university-named
  // publisher with a scholarship path is treated like an official source.
  const titleLooksUniversity = /universit|universiteit|universität/i.test(item.title);
  if (isOfficialSourceUrl(item.url) || titleLooksUniversity) {
    // On official domains, real scholarship/application pages outrank
    // news, partnership, and general listing pages.
    let path = "";
    try {
      path = new URL(item.url).pathname.toLowerCase();
    } catch {
      path = "";
    }
    return /(scholarship|beasiswa|funding|tuition|apply|application|admission)/.test(path) ? 4 : 3;
  }
  if (host.endsWith(".org") || host.endsWith(".org.uk")) return 2;
  return 1;
}

export function prioritizeSearchResults(
  items: SearchResultItem[],
): SearchResultItem[] {
  return items
    .map((item, index) => ({ item, index, score: sourcePriority(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

/** Keep at most `maxPerDomain` URLs per hostname, preserving order. */
export function limitPerDomain(
  items: SearchResultItem[],
  maxPerDomain = 2,
): SearchResultItem[] {
  const counts = new Map<string, number>();
  return items.filter((item) => {
    const host = hostOf(item.url) || item.url;
    const count = counts.get(host) ?? 0;
    if (count >= maxPerDomain) return false;
    counts.set(host, count + 1);
    return true;
  });
}

const degreeLabel: Record<StudentProfile["intendedDegreeLevel"], string> = {
  diploma: "diploma",
  bachelor: "bachelor undergraduate",
  master: "master graduate",
  doctorate: "PhD doctoral",
  other: "",
};

export const CURATED_UNIVERSITY_HOSTS = [
  "utwente.nl", "rug.nl", "tudelft.nl", "uu.nl", "maastrichtuniversity.nl",
  "vu.nl", "uva.nl", "eur.nl", "tue.nl", "wur.nl", "leidenuniv.nl",
  "tilburguniversity.edu", "radboud.nl",
  "u-tokyo.ac.jp", "kyoto-u.ac.jp", "osaka-u.ac.jp", "tohoku.ac.jp",
  "titech.ac.jp", "kyushu-u.ac.jp", "hokkaido.ac.jp", "nagoya-u.ac.jp",
];

const DESTINATION_SITE_HINTS: Record<string, string> = {
  netherlands:
    "(site:utwente.nl OR site:rug.nl OR site:tudelft.nl OR site:uu.nl OR site:maastrichtuniversity.nl OR site:vu.nl OR site:uva.nl OR site:eur.nl OR site:tue.nl OR site:wur.nl OR site:leidenuniv.nl OR site:tilburguniversity.edu OR site:radboud.nl)",
  japan:
    "(site:u-tokyo.ac.jp OR site:kyoto-u.ac.jp OR site:osaka-u.ac.jp OR site:tohoku.ac.jp OR site:titech.ac.jp OR site:kyushu-u.ac.jp OR site:hokkaido.ac.jp OR site:nagoya-u.ac.jp)",
  indonesia: "site:.ac.id OR site:.go.id",
  germany: "site:.de",
  australia: "site:.edu.au",
  "united kingdom": "site:.ac.uk",
  "united states": "site:.edu",
  singapore: "site:.edu.sg",
  malaysia: "site:.edu.my",
  "south korea": "site:.ac.kr",
  canada: "site:.ca",
  france: "site:.fr",
};

export type SearchLane = "official" | "aggregator" | "social";

export interface PlannedSearchQuery {
  lane: SearchLane;
  query: string;
}

/**
 * Multi-source query lanes (Phase C). At most three parallel searches:
 * one official-targeted, one aggregator lead search, and one public
 * Instagram discovery search. Social results are leads only — no login,
 * no private access, and no claim of comprehensive Instagram coverage.
 */
export function buildSourceSearchQueries(profile: StudentProfile): PlannedSearchQuery[] {
  const degree = degreeLabel[profile.intendedDegreeLevel];
  const field = profile.fieldOfStudy.trim();
  const citizenship = profile.citizenship?.trim();
  const destination = profile.preferredDestinations
    ?.map((item) => item.trim())
    .filter(Boolean)[0];

  // Official lane targets destination universities' own scholarship pages
  // (e.g. utwente.nl for Netherlands), not home-country university listings
  // whose fellowships are often restricted to their own students.
  const official = destination
    ? [
        destination,
        "universities",
        degree,
        "scholarship for international students",
        citizenship,
        field,
        "official university scholarship application",
        DESTINATION_SITE_HINTS[destination.toLowerCase()] ?? "",
      ]
        .filter(Boolean)
        .join(" ")
    : [citizenship, degree, "scholarship", field, "official university government"]
        .filter(Boolean)
        .join(" ");

  const aggregator = [degree, "scholarship", field, citizenship, "scholarship portal opportunities"]
    .filter(Boolean)
    .join(" ");

  const socialTerm = citizenship && /indonesia/i.test(citizenship) ? "beasiswa" : "scholarship";
  // Testimonial intent: recipient stories and awardee announcements are the
  // useful social signal. Results stay discovery leads only — never evidence.
  const socialProof =
    citizenship && /indonesia/i.test(citizenship)
      ? "testimoni penerima awardee pengalaman"
      : "testimonial awardee recipient story experience";
  const social = `site:instagram.com ${socialTerm} ${socialProof} ${degree} ${field} ${citizenship ?? ""}`.replace(/\s+/g, " ").trim();

  return [
    { lane: "official" as const, query: official },
    { lane: "aggregator" as const, query: aggregator },
    { lane: "social" as const, query: social },
  ];
}

/**
 * Deterministic query planning: at most two targeted queries — one base
 * profile query plus one destination query for the first preferred
 * destination when present. The previously-used generic "fully funded"
 * query overlapped the base query substantially and was removed. No
 * university is ever required.
 */
export function buildSearchQueries(profile: StudentProfile): string[] {
  const degree = degreeLabel[profile.intendedDegreeLevel];
  const field = profile.fieldOfStudy.trim();
  const citizenship = profile.citizenship?.trim();
  const queries: string[] = [];

  const base = [citizenship, degree, "scholarship", field, "official"]
    .filter(Boolean)
    .join(" ");
  queries.push(base);

  const destination = profile.preferredDestinations
    ?.map((item) => item.trim())
    .filter(Boolean)[0];
  if (destination) {
    queries.push(
      [destination, degree, "scholarship for international students", field, "official"]
        .filter(Boolean)
        .join(" "),
    );
  }

  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()))]
    .filter(Boolean)
    .slice(0, 2);
}
