"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  calculateFundingPlan,
  buildScholarshipFundingScenario,
} from "@/lib/tools/funding-calculator";
import {
  costCategories,
  fundingFrequencies,
  type ConfirmedFundingItem,
  type ExchangeRate,
  type StudyCostItem,
} from "@/lib/schemas/funding";
import type { Scholarship } from "@/lib/schemas/scholarship";
import { formatLabel } from "@/lib/format";
import type { StudentProfile } from "@/lib/schemas/student";
import {
  FUNDING_KEY,
  loadFundingInput,
  loadOpportunities,
  loadProfile,
} from "@/lib/storage";

const inputClass =
  "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
const labelClass = "block text-sm font-medium text-zinc-800 dark:text-zinc-200";

let nextId = 1;
function id(prefix: string) {
  return `${prefix}-${nextId++}-${Date.now()}`;
}

function money(amount: number | null, currency: string): string {
  return amount === null ? "Unknown" : `${currency} ${amount.toLocaleString()}`;
}

const eligibilityLabels: Record<string, string> = {
  meets_known_requirements: "Eligible (known requirements)",
  potentially_eligible: "Potentially eligible",
  does_not_meet: "Ineligible (known requirements)",
  insufficient_information: "Insufficient information",
};

export default function FundingPage() {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [targetCurrency, setTargetCurrency] = useState("USD");
  const [studyPeriodYears, setStudyPeriodYears] = useState("2");
  const [costs, setCosts] = useState<StudyCostItem[]>([]);
  const [confirmed, setConfirmed] = useState<ConfirmedFundingItem[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const loadedProfile = loadProfile(window.localStorage);
      if (loadedProfile) {
        setProfile(loadedProfile);
        if (loadedProfile.personalBudgetAmount !== undefined && loadedProfile.personalBudgetCurrency) {
          setConfirmed([
            {
              id: id("fund"),
              label: "Personal funds from profile",
              amount: loadedProfile.personalBudgetAmount,
              currency: loadedProfile.personalBudgetCurrency,
              frequency: "one_time",
              source: "Student profile (frequency not stated; treated as available one-time funds)",
            },
          ]);
        }
      }
      const { records } = loadOpportunities(window.localStorage);
      setScholarships(records);
      setSelected(Object.fromEntries(records.map((item) => [item.id, true])));

      const saved = loadFundingInput(window.localStorage);
      if (saved) {
        setTargetCurrency(saved.targetCurrency);
        setStudyPeriodYears(saved.studyPeriodYears);
        setCosts(saved.costs);
        setRates(saved.rates);
        // Confirmed funds are only prefilled from the profile on first load;
        // a saved list (including an intentionally empty one) wins after that.
        setConfirmed(saved.confirmed);
      }
    } catch {
      // Corrupt local data is ignored; inputs remain editable.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FUNDING_KEY,
        JSON.stringify({ targetCurrency, studyPeriodYears, costs, confirmed, rates }),
      );
    } catch {
      // Storage is best-effort only.
    }
  }, [targetCurrency, studyPeriodYears, costs, confirmed, rates]);

  const { result, formError } = useMemo(() => {
    try {
      const years = Number(studyPeriodYears);
      const scenarios = scholarships
        .filter((item) => selected[item.id])
        .map(buildScholarshipFundingScenario);
      const calculation = calculateFundingPlan(
        {
          targetCurrency: targetCurrency.trim().toUpperCase(),
          studyPeriodYears: years,
          costs,
          confirmedFunding: confirmed,
          exchangeRates: rates,
        },
        scenarios,
      );
      return { result: calculation, formError: null as string | null };
    } catch {
      return {
        result: null,
        formError:
          "Some funding inputs are invalid. Check amounts, currencies, period, and exchange rates.",
      };
    }
  }, [targetCurrency, studyPeriodYears, costs, confirmed, rates, scholarships, selected]);

  function addCost() {
    setCosts((items) => [
      ...items,
      {
        id: id("cost"),
        category: "tuition",
        label: "Tuition",
        amount: 0,
        currency: targetCurrency.toUpperCase(),
        frequency: "annual",
        recurring: true,
      },
    ]);
  }

  function addConfirmed() {
    setConfirmed((items) => [
      ...items,
      {
        id: id("fund"),
        label: "Confirmed funding",
        amount: 0,
        currency: targetCurrency.toUpperCase(),
        frequency: "one_time",
      },
    ]);
  }

  function addRate() {
    setRates((items) => [
      ...items,
      { fromCurrency: "USD", toCurrency: targetCurrency.toUpperCase(), rate: 1 },
    ]);
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
      <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        Funding plan
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Enter known study costs and confirmed funds. Scholarship awards are
        shown only as unawarded scenarios — they never reduce your confirmed
        funding gap. Unknown amounts stay unknown, not zero.
      </p>
      {profile && (
        <p className="mt-2 text-sm text-zinc-500">
          Profile: {profile.intendedDegreeLevel} in {profile.fieldOfStudy}
          {profile.personalBudgetAmount !== undefined
            ? ` · personal funds ${profile.personalBudgetCurrency ?? ""} ${profile.personalBudgetAmount.toLocaleString()}`
            : " · no personal budget stated"}
        </p>
      )}

      <section className="mt-8 grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="targetCurrency">Comparison currency</label>
          <input id="targetCurrency" className={inputClass} maxLength={3} value={targetCurrency} onChange={(e) => setTargetCurrency(e.target.value.toUpperCase())} />
        </div>
        <div>
          <label className={labelClass} htmlFor="studyPeriodYears">Study period (years)</label>
          <input id="studyPeriodYears" className={inputClass} inputMode="decimal" value={studyPeriodYears} onChange={(e) => setStudyPeriodYears(e.target.value)} />
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Study costs</h2>
          <button type="button" onClick={addCost} className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">Add cost</button>
        </div>
        {!costs.length && <p className="mt-3 text-sm text-zinc-500">No costs entered yet. Total costs remain unknown until you add them.</p>}
        <div className="mt-4 space-y-4">
          {costs.map((cost) => (
            <fieldset key={cost.id} className="grid gap-3 rounded-xl border border-zinc-200 p-4 sm:grid-cols-6 dark:border-zinc-800">
              <div className="sm:col-span-2">
                <label className={labelClass}>Label<input className={inputClass} value={cost.label} onChange={(e) => setCosts(costs.map((item) => item.id === cost.id ? { ...item, label: e.target.value } : item))} /></label>
              </div>
              <div>
                <label className={labelClass}>Category
                  <select className={inputClass} value={cost.category} onChange={(e) => setCosts(costs.map((item) => item.id === cost.id ? { ...item, category: e.target.value as StudyCostItem["category"] } : item))}>
                    {costCategories.map((category) => <option key={category} value={category}>{formatLabel(category)}</option>)}
                  </select>
                </label>
              </div>
              <div>
                <label className={labelClass}>Amount<input className={inputClass} inputMode="decimal" value={String(cost.amount)} onChange={(e) => setCosts(costs.map((item) => item.id === cost.id ? { ...item, amount: Number(e.target.value) } : item))} /></label>
              </div>
              <div>
                <label className={labelClass}>Currency<input className={inputClass} maxLength={3} value={cost.currency} onChange={(e) => setCosts(costs.map((item) => item.id === cost.id ? { ...item, currency: e.target.value.toUpperCase() } : item))} /></label>
              </div>
              <div>
                <label className={labelClass}>Frequency
                  <select className={inputClass} value={cost.frequency} onChange={(e) => { const frequency = e.target.value as StudyCostItem["frequency"]; setCosts(costs.map((item) => item.id === cost.id ? { ...item, frequency, recurring: frequency !== "one_time" } : item)); }}>
                    {fundingFrequencies.map((frequency) => <option key={frequency} value={frequency}>{formatLabel(frequency)}</option>)}
                  </select>
                </label>
              </div>
              <button type="button" onClick={() => setCosts(costs.filter((item) => item.id !== cost.id))} className="text-left text-sm text-red-600">Remove</button>
            </fieldset>
          ))}
        </div>
      </section>

      <section className="mt-10 rounded-xl border border-[#2563eb] bg-[#eef2fb] p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Confirmed funding</h2>
          <button type="button" onClick={addConfirmed} className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">Add confirmed fund</button>
        </div>
        <p className="mt-2 text-sm text-zinc-500">Only money you already have or have been formally awarded. Unawarded scholarships belong below as scenarios.</p>
        <div className="mt-4 space-y-4">
          {confirmed.map((fund) => (
            <fieldset key={fund.id} className="grid gap-3 rounded-xl border border-zinc-200 p-4 sm:grid-cols-5 dark:border-zinc-800">
              <div className="sm:col-span-2"><label className={labelClass}>Label<input className={inputClass} value={fund.label} onChange={(e) => setConfirmed(confirmed.map((item) => item.id === fund.id ? { ...item, label: e.target.value } : item))} /></label></div>
              <div><label className={labelClass}>Amount<input className={inputClass} inputMode="decimal" value={String(fund.amount)} onChange={(e) => setConfirmed(confirmed.map((item) => item.id === fund.id ? { ...item, amount: Number(e.target.value) } : item))} /></label></div>
              <div><label className={labelClass}>Currency<input className={inputClass} maxLength={3} value={fund.currency} onChange={(e) => setConfirmed(confirmed.map((item) => item.id === fund.id ? { ...item, currency: e.target.value.toUpperCase() } : item))} /></label></div>
              <div><label className={labelClass}>Frequency
                <select className={inputClass} value={fund.frequency} onChange={(e) => setConfirmed(confirmed.map((item) => item.id === fund.id ? { ...item, frequency: e.target.value as ConfirmedFundingItem["frequency"] } : item))}>
                  {fundingFrequencies.map((frequency) => <option key={frequency} value={frequency}>{formatLabel(frequency)}</option>)}
                </select></label></div>
              <button type="button" onClick={() => setConfirmed(confirmed.filter((item) => item.id !== fund.id))} className="text-left text-sm text-red-600">Remove</button>
            </fieldset>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Exchange rates</h2>
          <button type="button" onClick={addRate} className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700">Add rate</button>
        </div>
        <p className="mt-2 text-sm text-zinc-500">Currencies are converted only with a rate you supply here (1 unit of the first currency = rate × comparison currency). Without a rate, amounts stay separate.</p>
        <div className="mt-4 space-y-3">
          {rates.map((rate, index) => (
            <div key={index} className="grid gap-3 rounded-xl border border-zinc-200 p-4 sm:grid-cols-4 dark:border-zinc-800">
              <label className={labelClass}>From<input className={inputClass} maxLength={3} value={rate.fromCurrency} onChange={(e) => setRates(rates.map((item, i) => i === index ? { ...item, fromCurrency: e.target.value.toUpperCase() } : item))} /></label>
              <label className={labelClass}>To<input className={inputClass} maxLength={3} value={rate.toCurrency} onChange={(e) => setRates(rates.map((item, i) => i === index ? { ...item, toCurrency: e.target.value.toUpperCase() } : item))} /></label>
              <label className={labelClass}>Rate<input className={inputClass} inputMode="decimal" value={String(rate.rate)} onChange={(e) => setRates(rates.map((item, i) => i === index ? { ...item, rate: Number(e.target.value) } : item))} /></label>
              <button type="button" onClick={() => setRates(rates.filter((_, i) => i !== index))} className="text-left text-sm text-red-600">Remove</button>
            </div>
          ))}
        </div>
      </section>

      {formError && <p className="mt-8 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{formError}</p>}

      {result && (
        <section className="mt-10 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800" aria-live="polite">
          <h2 className="text-xl font-semibold">Funding gap</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div><dt className="text-sm text-zinc-500">Total costs ({result.studyPeriodYears} years)</dt><dd className="text-lg font-semibold">{money(result.totalCosts.amount, result.targetCurrency)}</dd></div>
            <div><dt className="text-sm text-zinc-500">Confirmed funding</dt><dd className="text-lg font-semibold">{money(result.confirmedFunding.amount, result.targetCurrency)}</dd></div>
            <div><dt className="text-sm text-zinc-500">Remaining confirmed gap</dt><dd className="text-lg font-semibold">{money(result.confirmedGap, result.targetCurrency)}</dd></div>
          </dl>
          {!!result.costBreakdown.length && (
            <div className="mt-4">
              <h3 className="font-medium">Cost breakdown</h3>
              <ul className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {result.costBreakdown.map((item) => <li key={item.category}>{formatLabel(item.category)}: {money(item.total.amount, result.targetCurrency)}</li>)}
              </ul>
            </div>
          )}
          {(result.totalCosts.unconverted.length > 0 || result.confirmedFunding.unconverted.length > 0) && (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
              Unconverted amounts remain separate: costs {result.totalCosts.unconverted.map((item) => `${item.currency} ${item.amount.toLocaleString()}`).join(", ") || "none"}; confirmed {result.confirmedFunding.unconverted.map((item) => `${item.currency} ${item.amount.toLocaleString()}`).join(", ") || "none"}.
            </p>
          )}
          {result.warnings.map((warning) => <p key={warning} className="mt-2 text-sm text-amber-700 dark:text-amber-300">{warning}</p>)}
          <ul className="mt-3 list-disc pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            {result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
          </ul>
        </section>
      )}

      <section className="mt-10 rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950">
        <h2 className="text-xl font-semibold">Potential scholarship scenarios</h2>
        {!scholarships.length ? (
          <p className="mt-3 text-sm text-zinc-500">
            No discovery results are saved yet. Run discovery first, then return here.{" "}
            <Link href="/opportunities" className="text-emerald-700 hover:underline dark:text-emerald-400">Go to opportunities</Link>
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {scholarships.map((item) => {
              const scenario = result?.scenarios.find((entry) => entry.scholarshipId === item.id);
              return (
                <article key={item.id} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={Boolean(selected[item.id])} onChange={(e) => setSelected({ ...selected, [item.id]: e.target.checked })} />
                    <span className="font-semibold">{item.name}</span>
                  </label>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    Eligibility: {eligibilityLabels[item.eligibility?.overallStatus ?? "insufficient_information"]} · Availability: {formatLabel(item.availabilityStatus)} · Unawarded scenario
                  </p>
                  {scenario && (
                    <>
                      <p className="mt-1 text-sm">Known potential amount: {money(scenario.amount, result?.targetCurrency ?? targetCurrency)} · Scenario gap: {money(scenario.scenarioGap, result?.targetCurrency ?? targetCurrency)}</p>
                      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Coverage status: {formatLabel(scenario.coverageStatus)}</p>
                      {scenario.coverageItems.map((coverage, index) => (
                        <p key={index} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                          {formatLabel(coverage.category)}: {coverage.description} ({coverage.status}) · <a href={coverage.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline dark:text-emerald-400">Evidence source</a>
                        </p>
                      ))}
                      {scenario.assumptions.map((assumption) => <p key={assumption} className="mt-1 text-xs text-zinc-500">{assumption}</p>)}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
