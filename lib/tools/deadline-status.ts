import type { AvailabilityStatus, Scholarship } from "@/lib/schemas/scholarship";

/**
 * Deadline availability (conservative by design).
 *
 * - Unknown or unsupported deadline -> "unknown". A past deadline is only
 *   "expired" when that deadline is supported by fetched evidence.
 * - A future deadline alone proves neither "upcoming" nor "open".
 * - "upcoming"/"open" require an evidence-supported opening date as well:
 *   opening in the future -> "upcoming"; opening reached and deadline not
 *   passed -> "open". Anything else stays "unknown".
 * Dates are compared as ISO calendar dates (YYYY-MM-DD).
 */
export function determineAvailabilityStatus(
  scholarship: Pick<
    Scholarship,
    "applicationDeadline" | "applicationOpeningDate" | "supportedFields"
  >,
  now: Date = new Date(),
): AvailabilityStatus {
  const deadline = scholarship.applicationDeadline;
  if (!deadline) return "unknown";

  const supported = new Set(scholarship.supportedFields ?? []);
  if (!supported.has("applicationDeadline")) return "unknown";

  const today = now.toISOString().slice(0, 10);
  if (deadline < today) return "expired";

  const opening = scholarship.applicationOpeningDate;
  if (!opening || !supported.has("applicationOpeningDate")) return "unknown";
  return opening > today ? "upcoming" : "open";
}
