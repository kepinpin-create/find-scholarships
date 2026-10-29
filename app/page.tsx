"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { summarizeDashboard, type DashboardSummary } from "@/lib/dashboard";
import {
  loadFundingInput,
  loadOpportunities,
  loadProfile,
  loadSavedScholarships,
} from "@/lib/storage";

const journey = [
  { step: "1. Profile", href: "/profile" },
  { step: "2. Discover", href: "/opportunities" },
  { step: "3. Eligibility", href: "/opportunities" },
  { step: "4. Funding", href: "/funding" },
];

export default function Home() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const profile = loadProfile(window.localStorage);
      const { records } = loadOpportunities(window.localStorage);
      const saved = loadSavedScholarships(window.localStorage);
      const fundingInput = loadFundingInput(window.localStorage);
      setSummary(
        summarizeDashboard({
          profile,
          opportunities: records,
          savedBookmarks: Object.values(saved).filter((item) => item.saved).length,
          fundingInput,
        }),
      );
    } catch {
      setSummary(null);
    }
    setLoaded(true);
  }, []);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <p className="text-sm font-semibold tracking-wide text-[#2563eb] uppercase">
        Scholarship Navigator
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#14213d] sm:text-4xl">
        Your scholarship workspace
      </h1>
      <p className="mt-3 max-w-2xl text-[#33415c]">
        Profile-first discovery, evidence-backed eligibility, and a funding
        plan — built from your saved data only. Nothing here is demo data.
      </p>

      {!loaded ? (
        <p className="mt-8 text-[#5c677d]">Loading your workspace…</p>
      ) : !summary || (!summary.hasProfile && summary.totalScholarships === 0) ? (
        <section className="mt-8 rounded-xl border border-[#e2e0d8] bg-white p-6">
          <h2 className="text-xl font-semibold">Start with your profile</h2>
          <p className="mt-2 text-[#33415c]">
            Create your student profile to discover scholarships. No university
            choice or budget is required.
          </p>
          <Link
            href="/profile"
            className="mt-4 inline-flex h-12 items-center rounded-full bg-[#14213d] px-6 font-medium text-white hover:bg-[#24365e] focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
          >
            Create your profile
          </Link>
        </section>
      ) : (
        <>
          <section className="mt-8 rounded-xl border border-[#dbe3f2] bg-[#eef2fb] p-6">
            <h2 className="text-lg font-semibold">Next action: {summary.nextAction.label}</h2>
            <p className="mt-1 text-[#33415c]">{summary.nextAction.reason}</p>
            <Link
              href={summary.nextAction.href}
              className="mt-4 inline-flex h-11 items-center rounded-full bg-[#14213d] px-5 font-medium text-white hover:bg-[#24365e] focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
            >
              {summary.nextAction.label}
            </Link>
          </section>

          <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Summary">
            <div className="rounded-xl border border-[#e2e0d8] bg-white p-5">
              <p className="text-sm text-[#5c677d]">Discovered scholarships</p>
              <p className="mt-1 text-3xl font-bold">{summary.totalScholarships}</p>
              <p className="text-sm text-[#5c677d]">{summary.savedBookmarks} bookmarked by you · {summary.socialMentions} Instagram mentions</p>
            </div>
            <div className="rounded-xl border border-[#e2e0d8] bg-white p-5">
              <p className="text-sm text-[#5c677d]">Eligibility</p>
              <p className="mt-1 text-sm text-[#14213d]">
                {summary.eligibility.meets} meets known · {summary.eligibility.potentiallyEligible} potentially eligible
              </p>
              <p className="text-sm text-[#5c677d]">
                {summary.eligibility.doesNotMeet} does not meet · {summary.eligibility.unknown} unknown
              </p>
            </div>
            <div className="rounded-xl border border-[#e2e0d8] bg-white p-5">
              <p className="text-sm text-[#5c677d]">Confirmed funding gap</p>
              <p className="mt-1 text-2xl font-bold">
                {summary.fundingGap === null
                  ? "Unknown"
                  : `${summary.fundingCurrency} ${summary.fundingGap.toLocaleString()}`}
              </p>
              <p className="text-sm text-[#5c677d]">
                {summary.fundingGap === null
                  ? "Add study costs in Funding Plan to calculate it."
                  : "After confirmed funds only; scholarships are scenarios."}
              </p>
            </div>
            <div className="rounded-xl border border-[#e2e0d8] bg-white p-5">
              <p className="text-sm text-[#5c677d]">Source warnings</p>
              <p className="mt-1 text-3xl font-bold">{summary.verificationWarnings}</p>
              <p className="text-sm text-[#5c677d]">Sources failed, unverified, or not extracted</p>
            </div>
          </section>

          <section className="mt-6 rounded-xl border border-[#e2e0d8] bg-white p-6">
            <h2 className="text-lg font-semibold">Upcoming verified deadlines</h2>
            {!summary.upcomingDeadlines.length ? (
              <p className="mt-2 text-[#5c677d]">
                No evidence-supported upcoming deadlines yet. Deadlines are only
                shown when fetched evidence supports them.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {summary.upcomingDeadlines.map((item) => (
                  <li key={item.scholarshipId} className="flex flex-wrap justify-between gap-2 text-[#14213d]">
                    <span>{item.name}</span>
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="font-medium text-[#2563eb] hover:underline">
                      {item.deadline} ↗
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <nav aria-label="Journey" className="mt-8 flex flex-wrap gap-2">
        {journey.map((item) => (
          <Link
            key={item.step}
            href={item.href}
            className="rounded-full border border-[#c9d4ea] bg-white px-4 py-2 text-sm font-medium hover:bg-[#eef2fb] focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
          >
            {item.step}
          </Link>
        ))}
      </nav>
      <p className="mt-3 text-sm text-[#5c677d]">
        Saving a scholarship means bookmarking it for review — it is not an award and never counts as confirmed funding.
      </p>
    </main>
  );
}
