import { z } from "zod";

/**
 * Eligibility gap analysis model (Phase 3).
 *
 * Every requirement keeps the original extracted text, a normalized form
 * where deterministic comparison is possible, its supporting evidence, and
 * an evaluation against the student profile. Missing student data and
 * unsupported scholarship claims both remain `unknown` — never `meets`.
 */
export const requirementCategories = [
  "citizenship",
  "degree_level",
  "destination",
  "field_of_study",
  "gpa",
  "language",
  "age",
  "work_experience",
  "application_deadline",
  "other",
] as const;

export const requirementEvaluations = [
  "meets",
  "does_not_meet",
  "unknown",
] as const;

export const requirementEvidenceStatuses = ["supported", "unsupported"] as const;

export const eligibilityOverallStatuses = [
  "meets_known_requirements",
  "potentially_eligible",
  "does_not_meet",
  "insufficient_information",
] as const;

export const requirementAssessmentSchema = z.object({
  category: z.enum(requirementCategories),
  /** Normalized comparison value where one could be derived, e.g. "GPA >= 3.0/4.0". */
  normalizedRequirement: z.string().trim().min(1).optional(),
  /** Original requirement or field text as extracted from the source. */
  requirementText: z.string().trim().min(1),
  evidenceQuote: z.string().trim().min(1).optional(),
  sourceUrl: z.url(),
  evidenceStatus: z.enum(requirementEvidenceStatuses),
  evaluation: z.enum(requirementEvaluations),
  /** Mandatory failures can make the overall result does_not_meet. */
  mandatory: z.boolean().default(true),
  explanation: z.string().trim().min(1),
});

export const eligibilityAssessmentSchema = z.object({
  scholarshipId: z.string().trim().min(1),
  overallStatus: z.enum(eligibilityOverallStatuses),
  requirements: z.array(requirementAssessmentSchema).default([]),
  /** Why evaluation was limited, e.g. retrieval or extraction failed. */
  limitation: z.string().trim().min(1).optional(),
  evaluatedAt: z.iso.datetime(),
});

export type RequirementCategory = (typeof requirementCategories)[number];
export type RequirementEvaluation = (typeof requirementEvaluations)[number];
export type RequirementAssessment = z.infer<typeof requirementAssessmentSchema>;
export type EligibilityAssessment = z.infer<typeof eligibilityAssessmentSchema>;
export type EligibilityOverallStatus =
  (typeof eligibilityOverallStatuses)[number];
