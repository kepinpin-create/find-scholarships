import type { Scholarship } from "@/lib/schemas/scholarship";
import { determineAvailabilityStatus } from "./deadline-status";

/**
 * Evidence association (FR-03A, foundation for Phase 3 verification).
 *
 * A claim counts as supported only when its evidence quote actually appears
 * in the retrieved page text. Model confidence alone never verifies a claim,
 * and a search result existing never makes a scholarship "verified".
 *
 * "supported" additionally requires meaningful evidence: every present
 * important field supported, at least two important fields present, and at
 * least one key claim (deadline, award, or eligibility) supported. A single
 * supported minor field (e.g. provider) can never yield "supported".
 */

const IMPORTANT_FIELDS: Array<keyof Scholarship> = [
  "provider",
  "eligibleCitizenships",
  "eligibleDegreeLevels",
  "applicationDeadline",
  "awardAmount",
  "fundingCoverage",
  "eligibilityRequirements",
];

const KEY_CLAIM_FIELDS = new Set([
  "applicationDeadline",
  "awardAmount",
  "eligibilityRequirements",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function verifyEvidence(
  scholarship: Scholarship,
  pageText: string,
  verifiedAt: string = new Date().toISOString(),
): Scholarship {
  const normalizedPage = normalize(pageText);

  const supportedFields = new Set<string>();
  for (const evidence of scholarship.evidence) {
    if (evidence.quote && normalizedPage.includes(normalize(evidence.quote))) {
      supportedFields.add(evidence.field);
    }
  }

  const presentImportant = IMPORTANT_FIELDS.filter(
    (field) => scholarship[field] !== undefined,
  );
  const unverifiedFields = presentImportant
    .map(String)
    .filter((field) => !supportedFields.has(field));

  const supportedImportant = presentImportant
    .map(String)
    .filter((field) => supportedFields.has(field));
  const supportedKeyClaims = supportedImportant.filter((field) =>
    KEY_CLAIM_FIELDS.has(field),
  );

  const verificationStatus =
    supportedKeyClaims.length === 0
      ? "unverified"
      : unverifiedFields.length === 0 &&
          presentImportant.length >= 2 &&
          supportedKeyClaims.length >= 1
        ? "supported"
        : "partially_supported";

  const withSupport: Scholarship = {
    ...scholarship,
    supportedFields: supportedImportant.length
      ? supportedImportant
      : undefined,
    unverifiedFields: unverifiedFields.length ? unverifiedFields : undefined,
    verificationStatus,
    lastVerifiedAt: verifiedAt,
  };

  return {
    ...withSupport,
    availabilityStatus: determineAvailabilityStatus(
      withSupport,
      new Date(verifiedAt),
    ),
  };
}
