"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { StudentProfile } from "@/lib/schemas/student";
import type { Scholarship } from "@/lib/schemas/scholarship";
import { StatusChip } from "@/components/ui";
import { formatLabel } from "@/lib/format";
import {
  loadOpportunities,
  loadProfile,
  loadSavedScholarships,
  mergeDiscoveryResults,
  saveOpportunities,
  saveSavedScholarships,
  toggleSavedScholarship,
  type SavedScholarships,
} from "@/lib/storage";

interface DiscoveryResponse {
  status: "ok" | "empty" | "not_configured" | "failed";
  opportunities: Scholarship[];
  queries: string[];
  warnings: string[];
  missingConfiguration: string[];
  generatedAt: string;
}

function fundingSummary(item: Scholarship): string {
  const parts: string[] = [];
  if (item.awardAmount !== undefined) {
    parts.push(
      item.awardCurrency
        ? `${item.awardCurrency} ${item.awardAmount.toLocaleString()}`
        : String(item.awardAmount),
    );
  }
  if (item.fundingCoverage) parts.push(item.fundingCoverage);
  return parts.length ? parts.join(" · ") : "Funding: unknown";
}

function listOrUnknown(values?: string[]): string {
  return values?.length ? values.join(", ") : "Unknown";
}

const claimLabels: Record<Scholarship["verificationStatus"], string> = {
  supported: "Claims supported by fetched evidence",
  partially_supported: "Some claims supported",
  unverified: "Claims unverified",
  conflicting: "Claims conflicting",
};

const availabilityLabels: Record<Scholarship["availabilityStatus"], string> = {
  expired: "Expired (evidence-supported deadline)",
  upcoming: "Upcoming (evidence-supported dates)",
  open: "Open (evidence-supported dates)",
  unknown: "Availability unknown",
};

const eligibilityLabels: Record<string, string> = {
  meets_known_requirements: "Meets known requirements",
  potentially_eligible: "Potentially eligible — some information unknown",
  does_not_meet: "Does not meet known requirements",
  insufficient_information: "Insufficient information",
};

const categoryLabels: Record<string, string> = {
  citizenship: "Citizenship",
  degree_level: "Degree level",
  destination: "Destination",
  field_of_study: "Field of study",
  gpa: "GPA",
  language: "Language",
  age: "Age",
  work_experience: "Work experience",
  application_deadline: "Application deadline",
  other: "Other requirement",
};

function stageForElapsed(seconds: number): string {
  if (seconds < 20) return "Stage 1 of 3: searching for scholarship sources…";
  if (seconds < 60) return "Stage 2 of 3: fetching source pages safely…";
  return "Stage 3 of 3: extracting details and checking evidence…";
}

