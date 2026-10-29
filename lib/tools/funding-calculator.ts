import { z } from "zod";
import type { MetaModelClient } from "@/lib/ai/meta-client";
import {
  fundingPlanInputSchema,
  scholarshipFundingScenarioSchema,
  type ConfirmedFundingItem,
  type FundingPlanInput,
  type ScholarshipFundingScenario,
  type StudyCostItem,
} from "@/lib/schemas/funding";
import type { Scholarship } from "@/lib/schemas/scholarship";

/**
 * Deterministic funding-gap calculator (Phase 4).
 *
 * Formula for every currency that can be compared reliably:
 *   confirmed gap = max(0, total period costs - confirmed funding)
 *   scenario gap  = max(0, total period costs - confirmed funding - one
 *                   potential scholarship scenario)
 * Potential awards never reduce the confirmed gap, and multiple
 * scholarship scenarios are never summed together. Unknown coverage is
 * not full coverage and unknown amounts are never converted to zero.
 */

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

export interface NormalizedTotal {
  /** Converted total in the target currency; null when no known costs exist. */
  amount: number | null;
  /** Amounts that could not be converted and remain separate. */
  unconverted: CurrencyAmount[];
  /** False when some known amounts could not be converted. */
  complete: boolean;
}

export interface FundingScenarioResult extends NormalizedTotal {
  scholarshipId: string;
  scholarshipName: string;
  eligibilityStatus: ScholarshipFundingScenario["eligibilityStatus"];
  availabilityStatus: ScholarshipFundingScenario["availabilityStatus"];
  /** Remaining gap if this single unawarded scenario were received. */
  scenarioGap: number | null;
  coverageStatus: "known_amount" | "known_coverage_unknown_amount" | "unknown";
  assumptions: string[];
  coverageItems: ScholarshipFundingScenario["coverageItems"];
}

export interface FundingCalculation {
  targetCurrency: string;
  studyPeriodYears: number;
  costBreakdown: Array<{
    category: StudyCostItem["category"];
    total: NormalizedTotal;
  }>;
  totalCosts: NormalizedTotal;
  confirmedFunding: NormalizedTotal;
  /** Gap after confirmed funding only; potential awards do not change it. */
  confirmedGap: number | null;
  scenarios: FundingScenarioResult[];
  assumptions: string[];
  warnings: string[];
}

function periodsPerYear(frequency: StudyCostItem["frequency"]): number {
  switch (frequency) {
    case "monthly":
      return 12;
    case "semesterly":
      return 2;
    case "annual":
      return 1;
    case "one_time":
      return 0;
  }
}

export function normalizeItemTotal(
  item: Pick<StudyCostItem, "amount" | "frequency" | "durationYears">,
  studyPeriodYears: number,
): number {
  if (item.frequency === "one_time") return item.amount;
  const years = Math.min(item.durationYears ?? studyPeriodYears, studyPeriodYears);
  return item.amount * periodsPerYear(item.frequency) * years;
}

function rateFor(
  fromCurrency: string,
  targetCurrency: string,
  input: FundingPlanInput,
): number | null {
  if (fromCurrency === targetCurrency) return 1;
  const rate = input.exchangeRates.find(
    (item) => item.fromCurrency === fromCurrency && item.toCurrency === targetCurrency,
  );
  return rate?.rate ?? null;
}

function totalize(
  entries: Array<{ amount: number; currency: string }>,
  input: FundingPlanInput,
): NormalizedTotal {
  let converted = 0;
  let hasConverted = false;
  const unconvertedMap = new Map<string, number>();

  for (const entry of entries) {
    const rate = rateFor(entry.currency, input.targetCurrency, input);
    if (rate === null) {
      unconvertedMap.set(
        entry.currency,
        (unconvertedMap.get(entry.currency) ?? 0) + entry.amount,
      );
    } else {
      converted += entry.amount * rate;
      hasConverted = true;
    }
  }

  const unconverted = [...unconvertedMap.entries()].map(([currency, amount]) => ({
    currency,
    amount,
  }));
  return {
    amount: hasConverted ? converted : null,
    unconverted,
    complete: unconverted.length === 0,
  };
}

