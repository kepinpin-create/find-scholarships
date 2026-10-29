import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { RetrievalFailureKind } from "@/lib/schemas/scholarship";

/**
 * Safe retrieval of public scholarship pages (FR-02/FR-03).
 *
 * SSRF protections:
 * - http/https only, no URL credentials
 * - hostnames must not be localhost and must resolve only to public IPs
 *   (private, loopback, link-local, and cloud-metadata ranges are blocked)
 * - redirects are followed manually (max 3) and every hop is re-validated
 * - 10s timeout, 1.5 MB response cap, HTML/plain-text content only
 */

export interface FetchedPage {
  /** URL originally requested. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  title?: string;
  text: string;
  retrievedAt: string;
}

export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly kind: RetrievalFailureKind = "unknown",
    readonly status?: number,
  ) {
    super(message);
    this.name = "PageFetchError";
  }
}

/** User-safe one-line summary for a retrieval failure kind. */
export function retrievalFailureSummary(kind: RetrievalFailureKind): string {
  switch (kind) {
    case "http_403":
      return "Source returned HTTP 403 (access denied); its content was not verified.";
    case "http_404":
      return "Source returned HTTP 404 (not found); its content was not verified.";
    case "http_error":
      return "Source returned an HTTP error; its content was not verified.";
    case "timeout":
      return "Source took too long to respond; its content was not verified.";
    case "unsupported_content":
      return "Source content type is not supported for text extraction; its content was not verified.";
    case "blocked":
      return "Source address was blocked for safety; its content was not verified.";
    case "network":
      return "Source could not be reached; its content was not verified.";
    case "upstream_protocol":
      return "Source response could not be parsed safely; its content was not verified.";
    default:
      return "Source could not be retrieved; its content was not verified.";
  }
}

type FetchFn = typeof fetch;
type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export interface PageFetcherDeps {
  fetchFn?: FetchFn;
  lookupFn?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /**
   * Narrow fallback for upstream responses Node fetch cannot parse
   * (invalid header characters). Uses Node http/https with the same
   * SSRF validation performed by fetchPage before every hop.
   */
  nativeFetchFn?: (url: URL, timeoutMs: number, maxBytes: number) => Promise<Response>;
  nativeFallback?: boolean;
}

export function isHeaderParseFailure(error: unknown): boolean {
  const text = [
    error instanceof Error ? error.message : "",
    error instanceof Error && "cause" in error
      ? String((error as { cause?: { message?: unknown } }).cause?.message ?? "")
      : "",
  ].join(" ");
  return /invalid header value char|response does not match the http\/1\.1 protocol/i.test(text);
}

/**
 * Native transport used only after a header-parse failure. It does not
 * follow redirects itself; fetchPage revalidates every redirect hop.
 */
export async function nativeFetch(
  url: URL,
  timeoutMs: number,
  maxBytes: number,
): Promise<Response> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        insecureHTTPParser: true,
        headers: { Accept: "text/html,text/plain;q=0.9" },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let received = 0;
        incoming.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > maxBytes) {
            request.destroy(new PageFetchError("Response exceeds the size limit", "unsupported_content"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          const headers = new Headers();
          const contentType = incoming.headers["content-type"];
          if (contentType) headers.set("content-type", Array.isArray(contentType) ? contentType[0] : contentType);
          const location = incoming.headers.location;
          if (location) headers.set("location", Array.isArray(location) ? location[0] : location);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 502,
              headers,
            }),
          );
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new PageFetchError("Page retrieval timed out", "timeout"));
    });
    request.on("error", reject);
    request.end();
  });
}

const defaultLookup: LookupFn = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address }));
};

export function isPrivateIp(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (ip.includes(":")) {
    return (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fe80:") ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("::ffff:127.") ||
      ip.startsWith("::ffff:10.") ||
      ip.startsWith("::ffff:192.168.") ||
      ip.startsWith("::ffff:169.254.")
    );
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export async function assertPublicUrl(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PageFetchError("Malformed URL", "blocked");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageFetchError("Only http and https URLs are allowed", "blocked");
  }
  if (url.username || url.password) {
    throw new PageFetchError("URLs with credentials are not allowed", "blocked");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new PageFetchError("Local or internal hostnames are blocked", "blocked");
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(hostname);
  } catch {
    throw new PageFetchError("Hostname could not be resolved", "network");
  }
  if (addresses.length === 0) {
    throw new PageFetchError("Hostname could not be resolved", "network");
  }
  if (addresses.some((record) => isPrivateIp(record.address))) {
    throw new PageFetchError("Private or reserved network addresses are blocked", "blocked");
  }

  return url;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()) || undefined
    : undefined;

  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

  return { title, text };
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PageFetchError("Response exceeds the size limit", "unsupported_content");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PageFetchError("Response exceeds the size limit", "unsupported_content");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchPage(
  rawUrl: string,
  deps: PageFetcherDeps = {},
): Promise<FetchedPage> {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxBytes = deps.maxBytes ?? 1_500_000;
  const maxRedirects = deps.maxRedirects ?? 3;

  let current = await assertPublicUrl(rawUrl, lookupFn);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html,text/plain;q=0.9" },
      });
    } catch (error) {
      const headerParseFailure = isHeaderParseFailure(error);
      const canFallback =
        headerParseFailure &&
        (deps.nativeFetchFn !== undefined ||
          (deps.fetchFn === undefined && deps.nativeFallback !== false));
      if (canFallback) {
        try {
          response = await (deps.nativeFetchFn ?? nativeFetch)(current, timeoutMs, maxBytes);
        } catch {
          throw new PageFetchError(
            "Source response could not be parsed safely",
            "upstream_protocol",
          );
        }
      } else {
        throw new PageFetchError(
          controller.signal.aborted
            ? "Page retrieval timed out"
            : headerParseFailure
              ? "Source response could not be parsed safely"
              : "Page could not be retrieved",
          controller.signal.aborted
            ? "timeout"
            : headerParseFailure
              ? "upstream_protocol"
              : "network",
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new PageFetchError("Redirect without a destination", "http_error");
      if (hop === maxRedirects) throw new PageFetchError("Too many redirects", "http_error");
      const next = new URL(location, current).toString();
      current = await assertPublicUrl(next, lookupFn);
      continue;
    }

    if (!response.ok) {
      const kind =
        response.status === 403
          ? "http_403"
          : response.status === 404
            ? "http_404"
            : "http_error";
      throw new PageFetchError(
        `Page returned HTTP ${response.status}`,
        kind,
        response.status,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain/i.test(contentType)) {
      throw new PageFetchError("Unsupported content type", "unsupported_content");
    }

    const body = await readLimited(response, maxBytes);
    const { title, text } = contentType.includes("text/html")
      ? htmlToText(body)
      : { title: undefined, text: body.replace(/\s+/g, " ").trim() };

    return {
      url: rawUrl,
      finalUrl: current.toString(),
      status: response.status,
      title,
      text: text.slice(0, 30_000),
      retrievedAt: new Date().toISOString(),
    };
  }

  throw new PageFetchError("Too many redirects", "http_error");
}
