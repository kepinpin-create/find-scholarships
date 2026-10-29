import { describe, expect, it } from "vitest";
import type { MetaModelClient } from "@/lib/ai/meta-client";
import {
  buildScholarshipFundingScenario,
  calculateFundingPlan,
  interpretFundingCoverage,
  normalizeItemTotal,
} from "@/lib/tools/funding-calculator";
import type { FundingPlanInput, ScholarshipFundingScenario } from "@/lib/schemas/funding";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";

const baseInput: FundingPlanInput = {
  targetCurrency: "USD",
  studyPeriodYears: 2,
  costs: [],
  confirmedFunding: [],
  exchangeRates: [],
};

function cost(amount: number, frequency: "one_time" | "monthly" | "annual", currency = "USD", category: "tuition" | "living" = "tuition") {
  return {
    id: `${category}-${amount}-${frequency}`,
    category,
    label: category,
    amount,
    currency,
    frequency,
    recurring: frequency !== "one_time",
  };
}

function scenario(overrides: Partial<ScholarshipFundingScenario> = {}): ScholarshipFundingScenario {
  return {
    scholarshipId: "s1",
    scholarshipName: "Example Scholarship",
    eligibilityStatus: "potentially_eligible",
    availabilityStatus: "unknown",
    awarded: false,
    coverageItems: [],
    assumptions: [],
    ...overrides,
  };
}

describe("funding period normalization", () => {
  it("separates recurring and one-time totals", () => {
    expect(normalizeItemTotal({ amount: 100, frequency: "monthly" }, 2)).toBe(2400);
    expect(normalizeItemTotal({ amount: 500, frequency: "one_time", durationYears: 2 }, 2)).toBe(500);
    expect(normalizeItemTotal({ amount: 1000, frequency: "annual", durationYears: 1 }, 2)).toBe(1000);
  });

  it("calculates monthly costs and annual confirmed funding over the period", () => {
    const result = calculateFundingPlan({
      ...baseInput,
      costs: [cost(1000, "annual"), cost(200, "monthly", "USD", "living")],
      confirmedFunding: [
        { id: "f1", label: "Savings", amount: 1500, currency: "USD", frequency: "annual" },
      ],
    });
    // Costs: 1000*2 + 200*24 = 6800. Confirmed: 1500*2 = 3000.
    expect(result.totalCosts.amount).toBe(6800);
    expect(result.confirmedFunding.amount).toBe(3000);
    expect(result.confirmedGap).toBe(3800);
  });
});

describe("confirmed versus potential funding", () => {
  it("never lets a potential award reduce the confirmed gap or sums scenarios", () => {
    const known = scenario({
      coverageItems: [
        {
          category: "other",
          amount: 2000,
          currency: "USD",
          frequency: "one_time",
          description: "Award",
          sourceUrl: "https://provider.example/s",
          status: "supported",
        },
      ],
    });
    const result = calculateFundingPlan(
      { ...baseInput, costs: [cost(5000, "one_time")] },
      [known, { ...known, scholarshipId: "s2", scholarshipName: "Second" }],
    );
    expect(result.confirmedGap).toBe(5000);
    expect(result.scenarios[0].scenarioGap).toBe(3000);
    expect(result.scenarios[1].scenarioGap).toBe(3000);
  });

  it("keeps unknown award amounts and coverage out of the gap", () => {
    const unknown = scenario({
      coverageItems: [
        {
          category: "tuition",
          description: "Tuition support mentioned without amount",
          sourceUrl: "https://provider.example/s",
          status: "supported",
        },
      ],
    });
    const result = calculateFundingPlan(
      { ...baseInput, costs: [cost(5000, "one_time")] },
      [unknown],
    );
    expect(result.scenarios[0].amount).toBeNull();
    expect(result.scenarios[0].coverageStatus).toBe("known_coverage_unknown_amount");
    expect(result.scenarios[0].scenarioGap).toBe(5000);
  });

  it("does not treat unsupported extracted amounts as known", () => {
    const scholarship = scholarshipSchema.parse({
      id: "https://agg.example/s",
      name: "Unsupported Award",
      awardAmount: 9999,
      awardCurrency: "USD",
      supportedFields: [],
      retrievalStatus: "retrieved",
      extractionStatus: "extracted",
    }) as Scholarship;
    const built = buildScholarshipFundingScenario(scholarship);
    expect(built.coverageItems[0].amount).toBeUndefined();
    expect(built.coverageItems[0].status).toBe("unsupported");
  });
});

