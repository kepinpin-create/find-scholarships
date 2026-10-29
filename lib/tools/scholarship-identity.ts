import type { Scholarship } from "@/lib/schemas/scholarship";
import { classifySource } from "./scholarship-search";
import { determineAvailabilityStatus } from "./deadline-status";

/**
 * Cross-source scholarship identity and merge (Phase B).
 *
 * Identity keys are matching aids, not proof. Deadlines are never a
 * mandatory identity component because they change across application
 * cycles. Merging preserves every source and evidence item; conflicting
 * facts are flagged, never silently overwritten.
 */

export function normalizeIdentityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/fully funded|scholarships?|program(me)?s?/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function identityKeyFor(scholarship: Scholarship): string {
  const provider = normalizeIdentityText(scholarship.provider ?? "");
  const name = normalizeIdentityText(scholarship.name);
  return `${provider}|${name}`;
}

function tokens(value: string): Set<string> {
  return new Set(normalizeIdentityText(value).split(" ").filter((token) => token.length > 2));
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.max(a.size, b.size);
}

export function scholarshipsMatch(a: Scholarship, b: Scholarship): boolean {
  if (
    a.officialUrl &&
    b.officialUrl &&
    a.officialUrl.replace(/\/$/, "") === b.officialUrl.replace(/\/$/, "")
  ) {
    return true;
  }

  const nameSimilarity = similarity(tokens(a.name), tokens(b.name));
  if (nameSimilarity < 0.65) return false;

  const providerA = normalizeIdentityText(a.provider ?? "");
  const providerB = normalizeIdentityText(b.provider ?? "");
  if (providerA && providerB) {
    return similarity(tokens(providerA), tokens(providerB)) >= 0.5;
  }
  // Without provider identities, require a very strong name match plus a
  // shared destination or degree signal when those are available.
  if (nameSimilarity < 0.85) return false;
  const destinationsShare = a.studyDestinations?.some((item) =>
    b.studyDestinations?.includes(item),
  );
  const degreesShare = a.eligibleDegreeLevels?.some((item) =>
    b.eligibleDegreeLevels?.includes(item),
  );
  return Boolean(destinationsShare || degreesShare || (!a.studyDestinations && !b.studyDestinations));
}

function sourceAuthority(record: Scholarship): number {
  const types = record.sources.map((source) => source.sourceType);
  if (types.some((type) => type === "government" || type === "university" || type === "official_provider")) return 3;
  if (record.officialUrl) return 3;
  if (types.some((type) => type === "aggregator" || type === "social")) return 1;
  return 2;
}

function normalizedValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase().trim()).sort().join("|");
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function datesAreDifferentCycles(a: Scholarship, b: Scholarship, deadlineA: string, deadlineB: string): boolean {
  const days = Math.abs(new Date(deadlineA).getTime() - new Date(deadlineB).getTime()) / 86_400_000;
  if (days < 300) return false;
  const yearA = deadlineA.slice(0, 4);
  const yearB = deadlineB.slice(0, 4);
  return yearA !== yearB || a.name.includes(yearA) !== b.name.includes(yearB) || true;
}

export function detectClaimConflicts(records: Scholarship[]): string[] {
  const conflicts = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];

      if (a.applicationDeadline && b.applicationDeadline && a.applicationDeadline !== b.applicationDeadline) {
        if (!datesAreDifferentCycles(a, b, a.applicationDeadline, b.applicationDeadline)) {
          conflicts.add("applicationDeadline");
        }
      }

      if (
        a.awardAmount !== undefined &&
        b.awardAmount !== undefined &&
        a.awardCurrency &&
        a.awardCurrency === b.awardCurrency &&
        a.awardAmount !== b.awardAmount
      ) {
        conflicts.add("awardAmount");
      }

      for (const field of ["eligibleCitizenships", "eligibleDegreeLevels"] as const) {
        const valuesA = a[field];
        const valuesB = b[field];
        if (valuesA?.length && valuesB?.length) {
          const setB = new Set(valuesB.map((value) => value.toLowerCase()));
          if (!valuesA.some((value) => setB.has(value.toLowerCase()))) {
            conflicts.add(field);
          }
        }
      }

      if (
        a.fundingCoverage &&
        b.fundingCoverage &&
        normalizedValue(a.fundingCoverage) !== normalizedValue(b.fundingCoverage)
      ) {
        const tokensA = tokens(a.fundingCoverage);
        const tokensB = tokens(b.fundingCoverage);
        if (similarity(tokensA, tokensB) === 0) conflicts.add("fundingCoverage");
      }
    }
  }
  return [...conflicts];
}

