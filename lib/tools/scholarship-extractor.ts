import { z } from "zod";
import type { MetaModelClient } from "@/lib/ai/meta-client";
import type { Scholarship } from "@/lib/schemas/scholarship";
import type { FetchedPage } from "./page-fetcher";
import { isOfficialSourceUrl } from "./scholarship-search";

/**
 * Structured extraction (FR-03). The model interprets page text; deterministic
 * Zod validation decides what is accepted. Unknown stays null in the model
 * output and becomes `undefined` in the stored record — never invented.
 */

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_json" | "schema_validation" | "model_error" = "model_error",
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

/**
 * Evidence arrives from the model in several shapes: the requested array,
 * an object map of field -> quote (or {quote}), or occasionally a bare
 * string. Normalize what can be used safely; discard the rest. Quotes are
 * still only trusted after the verifier finds them in fetched page text.
 */
export function normalizeEvidenceInput(input: unknown): Array<{ field: string; quote: string }> {
  if (Array.isArray(input)) {
    return input.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const { field, quote } = item as { field?: unknown; quote?: unknown };
      return typeof field === "string" && field.trim() && typeof quote === "string" && quote.trim()
        ? [{ field: field.trim(), quote: quote.trim() }]
        : [];
    });
  }
  if (typeof input === "object" && input !== null) {
    return Object.entries(input).flatMap(([field, value]) => {
      if (typeof value === "string" && value.trim()) {
        return [{ field, quote: value.trim() }];
      }
      if (typeof value === "object" && value !== null) {
        const quote = (value as { quote?: unknown }).quote;
        if (typeof quote === "string" && quote.trim()) {
          return [{ field, quote: quote.trim() }];
        }
      }
      return [];
    });
  }
  return [];
}

const flexibleEvidence = z
  .unknown()
  .transform((value) => normalizeEvidenceInput(value));

const nullableText = z.string().trim().min(1).nullable();
const nullableTextList = z.array(z.string().trim().min(1)).nullable();
/** Models often return prose fields as string arrays; normalize to text. */
const flexibleText = z
  .union([z.string().trim().min(1), z.array(z.string().trim().min(1))])
  .nullable()
  .transform((value) =>
    value === null ? null : Array.isArray(value) ? value.join("; ") : value,
  );
/** Document lists may come back as one string; normalize to a list. */
const flexibleTextList = z
  .union([z.string().trim().min(1), z.array(z.string().trim().min(1))])
  .nullable()
  .transform((value) =>
    value === null ? null : Array.isArray(value) ? value : [value],
  );
/** Amounts may arrive as formatted strings ("$5,000"); unparseable stays null. */
const flexibleAmount = z
  .unknown()
  .transform((value) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string") {
      const numeric = Number(value.replace(/[^0-9.]/g, ""));
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }
    return null;
  });
/** A malformed or relative official URL must not fail the whole extraction. */
const flexibleUrl = z
  .unknown()
  .transform((value) => {
    if (typeof value !== "string") return null;
    try {
      return new URL(value).toString();
    } catch {
      return null;
    }
  });

const modelOutputSchema = z.object({
  name: nullableText,
  provider: nullableText,
  eligibleCitizenships: nullableTextList,
  eligibleDegreeLevels: nullableTextList,
  eligibleFieldsOfStudy: nullableTextList,
  studyDestinations: nullableTextList,
  academicRequirements: flexibleText,
  languageRequirements: flexibleText,
  eligibilityRequirements: flexibleText,
  applicationOpeningDate: z.iso.date().nullable(),
  applicationDeadline: z.iso.date().nullable(),
  awardAmount: flexibleAmount,
  awardCurrency: z.string().trim().length(3).nullable().catch(null),
  fundingCoverage: flexibleText,
  fundingDuration: flexibleText,
  requiredDocuments: flexibleTextList,
  applicationInstructions: flexibleText,
  officialUrl: flexibleUrl,
  evidence: flexibleEvidence,
});

