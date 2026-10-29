import { z } from "zod";

/**
 * Funding planning model (Phase 4).
 *
 * Unknown amounts and coverage remain unknown. No schema default converts
 * a missing amount into zero, and scholarship awards are scenarios until
 * the student actually receives them.
 */
export const costCategories = [
  "tuition",
  "living",
  "accommodation",
  "insurance",
  "travel",
  "other",
] as const;

export const fundingCategories = [
  "tuition",
  "living",
  "accommodation",
  "insurance",
  "travel",
  "stipend",
  "other",
] as const;

export const fundingFrequencies = [
  "one_time",
  "monthly",
  "semesterly",
  "annual",
] as const;

const currency = z
  .string()
  .trim()
  .length(3, "Use a 3-letter currency code")
  .transform((value) => value.toUpperCase());

export const studyCostItemSchema = z.object({
  id: z.string().trim().min(1),
  category: z.enum(costCategories),
  label: z.string().trim().min(1),
  amount: z.number().nonnegative("Amount cannot be negative"),
  currency,
  frequency: z.enum(fundingFrequencies),
  /** Whether the amount repeats. Must agree with frequency. */
  recurring: z.boolean(),
  /** Years over which a recurring cost applies; defaults to the plan period. */
  durationYears: z.number().positive().max(10).optional(),
}).refine((item) => item.recurring === (item.frequency !== "one_time"), {
  message: "Recurring must agree with the selected frequency",
});

export const confirmedFundingItemSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  amount: z.number().nonnegative("Amount cannot be negative"),
  currency,
  frequency: z.enum(fundingFrequencies),
  durationYears: z.number().positive().max(10).optional(),
  source: z.string().trim().optional(),
});

export const exchangeRateSchema = z.object({
  fromCurrency: currency,
  toCurrency: currency,
  /** 1 unit of fromCurrency equals this many units of toCurrency. */
  rate: z.number().positive("Exchange rate must be positive"),
  source: z.string().trim().optional(),
});

export const fundingPlanInputSchema = z.object({
  targetCurrency: currency,
  studyPeriodYears: z.number().positive().max(10),
  costs: z.array(studyCostItemSchema).default([]),
  confirmedFunding: z.array(confirmedFundingItemSchema).default([]),
  exchangeRates: z.array(exchangeRateSchema).default([]),
});

export const scholarshipFundingCoverageItemSchema = z.object({
  category: z.enum(fundingCategories),
  /** Absent means the monetary value is unknown, never zero. */
  amount: z.number().nonnegative().optional(),
  currency: currency.optional(),
  frequency: z.enum(fundingFrequencies).optional(),
  durationYears: z.number().positive().max(10).optional(),
  description: z.string().trim().min(1),
  evidenceQuote: z.string().trim().optional(),
  sourceUrl: z.url(),
  status: z.enum(["supported", "unsupported", "unknown"]),
});

export const scholarshipFundingScenarioSchema = z.object({
  scholarshipId: z.string().trim().min(1),
  scholarshipName: z.string().trim().min(1),
  eligibilityStatus: z.enum([
    "meets_known_requirements",
    "potentially_eligible",
    "does_not_meet",
    "insufficient_information",
  ]),
  availabilityStatus: z.enum(["expired", "upcoming", "open", "unknown"]),
  /** Unawarded scholarship: always a scenario, never confirmed funding. */
  awarded: z.literal(false).default(false),
  coverageItems: z.array(scholarshipFundingCoverageItemSchema).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([]),
});

export type StudyCostItem = z.infer<typeof studyCostItemSchema>;
export type ConfirmedFundingItem = z.infer<typeof confirmedFundingItemSchema>;
export type ExchangeRate = z.infer<typeof exchangeRateSchema>;
export type FundingPlanInput = z.infer<typeof fundingPlanInputSchema>;
export type ScholarshipFundingCoverageItem = z.infer<
  typeof scholarshipFundingCoverageItemSchema
>;
export type ScholarshipFundingScenario = z.infer<
  typeof scholarshipFundingScenarioSchema
>;