function bestStatus<T extends string>(records: Scholarship[], pick: (record: Scholarship) => T, ranking: T[]): T {
  return ranking.find((status) => records.some((record) => pick(record) === status)) ?? ranking[ranking.length - 1];
}

export function mergeScholarshipGroup(records: Scholarship[]): Scholarship {
  const sorted = [...records].sort((a, b) => sourceAuthority(b) - sourceAuthority(a));
  const primary = sorted[0];
  const merged: Scholarship = { ...primary };

  // Fill only missing fields from other sources; never overwrite primary facts.
  for (const record of sorted.slice(1)) {
    for (const key of Object.keys(record) as Array<keyof Scholarship>) {
      if (merged[key] === undefined && record[key] !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as Record<string, unknown>)[key] = record[key];
      }
    }
  }

  const sourcesById = new Map<string, Scholarship["sources"][number]>();
  for (const record of records) {
    for (const source of record.sources) sourcesById.set(source.id, source);
    if (!record.sources.length && (record.sourceUrl || record.officialUrl)) {
      const url = record.sourceUrl ?? record.officialUrl ?? record.id;
      const classified = classifySource(url);
      sourcesById.set(url, {
        id: url,
        url,
        canonicalUrl: url,
        sourceType: classified.sourceType,
        publisherHost: classified.publisherHost,
        handle: classified.handle,
        retrievalStatus: record.retrievalStatus,
        extractionStatus: record.extractionStatus,
        retrievedAt: record.retrievedAt,
      });
    }
  }
  merged.sources = [...sourcesById.values()];

  const evidenceByKey = new Map<string, Scholarship["evidence"][number]>();
  for (const record of records) {
    for (const item of record.evidence) {
      evidenceByKey.set(`${item.field}|${item.quote}|${item.sourceUrl}`, item);
    }
  }
  merged.evidence = [...evidenceByKey.values()];

  merged.supportedFields = [...new Set(records.flatMap((record) => record.supportedFields ?? []))];
  const conflicts = detectClaimConflicts(records);
  merged.conflictingFields = conflicts.length ? conflicts : primary.conflictingFields;

  merged.extractionStatus = bestStatus(records, (record) => record.extractionStatus, ["extracted", "partial", "failed", "not_attempted"]);
  merged.retrievalStatus = bestStatus(records, (record) => record.retrievalStatus, ["retrieved", "failed", "not_attempted"]);

  const hasOfficialSource = merged.sources.some((source) =>
    ["government", "university", "official_provider"].includes(source.sourceType),
  );
  if (conflicts.length) {
    merged.verificationStatus = "conflicting";
  } else if (!hasOfficialSource && primary.verificationStatus === "supported") {
    // Aggregator/social repetition alone does not create official confirmation.
    merged.verificationStatus = "partially_supported";
  } else {
    merged.verificationStatus = primary.verificationStatus;
  }

  merged.availabilityStatus = conflicts.includes("applicationDeadline")
    ? "unknown"
    : determineAvailabilityStatus(merged);
  merged.eligibility = primary.eligibility ?? records.find((record) => record.eligibility)?.eligibility;
  return merged;
}

export function mergeScholarshipRecords(records: Scholarship[]): Scholarship[] {
  const groups: Scholarship[][] = [];
  for (const record of records) {
    const group = groups.find((candidate) => candidate.some((item) => scholarshipsMatch(item, record)));
    if (group) group.push(record);
    else groups.push([record]);
  }
  return groups.map(mergeScholarshipGroup);
}
