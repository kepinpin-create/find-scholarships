/**
 * Single server-side interface to the Meta Model API.
 *
 * Verified against official Meta documentation (dev.meta.ai/docs):
 * - Base URL: https://api.meta.ai/v1
 * - Endpoint: POST /chat/completions (OpenAI-compatible messages format)
 * - Auth: `Authorization: Bearer <MODEL_API_KEY>`
 * - Example model identifier: muse-spark-1.3
 *
 * Credentials stay server-side. Nothing here logs the API key.
 */

export interface MetaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MetaModelClient {
  complete(messages: MetaMessage[]): Promise<string>;
}

export class MetaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaConfigurationError";
  }
}

export class MetaRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaRequestError";
  }
}

export interface MetaConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
}

export function getMetaConfig(env: Record<string, string | undefined> = process.env): MetaConfig {
  return {
    // Official name is MODEL_API_KEY; META_API_KEY kept as a fallback alias.
    apiKey: env.MODEL_API_KEY ?? env.META_API_KEY,
    model: env.META_MODEL?.trim() || "muse-spark-1.3",
    baseUrl: (env.META_API_BASE_URL?.trim() || "https://api.meta.ai/v1").replace(
      /\/$/,
      "",
    ),
  };
}

export function isMetaConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(getMetaConfig(env).apiKey?.trim());
}

type FetchFn = typeof fetch;

export class MetaApiClient implements MetaModelClient {
  constructor(
    private config: MetaConfig,
    private fetchFn: FetchFn = fetch,
    private timeoutMs = 90_000,
  ) {}

  async complete(messages: MetaMessage[]): Promise<string> {
    if (!this.config.apiKey?.trim()) {
      throw new MetaConfigurationError(
        "Meta Model API is not configured: set MODEL_API_KEY in .env.local",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.config.model, messages }),
        signal: controller.signal,
      });
    } catch {
      throw new MetaRequestError("Meta Model API request failed or timed out");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new MetaRequestError(
        `Meta Model API returned HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MetaRequestError("Meta Model API returned invalid JSON");
    }

    const text = extractContentText(payload);
    if (text === null) {
      throw new MetaRequestError("Meta Model API returned no message content");
    }
    return text;
  }
}

function extractContentText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === "object" && part !== null &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

export function createMetaClient(
  env: Record<string, string | undefined> = process.env,
): MetaModelClient | null {
  if (!isMetaConfigured(env)) return null;
  return new MetaApiClient(getMetaConfig(env));
}
