import { z } from "zod";

export const currentEducationLevels = [
  "high_school",
  "diploma",
  "bachelor",
  "master",
  "doctorate",
  "other",
] as const;

export const academicStatuses = [
  "student",
  "graduate",
  "gap_year",
  "working",
  "other",
] as const;

export const intendedDegreeLevels = [
  "diploma",
  "bachelor",
  "master",
  "doctorate",
  "other",
] as const;

/**
 * FR-01: Student profile.
 *
 * University selection and personal budget are optional so a student can
 * discover scholarships without choosing a university or entering a budget.
 * Optional fields left empty stay `undefined` (unknown) instead of being
 * defaulted to invented values. A missing field is not an eligibility failure.
 *
 * Removed after audit (collected but never read by search, eligibility, or
 * funding): achievements, experience, preferredUniversity, fundingPreferences,
 * countryOfResidence. Old profiles containing them still parse — Zod strips
 * unknown keys. currentEducationLevel/academicStatus are kept per FR-01 but
 * optional, since nothing downstream requires them.
 */
export const studentProfileSchema = z
  .object({
    currentEducationLevel: z.enum(currentEducationLevels).optional(),
    academicStatus: z.enum(academicStatuses).optional(),
    /** Academic performance where applicable. Absent means unknown. */
    gpa: z.number().min(0, "GPA cannot be below 0").optional(),
    /** Scale the GPA is measured against, e.g. 4 for a 4.0 scale. */
    gpaScale: z.number().positive("GPA scale must be positive").optional(),
    intendedDegreeLevel: z.enum(intendedDegreeLevels, {
      error: "Select your intended degree level",
    }),
    fieldOfStudy: z.string().trim().min(1, "Enter your intended field of study"),
    /** Composed as "<test> <score>", e.g. "IELTS 7.0" or "TOEFL iBT 95". */
    languageProficiency: z.string().trim().optional(),
    /** Country-list value (passport nationality), e.g. "Indonesia". Required for targeted eligibility matching. */
    citizenship: z.string().trim().min(1, "Select your citizenship"),
    /** Country-list values. Empty means no preference, not ineligibility. */
    preferredDestinations: z.array(z.string().trim().min(1)).optional(),
    /** Optional personal budget. Absent means budget unknown, never zero. */
    personalBudgetAmount: z
      .number()
      .nonnegative("Budget cannot be negative")
      .optional(),
    /** ISO 4217 currency code, e.g. IDR or USD. Required only with a budget. */
    personalBudgetCurrency: z
      .string()
      .trim()
      .length(3, "Use a 3-letter currency code, e.g. USD")
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .refine(
    (profile) =>
      profile.gpa === undefined ||
      profile.gpaScale === undefined ||
      profile.gpa <= profile.gpaScale,
    {
      message: "GPA cannot exceed its scale",
      path: ["gpa"],
    },
  );

export type StudentProfile = z.infer<typeof studentProfileSchema>;
