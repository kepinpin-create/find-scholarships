import { z } from "zod";
import { eligibilityAssessmentSchema } from "./eligibility";

/**
 * Scholarship record (FR-03 / FR-03A).
 *
 * Every important field keeps a link to its supporting evidence. A value
 * that cannot be extracted stays `undefined` (unknown) instead of being
 * invented, and conflicting values are preserved for the verifier to flag.
 * A record existing is not proof: `verificationStatus` stays "unverified"
 * until retrieved page evidence actually supports its claims.
 */
export const evidenceReferenceSchema = z.object({
  /** Scholarship field this snippet supports, e.g. "deadline". */
  field: z.string().trim().min(1),
  /** Exact supporting text copied from the source, when available. */
  quote: z.string().trim().optional(),
  sourceUrl: z.url("Source must be a valid URL"),
  /** ISO timestamp of when the source was retrieved. */
  retrievedAt: z.iso.datetime("Retrieval time must be an ISO datetime"),
});

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const sourceTypes = [
  "official_provider",
  "government",
  "university",
  "aggregator",
  "social",
  "blog",
  "unknown",
] as const;

export const sourceReferenceSchema = z.object({
  /** Stable source identity: canonical URL. */
  id: z.string().trim().min(1),
  url: z.url(),
  canonicalUrl: z.string().trim().min(1),
  sourceType: z.enum(sourceTypes),
  /** Publisher identity for this source, distinct from scholarship provider. */
  publisherName: z.string().trim().min(1).optional(),
  publisherHost: z.string().trim().min(1),
  /** Social account handle without @, when applicable. */
  handle: z.string().trim().min(1).optional(),
  /** Publication date when independently extracted; unknown stays absent. */
  publishedAt: z.iso.date().optional(),
  retrievedAt: z.iso.datetime().optional(),
  discoveryQuery: z.string().trim().min(1).optional(),
  retrievalStatus: z.enum(["not_attempted", "retrieved", "failed"]).default("not_attempted"),
  retrievalFailureKind: z.string().trim().min(1).optional(),
  extractionStatus: z
    .enum(["not_attempted", "extracted", "partial", "failed"])
    .default("not_attempted"),
});

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceType = (typeof sourceTypes)[number];

export const verificationStatuses = [
  "unverified",
  "partially_supported",
  "supported",
  "conflicting",
] as const;

export const extractionStatuses = [
  "not_attempted",
  "extracted",
  "partial",
  "failed",
] as const;

export const availabilityStatuses = [
  "expired",
  "upcoming",
  "open",
  "unknown",
] as const;

export const retrievalStatuses = [
  "not_attempted",
  "retrieved",
  "failed",
] as const;

export const retrievalFailureKinds = [
  "http_403",
  "http_404",
  "http_error",
  "timeout",
  "unsupported_content",
  "blocked",
  "network",
  "upstream_protocol",
  "unknown",
] as const;

export const scholarshipSchema = z.object({
  /** Stable local identifier assigned when the record is created. */
  id: z.string().trim().min(1),
  name: z.string().trim().min(1, "Scholarship name is required"),
  provider: z.string().trim().optional(),
  /** Original search-result URL, always retained for traceability. */
  sourceUrl: z.url().optional(),
  /** Title of the source page or search result, when known. */
  sourceTitle: z.string().trim().optional(),
  eligibleCitizenships: z.array(z.string().trim().min(1)).optional(),
  eligibleDegreeLevels: z.array(z.string().trim().min(1)).optional(),
  eligibleFieldsOfStudy: z.array(z.string().trim().min(1)).optional(),
  /** Countries or regions where study takes place, when stated. */
  studyDestinations: z.array(z.string().trim().min(1)).optional(),
  academicRequirements: z.string().trim().optional(),
  languageRequirements: z.string().trim().optional(),
  /** Combined free-text eligibility requirements, when stated. */
  eligibilityRequirements: z.string().trim().optional(),
  /** Application opening date (ISO date). Unknown stays undefined. */
  applicationOpeningDate: z.iso.date().optional(),
  /** Application closing date (ISO date). Unknown stays undefined. */
  applicationDeadline: z.iso.date().optional(),
  awardAmount: z.number().nonnegative().optional(),
  awardCurrency: z.string().trim().length(3).optional(),
  /** e.g. tuition, living costs, travel, or full funding, when stated. */
  fundingCoverage: z.string().trim().optional(),
  tuitionCoverage: z.string().trim().optional(),
  livingAllowance: z.string().trim().optional(),
  fundingDuration: z.string().trim().optional(),
  requiredDocuments: z.array(z.string().trim().min(1)).optional(),
  applicationInstructions: z.string().trim().optional(),
  officialUrl: z.url().optional(),
  /** All discovered sources for this record, with provenance. Default keeps old records loadable. */
  sources: z.array(sourceReferenceSchema).default([]),
  evidence: z.array(evidenceReferenceSchema).default([]),
  /** Extracted fields whose values have no supporting evidence quote. */
  unverifiedFields: z.array(z.string().trim().min(1)).optional(),
  /** Fields seen with contradictory values across sources. */
  conflictingFields: z.array(z.string().trim().min(1)).optional(),
  verificationStatus: z.enum(verificationStatuses).default("unverified"),
  /** Important fields whose evidence quotes were found in the fetched page. */
  supportedFields: z.array(z.string().trim().min(1)).optional(),
  extractionStatus: z.enum(extractionStatuses).default("not_attempted"),
  /** Human-readable extraction or fetch failure, when applicable. */
  extractionError: z.string().trim().optional(),
  /** Whether the source page itself was retrieved, separate from extraction. */
  retrievalStatus: z.enum(retrievalStatuses).default("not_attempted"),
  retrievalFailureKind: z.enum(retrievalFailureKinds).optional(),
  /** User-safe summary when retrieval failed; content stays unverified. */
  retrievalError: z.string().trim().optional(),
  /**
   * Deadline availability. Stays "unknown" unless reliable, evidence-
   * supported dates establish expired/upcoming/open; never inferred from
   * a successful fetch or extraction alone.
   */
  availabilityStatus: z.enum(availabilityStatuses).default("unknown"),
  retrievedAt: z.iso.datetime().optional(),
  /** When claims were last checked against retrieved evidence. */
  lastVerifiedAt: z.iso.datetime().optional(),
  /** Phase 3 eligibility gap analysis, when evaluation was attempted. */
  eligibility: eligibilityAssessmentSchema.optional(),
});

export type Scholarship = z.infer<typeof scholarshipSchema>;
export type VerificationStatus = (typeof verificationStatuses)[number];
export type ExtractionStatus = (typeof extractionStatuses)[number];
export type AvailabilityStatus = (typeof availabilityStatuses)[number];
export type RetrievalStatus = (typeof retrievalStatuses)[number];
export type RetrievalFailureKind = (typeof retrievalFailureKinds)[number];
