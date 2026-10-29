import type { Scholarship } from "@/lib/schemas/scholarship";
import type { StudentProfile } from "@/lib/schemas/student";
import { calculateFundingPlan } from "@/lib/tools/funding-calculator";
import type { StoredFundingInput } from "./storage";

/**
 * Dashboard summary derived only from actual saved data. Unknown stays
 * unknown: records without an eligibility assessment, or assessed as
 * insufficient_information, are counted as unknown — never as eligible.
 * Deadlines appear only when evidence-supported and still actionable.
 */
export interface DeadlineItem {
  scholarshipId: string;
  name: string;
  deadline: string;
  sourceUrl: string;
}

export interface DashboardSummary {
  hasProfile: boolean;
  totalScholarships: number;
  savedBookmarks: number;
  eligibility: {
    meets: number;
    potentiallyEligible: number;
    doesNotMeet: number;
    unknown: number;
  };
  upcomingDeadlines: DeadlineItem[];
  /** Confirmed funding gap in the funding target currency; null if not computable. */
  fundingGap: number | null;
  fundingCurrency: string | null;
  /** Instagram/social testimonial links found across saved records. */
  socialMentions: number;
  verificationWarnings: number;
  nextAction: { label: string; href: string; reason: string };
}

export function summarizeDashboard(input: {
  profile: StudentProfile | null;
  opportunities: Scholarship[];
  savedBookmarks: number;
  fundingInput: StoredFundingInput | null;
  now?: Date;
}): DashboardSummary {
  const now = input.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const opportunities = input.opportunities;

  const eligibility = { meets: 0, potentiallyEligible: 0, doesNotMeet: 0, unknown: 0 };
  for (const item of opportunities) {
    switch (item.eligibility?.overallStatus) {
      case "meets_known_requirements":
        eligibility.meets++;
        break;
      case "potentially_eligible":
        eligibility.potentiallyEligible++;
        break;
      case "does_not_meet":
        eligibility.doesNotMeet++;
        break;
      default:
        eligibility.unknown++;
    }
  }

  const upcomingDeadlines = opportunities
    .filter(
      (item) =>
        item.applicationDeadline &&
        item.applicationDeadline >= today &&
        (item.availabilityStatus === "open" || item.availabilityStatus === "upcoming") &&
        item.supportedFields?.includes("applicationDeadline"),
    )
    .sort((a, b) => (a.applicationDeadline ?? "").localeCompare(b.applicationDeadline ?? ""))
    .slice(0, 5)
    .map((item) => ({
      scholarshipId: item.id,
      name: item.name,
      deadline: item.applicationDeadline as string,
      sourceUrl: item.officialUrl ?? item.sourceUrl ?? item.id,
    }));

  const socialMentions = opportunities.reduce(
    (count, item) =>
      count + (item.sources ?? []).filter((source) => source.sourceType === "social").length,
    0,
  );

  const verificationWarnings = opportunities.filter(
    (item) =>
      item.retrievalStatus === "failed" ||
      item.verificationStatus === "unverified" ||
      item.extractionStatus === "failed",
  ).length;

  let fundingGap: number | null = null;
  let fundingCurrency: string | null = null;
  if (input.fundingInput && input.fundingInput.costs.length > 0) {
    try {
      const years = Number(input.fundingInput.studyPeriodYears);
      const calculation = calculateFundingPlan({
        targetCurrency: input.fundingInput.targetCurrency.toUpperCase(),
        studyPeriodYears: years,
        costs: input.fundingInput.costs,
        confirmedFunding: input.fundingInput.confirmed,
        exchangeRates: input.fundingInput.rates,
      });
      fundingGap = calculation.confirmedGap;
      fundingCurrency = calculation.targetCurrency;
    } catch {
      fundingGap = null;
      fundingCurrency = null;
    }
  }

  const nextAction = !input.profile
    ? {
        label: "Complete your profile",
        href: "/profile",
        reason: "Discovery and eligibility start with your student profile.",
      }
    : opportunities.length === 0
      ? {
          label: "Discover scholarships",
          href: "/opportunities",
          reason: "Run your first profile-based scholarship search.",
        }
      : fundingGap === null
        ? {
            label: "Plan your funding",
            href: "/funding",
            reason: "Add study costs to calculate your confirmed funding gap.",
          }
        : {
            label: "Review scholarships",
            href: "/opportunities",
            reason: "Check eligibility, deadlines, and evidence for your saved results.",
          };

  return {
    hasProfile: Boolean(input.profile),
    totalScholarships: opportunities.length,
    savedBookmarks: input.savedBookmarks,
    eligibility,
    upcomingDeadlines,
    fundingGap,
    fundingCurrency,
    socialMentions,
    verificationWarnings,
    nextAction,
  };
}
