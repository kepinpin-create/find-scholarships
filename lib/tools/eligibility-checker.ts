import { z } from "zod";
import type { MetaModelClient } from "@/lib/ai/meta-client";
import type {
  EligibilityAssessment,
  RequirementAssessment,
  RequirementCategory,
} from "@/lib/schemas/eligibility";
import type { Scholarship } from "@/lib/schemas/scholarship";
import type { StudentProfile } from "@/lib/schemas/student";

/**
 * Eligibility gap analysis (Phase 3).
 *
 * Deterministic comparisons run first. Meta is used only to structure
 * ambiguous natural-language requirements; its output is Zod-validated and
 * any interpretation failure becomes `unknown`, never an invented result.
 * Missing profile data and unsupported scholarship claims are `unknown`.
 */

export class EligibilityInterpretationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EligibilityInterpretationError";
  }
}

export interface EligibilityDeps {
  pageText?: string;
  now?: Date;
  metaClient?: MetaModelClient | null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9. ]/g, " ").replace(/\s+/g, " ").trim();
}

function validUrl(value?: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function sourceUrlFor(scholarship: Scholarship, field?: string): string {
  const evidence = scholarship.evidence.find((item) => item.field === field);
  return (
    validUrl(evidence?.sourceUrl) ??
    validUrl(scholarship.officialUrl) ??
    validUrl(scholarship.sourceUrl) ??
    validUrl(scholarship.id) ??
    "https://invalid.example/source-unavailable"
  );
}

function evidenceFor(
  scholarship: Scholarship,
  field: string,
  pageText?: string,
): { quote?: string; sourceUrl: string; status: "supported" | "unsupported" } {
  const evidence = scholarship.evidence.find(
    (item) => item.field === field && item.quote,
  );
  const quoteInPage =
    evidence?.quote && pageText
      ? normalize(pageText).includes(normalize(evidence.quote))
      : false;
  const supported =
    scholarship.supportedFields?.includes(field) || Boolean(quoteInPage);
  return {
    quote: evidence?.quote,
    sourceUrl: sourceUrlFor(scholarship, field),
    status: supported ? "supported" : "unsupported",
  };
}

function requirement(
  scholarship: Scholarship,
  field: string,
  input: Omit<RequirementAssessment, "sourceUrl" | "evidenceQuote" | "evidenceStatus"> & {
    evidence?: ReturnType<typeof evidenceFor>;
  },
): RequirementAssessment {
  const evidence = input.evidence ?? evidenceFor(scholarship, field);
  const { evidence: _evidence, ...rest } = input;
  return {
    ...rest,
    evidenceQuote: evidence.quote,
    sourceUrl: evidence.sourceUrl,
    evidenceStatus: evidence.status,
  };
}

const citizenshipAliases: Record<string, string[]> = {
  indonesia: ["indonesia", "indonesian"],
  japan: ["japan", "japanese"],
  "united states": ["united states", "usa", "american"],
  "united kingdom": ["united kingdom", "uk", "british"],
  australia: ["australia", "australian"],
  germany: ["germany", "german"],
  india: ["india", "indian"],
  malaysia: ["malaysia", "malaysian"],
  singapore: ["singapore", "singaporean"],
  philippines: ["philippines", "philippine", "filipino"],
};

function valueMatchesList(values: string[], profileValue: string): boolean {
  const profile = normalize(profileValue);
  const aliases = citizenshipAliases[profile] ?? [profile];
  return values.some((value) => {
    const text = normalize(value);
    if (/all nationalities|any nationality|all countries|international students/.test(text)) {
      return true;
    }
    return aliases.some((alias) => text.includes(alias) || alias.includes(text));
  });
}

function degreeTerms(level: StudentProfile["intendedDegreeLevel"]): string[] {
  switch (level) {
    case "bachelor":
      return ["bachelor", "undergraduate"];
    case "master":
      return ["master", "graduate", "postgraduate"];
    case "doctorate":
      return ["doctorate", "doctoral", "phd"];
    case "diploma":
      return ["diploma"];
    default:
      return [];
  }
}

function parseGpa(text: string): { value: number; scale?: number } | null {
  const match =
    text.match(/(?:gpa|grade point average)[^0-9]{0,25}(\d+(?:\.\d+)?)(?:\s*(?:\/|out of)\s*(\d+(?:\.\d+)?))?/i) ??
    text.match(/(\d+(?:\.\d+)?)(?:\s*(?:\/|out of)\s*(\d+(?:\.\d+)?))?\s*(?:gpa|grade point)/i);
  if (!match) return null;
  return { value: Number(match[1]), scale: match[2] ? Number(match[2]) : undefined };
}

function evaluateGpa(
  profile: StudentProfile,
  requirementText: string,
): { evaluation: RequirementAssessment["evaluation"]; explanation: string; normalized?: string } {
  const required = parseGpa(requirementText);
  if (!required) {
    return {
      evaluation: "unknown",
      explanation: "The GPA requirement could not be normalized for a reliable comparison.",
    };
  }
  const normalized = `GPA >= ${required.value}${required.scale ? `/${required.scale}` : ""}`;
  if (profile.gpa === undefined) {
    return {
      evaluation: "unknown",
      normalized,
      explanation: "Your profile does not include a GPA, so this requirement cannot be assessed.",
    };
  }
  if (required.scale) {
    if (!profile.gpaScale) {
      return {
        evaluation: "unknown",
        normalized,
        explanation: "Your GPA scale is missing, so it cannot be compared reliably with the required scale.",
      };
    }
    const meets = profile.gpa / profile.gpaScale >= required.value / required.scale;
    return {
      evaluation: meets ? "meets" : "does_not_meet",
      normalized,
      explanation: meets
        ? `Your GPA ${profile.gpa}/${profile.gpaScale} meets the normalized requirement ${normalized}.`
        : `Your GPA ${profile.gpa}/${profile.gpaScale} is below the normalized requirement ${normalized}.`,
    };
  }
  if (profile.gpaScale && profile.gpaScale !== 4) {
    return {
      evaluation: "unknown",
      normalized,
      explanation: "The requirement does not state a GPA scale and your GPA uses a different scale.",
    };
  }
  const meets = profile.gpa >= required.value;
  return {
    evaluation: meets ? "meets" : "does_not_meet",
    normalized,
    explanation: meets
      ? `Your GPA ${profile.gpa} meets the stated minimum ${required.value}.`
      : `Your GPA ${profile.gpa} is below the stated minimum ${required.value}.`,
  };
}

function parseLanguageScore(
  text: string,
): { test: "IELTS" | "TOEFL"; score: number } | null {
  const ielts = text.match(/ielts[^0-9]{0,18}(\d+(?:\.\d+)?)/i);
  if (ielts) return { test: "IELTS", score: Number(ielts[1]) };
  const toefl = text.match(/toefl[^0-9]{0,18}(\d+(?:\.\d+)?)/i);
  if (toefl) return { test: "TOEFL", score: Number(toefl[1]) };
  return null;
}

function evaluateLanguage(
  profile: StudentProfile,
  requirementText: string,
): { evaluation: RequirementAssessment["evaluation"]; explanation: string; normalized?: string } {
  const required = parseLanguageScore(requirementText);
  if (!required) {
    return {
      evaluation: "unknown",
      explanation: "The language requirement could not be normalized to a comparable test score.",
    };
  }
  const normalized = `${required.test} >= ${required.score}`;
  if (!profile.languageProficiency) {
    return {
      evaluation: "unknown",
      normalized,
      explanation: "Your profile does not include a language score, so this requirement cannot be assessed.",
    };
  }
  const actual = parseLanguageScore(profile.languageProficiency);
  if (!actual || actual.test !== required.test) {
    return {
      evaluation: "unknown",
      normalized,
      explanation: "Your language qualification uses a different or unclear test, so no reliable comparison was made.",
    };
  }
  const meets = actual.score >= required.score;
  return {
    evaluation: meets ? "meets" : "does_not_meet",
    normalized,
    explanation: meets
      ? `Your ${actual.test} ${actual.score} meets ${normalized}.`
      : `Your ${actual.test} ${actual.score} is below ${normalized}.`,
  };
}

export function createUnavailableEligibility(
  scholarship: Scholarship,
  limitation: string,
  now: Date = new Date(),
): EligibilityAssessment {
  return {
    scholarshipId: scholarship.id,
    overallStatus: "insufficient_information",
    requirements: [],
    limitation,
    evaluatedAt: now.toISOString(),
  };
}

const ambiguousOutputSchema = z.object({
  requirements: z.array(
    z.object({
      category: z.enum([
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
      ]),
      requirementText: z.string().trim().min(1),
      normalizedRequirement: z.string().trim().min(1).nullable(),
      mandatory: z.boolean(),
    }),
  ),
});

export async function interpretAmbiguousRequirements(
  client: MetaModelClient,
  scholarship: Scholarship,
) {
  const sourceText = [
    scholarship.eligibilityRequirements,
    scholarship.academicRequirements,
    scholarship.languageRequirements,
  ]
    .filter(Boolean)
    .join("\n");
  if (!sourceText) return [];

  const raw = await client.complete([
    {
      role: "system",
      content:
        "Structure scholarship eligibility requirements as JSON only. Use only the supplied extracted text. Return {\"requirements\":[{\"category\":\"citizenship|degree_level|destination|field_of_study|gpa|language|age|work_experience|application_deadline|other\",\"requirementText\":\"original text\",\"normalizedRequirement\":string|null,\"mandatory\":boolean}]}. Do not decide whether the student meets them.",
    },
    { role: "user", content: sourceText },
  ]);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(
      raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
    );
  } catch {
    throw new EligibilityInterpretationError("Model returned invalid JSON");
  }
  const parsed = ambiguousOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new EligibilityInterpretationError(
      "Model output failed eligibility schema validation",
    );
  }
  return parsed.data.requirements;
}