describe("currency handling", () => {
  it("keeps mismatched currencies separate without a rate", () => {
    const result = calculateFundingPlan({
      ...baseInput,
      costs: [cost(5000, "one_time", "USD"), cost(16000000, "one_time", "IDR", "living")],
    });
    expect(result.totalCosts.amount).toBe(5000);
    expect(result.totalCosts.unconverted).toEqual([{ currency: "IDR", amount: 16000000 }]);
    expect(result.confirmedGap).toBe(5000);
  });

  it("converts only with a supplied reliable rate", () => {
    const result = calculateFundingPlan({
      ...baseInput,
      costs: [cost(16000000, "one_time", "IDR")],
      exchangeRates: [{ fromCurrency: "IDR", toCurrency: "USD", rate: 0.0000625 }],
    });
    expect(result.totalCosts.amount).toBe(1000);
    expect(result.totalCosts.complete).toBe(true);
  });
});

describe("double counting and invalid inputs", () => {
  it("ignores duplicate costs and duplicate confirmed funds", () => {
    const duplicateCost = cost(1000, "annual");
    const result = calculateFundingPlan({
      ...baseInput,
      costs: [duplicateCost, { ...duplicateCost, id: "copy" }],
      confirmedFunding: [
        { id: "a", label: "Savings", amount: 500, currency: "USD", frequency: "one_time" },
        { id: "b", label: "Savings", amount: 500, currency: "USD", frequency: "one_time" },
      ],
    });
    expect(result.totalCosts.amount).toBe(2000);
    expect(result.confirmedFunding.amount).toBe(500);
  });

  it("keeps total costs unknown when no costs are entered", () => {
    const result = calculateFundingPlan(baseInput);
    expect(result.totalCosts.amount).toBeNull();
    expect(result.confirmedGap).toBeNull();
  });

  it("rejects invalid periods, negative amounts, and bad rates", () => {
    expect(() => calculateFundingPlan({ ...baseInput, studyPeriodYears: 0 })).toThrow();
    expect(() => calculateFundingPlan({ ...baseInput, costs: [{ ...cost(1, "one_time"), amount: -1 }] })).toThrow();
    expect(() =>
      calculateFundingPlan({
        ...baseInput,
        exchangeRates: [{ fromCurrency: "IDR", toCurrency: "USD", rate: 0 }],
      }),
    ).toThrow();
  });
});

describe("scholarship eligibility scenarios", () => {
  it("labels expired and ineligible scenarios without treating them as confirmed", () => {
    const result = calculateFundingPlan(
      { ...baseInput, costs: [cost(5000, "one_time")] },
      [
        scenario({ eligibilityStatus: "does_not_meet", availabilityStatus: "expired" }),
        scenario({ scholarshipId: "s2", eligibilityStatus: "insufficient_information" }),
      ],
    );
    expect(result.scenarios[0].assumptions.join(" ")).toContain("not met");
    expect(result.scenarios[0].assumptions.join(" ")).toContain("not a currently actionable");
    expect(result.confirmedGap).toBe(5000);
  });

  it("builds scenarios only from evidence-supported scholarship funding", () => {
    const scholarship = scholarshipSchema.parse({
      id: "https://provider.example/s",
      name: "Supported Award",
      awardAmount: 12000,
      awardCurrency: "JPY",
      fundingCoverage: "Tuition and monthly stipend",
      supportedFields: ["awardAmount", "fundingCoverage"],
      retrievalStatus: "retrieved",
      extractionStatus: "extracted",
      eligibility: {
        scholarshipId: "https://provider.example/s",
        overallStatus: "potentially_eligible",
        requirements: [],
        evaluatedAt: "2026-10-28T00:00:00.000Z",
      },
    }) as Scholarship;
    const built = buildScholarshipFundingScenario(scholarship);
    expect(built.awarded).toBe(false);
    expect(built.coverageItems.some((item) => item.amount === 12000)).toBe(true);
    expect(built.coverageItems.some((item) => item.category === "tuition")).toBe(true);
  });

  it("rejects invalid Meta funding interpretations", async () => {
    const client: MetaModelClient = { complete: async () => "not json" };
    await expect(interpretFundingCoverage(client, "Some support")).rejects.toThrow();
  });
});