export type ExtractionOutput = z.infer<typeof modelOutputSchema>;

const EXTRACTION_SYSTEM = `You extract scholarship information from source page text into JSON.
Rules:
- Use only information stated in the page text. Never guess or infer missing values.
- Use null for every field not stated on the page.
- Dates must be YYYY-MM-DD or null. Currency is a 3-letter code or null.
- For each important field you fill, add an evidence entry with the field name and an exact short quote copied verbatim from the page text.
- Return JSON only, with exactly these keys: name, provider, eligibleCitizenships, eligibleDegreeLevels, eligibleFieldsOfStudy, studyDestinations, academicRequirements, languageRequirements, eligibilityRequirements, applicationOpeningDate, applicationDeadline, awardAmount, awardCurrency, fundingCoverage, fundingDuration, requiredDocuments, applicationInstructions, officialUrl, evidence.`;

function parseModelJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ExtractionError("Model returned invalid JSON", "invalid_json");
  }
}

export async function extractScholarship(
  client: MetaModelClient,
  page: FetchedPage,
  fallbackName: string,
): Promise<Scholarship> {
  let raw: string;
  try {
    raw = await client.complete([
      { role: "system", content: EXTRACTION_SYSTEM },
      {
        role: "user",
        content: `Source URL: ${page.finalUrl}\nPage title: ${page.title ?? "unknown"}\n\nPage text:\n${page.text.slice(0, 20_000)}`,
      },
    ]);
  } catch {
    throw new ExtractionError("Model request failed", "model_error");
  }

  const parsed = modelOutputSchema.safeParse(parseModelJson(raw));
  if (!parsed.success) {
    throw new ExtractionError(
      "Model output failed schema validation",
      "schema_validation",
      parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
    );
  }
  const output = parsed.data;

  const present = [
    output.provider,
    output.applicationDeadline,
    output.awardAmount,
    output.eligibilityRequirements,
  ].filter((value) => value !== null).length;

  return {
    id: page.finalUrl,
    name: output.name ?? fallbackName,
    provider: output.provider ?? undefined,
    sourceUrl: page.url,
    sourceTitle: page.title,
    eligibleCitizenships: output.eligibleCitizenships ?? undefined,
    eligibleDegreeLevels: output.eligibleDegreeLevels ?? undefined,
    eligibleFieldsOfStudy: output.eligibleFieldsOfStudy ?? undefined,
    studyDestinations: output.studyDestinations ?? undefined,
    academicRequirements: output.academicRequirements ?? undefined,
    languageRequirements: output.languageRequirements ?? undefined,
    eligibilityRequirements: output.eligibilityRequirements ?? undefined,
    applicationOpeningDate: output.applicationOpeningDate ?? undefined,
    applicationDeadline: output.applicationDeadline ?? undefined,
    awardAmount: output.awardAmount ?? undefined,
    awardCurrency: output.awardCurrency?.toUpperCase(),
    fundingCoverage: output.fundingCoverage ?? undefined,
    fundingDuration: output.fundingDuration ?? undefined,
    requiredDocuments: output.requiredDocuments ?? undefined,
    applicationInstructions: output.applicationInstructions ?? undefined,
    // An aggregator page is never its own official application page. Only
    // keep an official URL when its host independently classifies as an
    // official source, or when the fetched page itself is official.
    officialUrl:
      output.officialUrl && isOfficialSourceUrl(output.officialUrl)
        ? output.officialUrl
        : isOfficialSourceUrl(page.finalUrl)
          ? page.finalUrl
          : undefined,
    evidence: output.evidence.map((item) => ({
      field: item.field,
      quote: item.quote,
      sourceUrl: page.finalUrl,
      retrievedAt: page.retrievedAt,
    })),
    verificationStatus: "unverified",
    extractionStatus: present >= 2 ? "extracted" : "partial",
    retrievalStatus: "retrieved",
    sources: [],
    availabilityStatus: "unknown",
    retrievedAt: page.retrievedAt,
  };
}