export async function evaluateEligibility(
  profile: StudentProfile,
  scholarship: Scholarship,
  deps: EligibilityDeps = {},
): Promise<EligibilityAssessment> {
  const now = deps.now ?? new Date();
  if (scholarship.retrievalStatus === "failed") {
    return createUnavailableEligibility(
      scholarship,
      "The source page could not be retrieved, so eligibility requirements were not evaluated.",
      now,
    );
  }
  if (scholarship.retrievalStatus === "not_attempted") {
    return createUnavailableEligibility(
      scholarship,
      "This source was not checked, so eligibility requirements were not evaluated.",
      now,
    );
  }
  if (scholarship.extractionStatus === "failed" || scholarship.extractionStatus === "not_attempted") {
    return createUnavailableEligibility(
      scholarship,
      "Scholarship details could not be extracted, so eligibility requirements are unavailable.",
      now,
    );
  }

  const requirements: RequirementAssessment[] = [];
  const add = (item: RequirementAssessment) => requirements.push(item);
  const unsupported = (evaluation: RequirementAssessment["evaluation"]) =>
    evaluation; // Evidence gating is applied by each builder below.

  if (scholarship.eligibleCitizenships?.length) {
    const evidence = evidenceFor(scholarship, "eligibleCitizenships", deps.pageText);
    const text = scholarship.eligibleCitizenships.join(", ");
    let evaluation: RequirementAssessment["evaluation"] = "unknown";
    let explanation = "The citizenship requirement is not supported by fetched evidence.";
    if (evidence.status === "supported") {
      if (!profile.citizenship) {
        explanation = "Your profile does not include citizenship, so this requirement cannot be assessed.";
      } else if (valueMatchesList(scholarship.eligibleCitizenships, profile.citizenship)) {
        evaluation = "meets";
        explanation = `Your citizenship (${profile.citizenship}) matches the stated eligibility.`;
      } else {
        evaluation = "does_not_meet";
        explanation = `Your citizenship (${profile.citizenship}) does not match the stated eligible citizenships.`;
      }
    }
    add(requirement(scholarship, "eligibleCitizenships", {
      category: "citizenship",
      normalizedRequirement: text,
      requirementText: text,
      mandatory: true,
      evaluation: unsupported(evaluation),
      explanation,
      evidence,
    }));
  }

  if (scholarship.eligibleDegreeLevels?.length) {
    const evidence = evidenceFor(scholarship, "eligibleDegreeLevels", deps.pageText);
    const text = scholarship.eligibleDegreeLevels.join(", ");
    let evaluation: RequirementAssessment["evaluation"] = "unknown";
    let explanation = "The degree-level requirement is not supported by fetched evidence.";
    if (evidence.status === "supported") {
      const terms = degreeTerms(profile.intendedDegreeLevel);
      const matches = scholarship.eligibleDegreeLevels.some((value) =>
        terms.some((term) => normalize(value).includes(term)),
      );
      evaluation = matches ? "meets" : "does_not_meet";
      explanation = matches
        ? `Your intended degree (${profile.intendedDegreeLevel}) matches the stated levels.`
        : `Your intended degree (${profile.intendedDegreeLevel}) is not in the stated eligible levels.`;
    }
    add(requirement(scholarship, "eligibleDegreeLevels", {
      category: "degree_level",
      normalizedRequirement: text,
      requirementText: text,
      mandatory: true,
      evaluation,
      explanation,
      evidence,
    }));
  }

  if (scholarship.studyDestinations?.length) {
    const evidence = evidenceFor(scholarship, "studyDestinations", deps.pageText);
    const text = scholarship.studyDestinations.join(", ");
    let evaluation: RequirementAssessment["evaluation"] = "unknown";
    let explanation = "The destination information is not supported by fetched evidence.";
    if (evidence.status === "supported") {
      if (!profile.preferredDestinations?.length) {
        explanation = "You have not specified a preferred destination, so destination fit cannot be assessed.";
      } else if (valueMatchesList(scholarship.studyDestinations, profile.preferredDestinations[0]) || scholarship.studyDestinations.some((destination) => profile.preferredDestinations?.some((preferred) => normalize(destination).includes(normalize(preferred)) || normalize(preferred).includes(normalize(destination))))) {
        evaluation = "meets";
        explanation = "The scholarship destination matches at least one of your preferred destinations.";
      } else {
        evaluation = "does_not_meet";
        explanation = "The scholarship destination does not match your preferred destinations; this is a preference mismatch, not proof of ineligibility.";
      }
    }
    add(requirement(scholarship, "studyDestinations", {
      category: "destination",
      normalizedRequirement: text,
      requirementText: text,
      mandatory: false,
      evaluation,
      explanation,
      evidence,
    }));
  }

  if (scholarship.eligibleFieldsOfStudy?.length) {
    const evidence = evidenceFor(scholarship, "eligibleFieldsOfStudy", deps.pageText);
    const text = scholarship.eligibleFieldsOfStudy.join(", ");
    let evaluation: RequirementAssessment["evaluation"] = "unknown";
    let explanation = "The field-of-study requirement is not supported by fetched evidence.";
    if (evidence.status === "supported") {
      const allFields = /all fields|any field|all disciplines/.test(normalize(text));
      const profileTokens = normalize(profile.fieldOfStudy).split(" ").filter((token) => token.length > 2);
      const overlaps = scholarship.eligibleFieldsOfStudy.some((field) => {
        const fieldText = normalize(field);
        return profileTokens.some((token) => fieldText.includes(token));
      });
      evaluation = allFields || overlaps ? "meets" : "does_not_meet";
      explanation = evaluation === "meets"
        ? `Your field (${profile.fieldOfStudy}) matches the stated eligible fields.`
        : `Your field (${profile.fieldOfStudy}) does not appear in the stated eligible fields.`;
    }
    add(requirement(scholarship, "eligibleFieldsOfStudy", {
      category: "field_of_study",
      normalizedRequirement: text,
      requirementText: text,
      mandatory: true,
      evaluation,
      explanation,
      evidence,
    }));
  }

  if (scholarship.academicRequirements) {
    const evidence = evidenceFor(scholarship, "academicRequirements", deps.pageText);
    const result = evidence.status === "supported"
      ? evaluateGpa(profile, scholarship.academicRequirements)
      : { evaluation: "unknown" as const, explanation: "The academic requirement is not supported by fetched evidence.", normalized: undefined };
    add(requirement(scholarship, "academicRequirements", {
      category: "gpa",
      normalizedRequirement: result.normalized,
      requirementText: scholarship.academicRequirements,
      mandatory: true,
      evaluation: result.evaluation,
      explanation: result.explanation,
      evidence,
    }));
  }

  if (scholarship.languageRequirements) {
    const evidence = evidenceFor(scholarship, "languageRequirements", deps.pageText);
    const result = evidence.status === "supported"
      ? evaluateLanguage(profile, scholarship.languageRequirements)
      : { evaluation: "unknown" as const, explanation: "The language requirement is not supported by fetched evidence.", normalized: undefined };
    add(requirement(scholarship, "languageRequirements", {
      category: "language",
      normalizedRequirement: result.normalized,
      requirementText: scholarship.languageRequirements,
      mandatory: true,
      evaluation: result.evaluation,
      explanation: result.explanation,
      evidence,
    }));
  }

  // Application deadline is an actionability requirement, not an award guarantee.
  {
    const evidence = evidenceFor(scholarship, "applicationDeadline", deps.pageText);
    const deadline = scholarship.applicationDeadline;
    let evaluation: RequirementAssessment["evaluation"] = "unknown";
    let explanation = "No reliable application deadline was extracted, so current actionability is unknown.";
    if (deadline && evidence.status === "supported") {
      if (scholarship.availabilityStatus === "expired" || deadline < now.toISOString().slice(0, 10)) {
        evaluation = "does_not_meet";
        explanation = "The evidence-supported application deadline has passed, so this scholarship is not currently actionable.";
      } else {
        evaluation = "meets";
        explanation = "The evidence-supported application deadline has not passed.";
      }
    } else if (deadline) {
      explanation = "The extracted deadline is not supported by fetched evidence, so current actionability is unknown.";
    }
    add(requirement(scholarship, "applicationDeadline", {
      category: "application_deadline",
      normalizedRequirement: deadline,
      requirementText: deadline ? `Application deadline: ${deadline}` : "Application deadline not stated",
      mandatory: true,
      evaluation,
      explanation,
      evidence,
    }));
  }

  const ambiguousText = [
    scholarship.eligibilityRequirements,
    scholarship.academicRequirements,
    scholarship.languageRequirements,
  ].filter(Boolean).join("\n");
  // Meta interpretation is reserved for requirement types deterministic
  // code cannot evaluate from the profile (age and work experience). GPA
  // and language are already handled deterministically above.
  const needsInterpretation =
    /(\bage\b|under\s+\d+\s+years|years?\s+of\s+(?:work\s+)?experience|work experience|employed|working experience)/i.test(
      ambiguousText,
    );
  if (deps.metaClient && needsInterpretation && ambiguousText) {
    try {
      const interpreted = await interpretAmbiguousRequirements(deps.metaClient, scholarship);
      const covered = new Set(requirements.map((item) => item.category));
      for (const item of interpreted) {
        if (covered.has(item.category) && item.category !== "age" && item.category !== "work_experience" && item.category !== "other") continue;
        const evidence = evidenceFor(scholarship, "eligibilityRequirements", deps.pageText);
        let evaluation: RequirementAssessment["evaluation"] = "unknown";
        let explanation = "This requirement needs information or interpretation that is not available in your profile.";
        if (item.category === "gpa") {
          const result = evaluateGpa(profile, item.normalizedRequirement ?? item.requirementText);
          evaluation = evidence.status === "supported" ? result.evaluation : "unknown";
          explanation = evidence.status === "supported" ? result.explanation : "The interpreted GPA requirement is not supported by fetched evidence.";
        } else if (item.category === "language") {
          const result = evaluateLanguage(profile, item.normalizedRequirement ?? item.requirementText);
          evaluation = evidence.status === "supported" ? result.evaluation : "unknown";
          explanation = evidence.status === "supported" ? result.explanation : "The interpreted language requirement is not supported by fetched evidence.";
        } else if (item.category === "age") {
          explanation = "Your profile does not collect age or date of birth, so this requirement cannot be assessed.";
        } else if (item.category === "work_experience") {
          explanation = "Your profile experience is free text without verified years of experience, so this requirement cannot be assessed reliably.";
        }
        requirements.push(requirement(scholarship, "eligibilityRequirements", {
          category: item.category as RequirementCategory,
          normalizedRequirement: item.normalizedRequirement ?? undefined,
          requirementText: item.requirementText,
          mandatory: item.mandatory,
          evaluation,
          explanation,
          evidence,
        }));
      }
    } catch {
      const evidence = evidenceFor(scholarship, "eligibilityRequirements", deps.pageText);
      requirements.push(requirement(scholarship, "eligibilityRequirements", {
        category: "other",
        requirementText: scholarship.eligibilityRequirements ?? ambiguousText,
        mandatory: true,
        evaluation: "unknown",
        explanation: "Additional eligibility text could not be interpreted reliably, so it remains unknown.",
        evidence,
      }));
    }
  } else if (scholarship.eligibilityRequirements && !requirements.some((item) => item.requirementText === scholarship.eligibilityRequirements)) {
    const evidence = evidenceFor(scholarship, "eligibilityRequirements", deps.pageText);
    requirements.push(requirement(scholarship, "eligibilityRequirements", {
      category: "other",
      requirementText: scholarship.eligibilityRequirements,
      mandatory: true,
      evaluation: "unknown",
      explanation: "This eligibility text was extracted but was not deterministically evaluated.",
      evidence,
    }));
  }

  const mandatoryFailures = requirements.filter(
    (item) => item.mandatory && item.evaluation === "does_not_meet",
  );
  const hasMeets = requirements.some((item) => item.evaluation === "meets");
  const hasUnknown = requirements.some((item) => item.evaluation === "unknown");

  return {
    scholarshipId: scholarship.id,
    overallStatus: mandatoryFailures.length
      ? "does_not_meet"
      : requirements.length === 0
        ? "insufficient_information"
        : hasUnknown
          ? hasMeets
            ? "potentially_eligible"
            : "insufficient_information"
          : "meets_known_requirements",
    requirements,
    evaluatedAt: now.toISOString(),
  };
}