export default function OpportunitiesPage() {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [savedRecords, setSavedRecords] = useState<Scholarship[]>([]);
  const [bookmarks, setBookmarks] = useState<SavedScholarships>({});
  const [mergeNote, setMergeNote] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!loading) return;
    setElapsedSeconds(0);
    const timer = setInterval(
      () => setElapsedSeconds((value) => value + 1),
      1000,
    );
    return () => clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    try {
      setProfile(loadProfile(window.localStorage));
      setSavedRecords(loadOpportunities(window.localStorage).records);
      setBookmarks(loadSavedScholarships(window.localStorage));
    } catch {
      // Missing or corrupt profile: the page links back to /profile.
    }
    setLoaded(true);
  }, []);

  async function runDiscovery() {
    if (!profile) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      const data = (await response.json()) as DiscoveryResponse & {
        error?: string;
      };
      if (data.status === "not_configured") {
        setResult(data);
        setError(
          `Live discovery is not configured. Missing: ${data.missingConfiguration.join(", ")}. Add them to .env.local and restart the server.`,
        );
        return;
      }
      if (!response.ok) {
        setError(data.error ?? "Discovery failed. Please try again.");
        return;
      }
      setResult(data);
      // Results are intentionally NOT persisted here. Saving is explicit:
      // the student reviews the latest search first, then clicks
      // "Save these results". A page refresh therefore always shows the
      // last explicitly saved collection.
      if (data.opportunities.length === 0) {
        setMergeNote(
          "Latest search returned no scholarships. Your previously saved results below were preserved.",
        );
      }
    } catch {
      setError("Could not reach the discovery service. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  function saveLatestResults() {
    if (!result || result.opportunities.length === 0) return;
    try {
      const previous = loadOpportunities(window.localStorage).records;
      const { merged, added } = mergeDiscoveryResults(previous, result.opportunities);
      saveOpportunities(window.localStorage, merged);
      setSavedRecords(merged);
      setMergeNote(
        added > 0
          ? `Saved. ${added} new scholarship${added === 1 ? "" : "s"} added to your saved collection (${merged.length} total). Earlier saved results were preserved.`
          : `Saved. No genuinely new scholarships were added; your saved collection (${merged.length} total) was preserved.`,
      );
      setResult(null);
    } catch {
      setMergeNote("Could not save these results in this browser. They are still shown above.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        Scholarship opportunities
      </h1>

      {!loaded ? (
        <p className="mt-6 text-zinc-600 dark:text-zinc-400">Loading your profile…</p>
      ) : !profile ? (
        <section className="mt-8 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <p className="text-zinc-700 dark:text-zinc-300">
            Create your student profile first. Discovery uses it to build search
            queries — no university or budget is required.
          </p>
          <Link
            href="/profile"
            className="mt-4 inline-flex h-11 items-center rounded-full bg-zinc-900 px-5 font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
          >
            Create your profile
          </Link>
        </section>
      ) : (
        <>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Profile: {profile.intendedDegreeLevel} in {profile.fieldOfStudy}
            {profile.citizenship ? ` · ${profile.citizenship}` : ""}
            {profile.preferredDestinations?.length
              ? ` · ${profile.preferredDestinations.join(", ")}`
              : ""}
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={runDiscovery}
              disabled={loading}
              className="inline-flex h-12 items-center justify-center rounded-full bg-zinc-900 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
            {loading
              ? `${stageForElapsed(elapsedSeconds)} (${elapsedSeconds}s)`
              : "Find my scholarships"}
            </button>
            <Link
              href="/profile"
              className="inline-flex h-12 items-center justify-center rounded-full border border-zinc-300 px-6 font-medium dark:border-zinc-700"
            >
              Edit profile
            </Link>
            <Link
              href="/funding"
              className="inline-flex h-12 items-center justify-center rounded-full border border-zinc-300 px-6 font-medium dark:border-zinc-700"
            >
              Funding plan
            </Link>
            {result && result.opportunities.length > 0 && (
              <button
                type="button"
                onClick={saveLatestResults}
                className="inline-flex h-12 items-center justify-center rounded-full bg-[#2563eb] px-6 font-medium text-white hover:bg-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
              >
                Save these results
              </button>
            )}
          </div>
          {loading && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              Discovery checks each source page and its evidence, so this can
              take a few minutes. Results appear when the full check finishes.
            </p>
          )}

          {error && (
            <p className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {error}
            </p>
          )}

          {mergeNote && (
            <p className="mt-6 rounded-xl border border-[#dbe3f2] bg-[#eef2fb] p-4 text-[#14213d]">
              {mergeNote}
            </p>
          )}

          {result && !error && result.opportunities.length === 0 && (
            <p className="mt-6 rounded-xl border border-zinc-200 p-4 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
              No opportunities were returned in the latest search. Nothing has been fabricated — try
              again later or broaden your profile preferences.
            </p>
          )}

          {result && result.warnings.length > 0 && (
            <details className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <summary className="cursor-pointer font-medium">
                {result.warnings.length} source check
                {result.warnings.length === 1 ? "" : "s"} could not be completed
                — affected sources stay unverified
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}

          <section className="mt-8 space-y-4">
            {!result && savedRecords.length > 0 && (
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Saved collection ({savedRecords.length})
              </h2>
            )}
            {result && result.opportunities.length > 0 && (
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Latest search results — not saved yet ({result.opportunities.length})
              </h2>
            )}
            {(result ? result.opportunities : savedRecords).map((item) => {
              const socialMentions = (item.sources ?? []).filter(
                (source) => source.sourceType === "social",
              );
              const expanded = expandedIds.has(item.id);
              const compactMeta = [
                item.eligibleDegreeLevels?.length
                  ? item.eligibleDegreeLevels.join(", ")
                  : null,
                item.eligibleFieldsOfStudy?.length
                  ? item.eligibleFieldsOfStudy.join(", ")
                  : null,
                item.studyDestinations?.length
                  ? item.studyDestinations.join(", ")
                  : null,
              ].filter(Boolean);
              return (
              <article
                key={item.id}
                className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(item.id)}
                    className="text-left focus:outline-none focus:ring-2 focus:ring-[#2563eb] rounded"
                  >
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                      {item.name} <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    </h2>
                  </button>
                  <button
                    type="button"
                    aria-pressed={Boolean(bookmarks[item.id]?.saved)}
                    onClick={() => {
                      const next = toggleSavedScholarship(bookmarks, item.id);
                      setBookmarks(next);
                      try {
                        saveSavedScholarships(window.localStorage, next);
                      } catch {
                        // Bookmark state still updates for this session.
                      }
                    }}
                    className="rounded-full border border-[#c9d4ea] bg-white px-3 py-1 text-xs font-medium text-[#14213d] hover:bg-[#eef2fb] focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                  >
                    {bookmarks[item.id]?.saved ? "Bookmarked" : "Bookmark"}
                  </button>
                </div>
                {bookmarks[item.id]?.saved && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Bookmarked for review — this is not an award or confirmed funding.
                  </p>
                )}
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Provider: {item.provider ?? "Unknown"} · {fundingSummary(item)}
                </p>
                {compactMeta.length > 0 && (
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                    {compactMeta.join(" · ")}
                  </p>
                )}
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Deadline: {item.applicationDeadline ?? "Unknown"} · {availabilityLabels[item.availabilityStatus]}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {item.eligibility && (
                    <StatusChip
                      label="Eligibility"
                      value={eligibilityLabels[item.eligibility.overallStatus]}
                    />
                  )}
                  <StatusChip label="Claims" value={claimLabels[item.verificationStatus]} />
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(item.id)}
                    className="rounded-full border border-[#c9d4ea] bg-white px-3 py-1 text-xs font-medium text-[#14213d] hover:bg-[#eef2fb] focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                  >
                    {expanded ? "Hide details" : "View details"}
                  </button>
                </div>
                {expanded && (
                <>
                <div className="mt-2 flex flex-wrap gap-2">
                  <StatusChip
                    label="Source"
                    value={
                      item.retrievalStatus === "retrieved"
                        ? "Retrieved"
                        : item.retrievalStatus === "failed"
                          ? "Not retrieved"
                          : "Not attempted"
                    }
                  />
                  <StatusChip
                    label="Extraction"
                    value={formatLabel(item.extractionStatus)}
                  />
                  <StatusChip label="Claims" value={claimLabels[item.verificationStatus]} />
                  <StatusChip
                    label="Availability"
                    value={availabilityLabels[item.availabilityStatus]}
                  />
                </div>
                {!!item.sources?.length && (
                  <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    <span className="font-medium text-zinc-800 dark:text-zinc-200">Sources:</span>{" "}
                    {item.sources.map((source) => (
                      <span key={source.id} className="mr-2">
                        [{source.sourceType}] {source.handle ? `@${source.handle} · ` : ""}{source.publisherHost} ({source.retrievalStatus})
                      </span>
                    ))}
                  </div>
                )}
                {socialMentions.length > 0 && (
                  <div className="mt-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
                    <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                      Testimonials & social mentions
                    </h4>
                    <ul className="mt-1 space-y-1 text-sm">
                      {socialMentions.map((source) => (
                        <li key={source.id}>
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                          >
                            {source.handle ? `@${source.handle}` : source.publisherHost} ↗
                          </a>{" "}
                          <span className="text-xs text-zinc-500">
                            ({source.retrievalStatus === "retrieved" ? "post accessible" : "post not retrieved"})
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-zinc-500">
                      Unverified social mentions — recipient stories, not evidence. They do not affect verification, eligibility, or funding, and may be promotional.
                    </p>
                  </div>
                )}
                {item.retrievalStatus === "failed" && (
                  <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                    {item.sourceUrl?.toLowerCase().endsWith(".pdf")
                      ? "PDF source — text extraction is not supported, so this content was not verified. Open the original source to check it."
                      : (item.retrievalError ??
                        "Source could not be retrieved; its content was not verified.")}
                  </p>
                )}
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Provider: {item.provider ?? "Unknown"} · {fundingSummary(item)}
                </p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Deadline:{" "}
                  {item.applicationDeadline ?? "Unknown"}
                  {" · "}Availability:{" "}
                  {availabilityLabels[item.availabilityStatus]}
                </p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Eligibility — nationalities: {listOrUnknown(item.eligibleCitizenships)}
                  {" · "}levels: {listOrUnknown(item.eligibleDegreeLevels)}
                  {" · "}fields: {listOrUnknown(item.eligibleFieldsOfStudy)}
                </p>
                {item.availabilityStatus === "expired" && (
                  <p className="mt-2 text-sm font-medium text-red-700 dark:text-red-300">
                    This deadline has passed. This scholarship is not currently actionable.
                  </p>
                )}
                {item.eligibility && (
                  <section aria-label={`Eligibility for ${item.name}`} className="mt-4 rounded-lg bg-zinc-50 p-4 dark:bg-zinc-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                        Eligibility gap analysis
                      </h3>
                      <StatusChip
                        label="Overall"
                        value={eligibilityLabels[item.eligibility.overallStatus]}
                      />
                    </div>
                    {item.eligibility.limitation && (
                      <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                        {item.eligibility.limitation}
                      </p>
                    )}
                    {(["meets", "does_not_meet", "unknown"] as const).map((group) => {
                      const grouped = item.eligibility?.requirements.filter(
                        (req) => req.evaluation === group,
                      );
                      if (!grouped?.length) return null;
                      const heading =
                        group === "meets"
                          ? "Requirements met"
                          : group === "does_not_meet"
                            ? "Requirements not met"
                            : "Unknown or missing information";
                      return (
                        <div key={group} className="mt-3">
                          <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                            {heading}
                          </h4>
                          <ul className="mt-1 space-y-2">
                            {grouped.map((req, index) => (
                              <li key={`${req.category}-${index}`} className="text-sm text-zinc-700 dark:text-zinc-300">
                                <span className="font-medium">
                                  {categoryLabels[req.category] ?? req.category}:
                                </span>{" "}
                                {req.normalizedRequirement ?? req.requirementText}
                                <span className="block text-zinc-600 dark:text-zinc-400">
                                  {req.explanation}
                                </span>
                                {req.evidenceQuote && (
                                  <blockquote className="mt-1 border-l-2 border-zinc-300 pl-2 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                                    “{req.evidenceQuote}”
                                  </blockquote>
                                )}
                                <span className="mt-0.5 block text-xs text-zinc-500">
                                  Evidence: {req.evidenceStatus} ·{" "}
                                  <a href={req.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline dark:text-emerald-400">
                                    Source
                                  </a>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                    {!item.eligibility.requirements.length && !item.eligibility.limitation && (
                      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                        No evaluable requirements were extracted. Eligibility remains unknown.
                      </p>
                    )}
                  </section>
                )}
                {item.unverifiedFields?.length ? (
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                    Unverified fields: {item.unverifiedFields.join(", ")}
                  </p>
                ) : null}
                {item.lastVerifiedAt && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Evidence checked: {item.lastVerifiedAt}
                  </p>
                )}
                {item.officialUrl && item.officialUrl !== item.sourceUrl ? (
                  <a
                    href={item.officialUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                  >
                    Official application page ↗
                  </a>
                ) : item.sourceUrl ? (
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                  >
                    Open source page ↗
                  </a>
                ) : null}
                </>
                )}
              </article>
              );
            })}
          </section>
        </>
      )}
    </main>
  );
}