function dedupeCosts(costs: StudyCostItem[]): { items: StudyCostItem[]; removed: number } {
  const seen = new Set<string>();
  const items: StudyCostItem[] = [];
  for (const cost of costs) {
    const key = [
      cost.category,
      cost.label.toLowerCase(),
      cost.amount,
      cost.currency,
      cost.frequency,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(cost);
  }
  return { items, removed: costs.length - items.length };
}

function dedupeConfirmed(items: ConfirmedFundingItem[]): ConfirmedFundingItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.label.toLowerCase(), item.amount, item.currency, item.frequency].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function calculateFundingPlan(
  rawInput: FundingPlanInput,
  rawScenarios: ScholarshipFundingScenario[] = [],
): FundingCalculation {
  const input = fundingPlanInputSchema.parse(rawInput);
  const scenarios = rawScenarios.map((scenario) =>
    scholarshipFundingScenarioSchema.parse(scenario),
  );
  const assumptions: string[] = [
    `All recurring amounts are normalized over the selected ${input.studyPeriodYears}-year study period.`,
    "Potential scholarships are unawarded scenarios and do not reduce the confirmed funding gap.",
    "Each scholarship scenario is evaluated separately; scenarios are never added together.",
  ];
  const warnings: string[] = [];

  const { items: costs, removed } = dedupeCosts(input.costs);
  if (removed > 0) warnings.push(`${removed} duplicate cost entr${removed === 1 ? "y was" : "ies were"} ignored to prevent double-counting.`);
  const confirmedItems = dedupeConfirmed(input.confirmedFunding);
  if (confirmedItems.length !== input.confirmedFunding.length) {
    warnings.push("Duplicate confirmed funding entries were ignored to prevent double-counting.");
  }

  const categories = [...new Set(costs.map((item) => item.category))];
  const costBreakdown = categories.map((category) => ({
    category,
    total: totalize(
      costs
        .filter((item) => item.category === category)
        .map((item) => ({
          amount: normalizeItemTotal(item, input.studyPeriodYears),
          currency: item.currency,
        })),
      input,
    ),
  }));

  const totalCosts = totalize(
    costs.map((item) => ({
      amount: normalizeItemTotal(item, input.studyPeriodYears),
      currency: item.currency,
    })),
    input,
  );
  if (costs.length === 0) {
    warnings.push("No study costs were entered, so total costs and the funding gap are unknown — not zero.");
  }
  if (!totalCosts.complete) {
    warnings.push("Some costs use currencies without a supplied exchange rate; those amounts remain separate and are excluded from the converted gap.");
  }

  const confirmedFunding = totalize(
    confirmedItems.map((item) => ({
      amount: normalizeItemTotal(item, input.studyPeriodYears),
      currency: item.currency,
    })),
    input,
  );

  const confirmedGap =
    totalCosts.amount === null
      ? null
      : Math.max(0, totalCosts.amount - (confirmedFunding.amount ?? 0));

  const scenarioResults: FundingScenarioResult[] = scenarios.map((scenario) => {
    const knownMonetary = scenario.coverageItems.filter(
      (item): item is typeof item & { amount: number; currency: string; frequency: NonNullable<typeof item.frequency> } =>
        item.amount !== undefined && item.currency !== undefined && item.frequency !== undefined && item.status === "supported",
    );
    const potential = totalize(
      knownMonetary.map((item) => ({
        amount: normalizeItemTotal(item, input.studyPeriodYears),
        currency: item.currency,
      })),
      input,
    );
    const coverageStatus = knownMonetary.length
      ? "known_amount"
      : scenario.coverageItems.length
        ? "known_coverage_unknown_amount"
        : "unknown";
    const scenarioAssumptions = [...scenario.assumptions];
    if (coverageStatus !== "known_amount") {
      scenarioAssumptions.push("Scholarship amount or coverage value is unknown, so it does not reduce the scenario gap.");
    }
    if (scenario.eligibilityStatus === "does_not_meet") {
      scenarioAssumptions.push("Eligibility assessment indicates known requirements are not met; treat this scenario as unlikely.");
    }
    if (scenario.availabilityStatus === "expired") {
      scenarioAssumptions.push("The evidence-supported deadline has passed; this is not a currently actionable scenario.");
    }
    return {
      scholarshipId: scenario.scholarshipId,
      scholarshipName: scenario.scholarshipName,
      eligibilityStatus: scenario.eligibilityStatus,
      availabilityStatus: scenario.availabilityStatus,
      amount: potential.amount,
      unconverted: potential.unconverted,
      complete: potential.complete,
      scenarioGap:
        totalCosts.amount === null
          ? null
          : Math.max(
              0,
              totalCosts.amount -
                (confirmedFunding.amount ?? 0) -
                (potential.amount ?? 0),
            ),
      coverageStatus,
      assumptions: scenarioAssumptions,
      coverageItems: scenario.coverageItems,
    };
  });

  return {
    targetCurrency: input.targetCurrency,
    studyPeriodYears: input.studyPeriodYears,
    costBreakdown,
    totalCosts,
    confirmedFunding,
    confirmedGap,
    scenarios: scenarioResults,
    assumptions,
    warnings,
  };
}

const coverageCategories = [
  "tuition",
  "living",
  "accommodation",
  "insurance",
  "travel",
  "stipend",
  "other",
] as const;

function fundingEvidence(scholarship: Scholarship, field: string) {
  const evidence = scholarship.evidence.find((item) => item.field === field && item.quote);
  const supported = scholarship.supportedFields?.includes(field) ?? false;
  return {
    quote: evidence?.quote,
    sourceUrl:
      evidence?.sourceUrl ?? scholarship.officialUrl ?? scholarship.sourceUrl ?? scholarship.id,
    status: supported ? ("supported" as const) : ("unsupported" as const),
  };
}

/**
 * Build an unawarded funding scenario from a discovered scholarship.
 * Only evidence-supported amounts/coverage are treated as known. Coverage
 * text without an amount stays descriptive and never implies full funding.
 */
export function buildScholarshipFundingScenario(
  scholarship: Scholarship,
): ScholarshipFundingScenario {
  const sourceUrl =
    scholarship.officialUrl ?? scholarship.sourceUrl ?? scholarship.id;
  const items: ScholarshipFundingScenario["coverageItems"] = [];
  const assumptions: string[] = [
    "This scholarship has not been awarded; it is shown only as a potential scenario.",
  ];

  if (scholarship.awardAmount !== undefined && scholarship.awardCurrency) {
    const evidence = fundingEvidence(scholarship, "awardAmount");
    items.push({
      category: "other",
      amount: evidence.status === "supported" ? scholarship.awardAmount : undefined,
      currency: scholarship.awardCurrency,
      // Award frequency is not stated in the current extraction schema.
      frequency: evidence.status === "supported" ? "one_time" : undefined,
      description:
        evidence.status === "supported"
          ? "Extracted award amount. Its payment frequency was not established, so it is treated as a one-time scenario amount."
          : "Extracted award amount without supporting evidence; value treated as unknown.",
      evidenceQuote: evidence.quote,
      sourceUrl,
      status: evidence.status,
    });
    if (evidence.status === "supported") {
      assumptions.push("Award frequency is unknown; the known amount is counted once, not repeated.");
    }
  }

  if (scholarship.fundingCoverage) {
    const evidence = fundingEvidence(scholarship, "fundingCoverage");
    const text = scholarship.fundingCoverage.toLowerCase();
    const detected = coverageCategories.filter((category) => {
      if (category === "living") return /living|stipend|allowance/.test(text);
      if (category === "accommodation") return /accommodation|housing|dormitory/.test(text);
      if (category === "travel") return /travel|flight|airfare/.test(text);
      return text.includes(category);
    });
    for (const category of detected.length ? detected : ["other" as const]) {
      items.push({
        category,
        description: scholarship.fundingCoverage,
        evidenceQuote: evidence.quote,
        sourceUrl,
        status: evidence.status === "supported" && scholarship.awardAmount === undefined
          ? "supported"
          : evidence.status,
      });
    }
    assumptions.push("Coverage categories without a monetary amount do not reduce the calculated gap.");
  }

  if (!items.length) {
    assumptions.push("No evidence-supported funding amount or coverage was extracted; funding remains unknown.");
  }

  return {
    scholarshipId: scholarship.id,
    scholarshipName: scholarship.name,
    eligibilityStatus:
      scholarship.eligibility?.overallStatus ?? "insufficient_information",
    availabilityStatus: scholarship.availabilityStatus,
    awarded: false,
    coverageItems: items,
    assumptions,
  };
}

const fundingInterpretationSchema = z.object({
  coverage: z.array(
    z.object({
      category: z.enum(coverageCategories),
      description: z.string().trim().min(1),
    }),
  ),
});

/**
 * Optional Meta interpretation for ambiguous coverage prose. Deterministic
 * keyword categorization is preferred; invalid model output throws and
 * callers must leave coverage unknown rather than inventing categories.
 */
export async function interpretFundingCoverage(
  client: MetaModelClient,
  description: string,
) {
  const raw = await client.complete([
    {
      role: "system",
      content:
        "Classify scholarship funding coverage into JSON only: {\"coverage\":[{\"category\":\"tuition|living|accommodation|insurance|travel|stipend|other\",\"description\":\"original phrase\"}]}. Do not invent amounts or full coverage.",
    },
    { role: "user", content: description },
  ]);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new Error("Funding interpretation returned invalid JSON");
  }
  const parsed = fundingInterpretationSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error("Funding interpretation failed schema validation");
  return parsed.data.coverage;
}
