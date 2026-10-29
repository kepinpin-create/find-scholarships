"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  academicStatuses,
  currentEducationLevels,
  intendedDegreeLevels,
  studentProfileSchema,
  type StudentProfile,
} from "@/lib/schemas/student";

import { PROFILE_KEY as STORAGE_KEY } from "@/lib/storage";
import { formatLabel } from "@/lib/format";
import { COMMON_FIELDS, COUNTRIES, CURRENCIES, LANGUAGE_TESTS } from "@/lib/countries";

type FormState = {
  currentEducationLevel: string;
  academicStatus: string;
  gpa: string;
  gpaScale: string;
  intendedDegreeLevel: string;
  fieldOfStudy: string;
  fieldOfStudyCustom: string;
  fieldCustomMode: boolean;
  languageTest: string;
  languageScore: string;
  citizenship: string;
  preferredDestinations: string[];
  personalBudgetAmount: string;
  personalBudgetCurrency: string;
};

const emptyForm: FormState = {
  currentEducationLevel: "",
  academicStatus: "",
  gpa: "",
  gpaScale: "",
  intendedDegreeLevel: "",
  fieldOfStudy: "",
  fieldOfStudyCustom: "",
  fieldCustomMode: false,
  languageTest: "",
  languageScore: "",
  citizenship: "",
  preferredDestinations: [],
  personalBudgetAmount: "",
  personalBudgetCurrency: "",
};

function optionalText(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalNumber(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

function composeLanguage(form: FormState): string | undefined {
  if (!form.languageTest || !form.languageScore.trim()) return undefined;
  return `${form.languageTest} ${form.languageScore.trim()}`;
}

function splitLanguage(value?: string): { test: string; score: string } {
  if (!value) return { test: "", score: "" };
  for (const test of LANGUAGE_TESTS) {
    if (value.toLowerCase().startsWith(test.toLowerCase())) {
      return { test, score: value.slice(test.length).trim() };
    }
  }
  return { test: "Other", score: value };
}

function toCandidate(form: FormState) {
  return {
    currentEducationLevel: form.currentEducationLevel || undefined,
    academicStatus: form.academicStatus || undefined,
    gpa: optionalNumber(form.gpa),
    gpaScale: optionalNumber(form.gpaScale),
    intendedDegreeLevel: form.intendedDegreeLevel || undefined,
    fieldOfStudy: (form.fieldOfStudy || form.fieldOfStudyCustom).trim(),
    languageProficiency: composeLanguage(form),
    citizenship: optionalText(form.citizenship),
    preferredDestinations: form.preferredDestinations.length
      ? form.preferredDestinations
      : undefined,
    personalBudgetAmount: optionalNumber(form.personalBudgetAmount),
    personalBudgetCurrency: optionalText(form.personalBudgetCurrency),
  };
}

function toForm(profile: StudentProfile): FormState {
  const language = splitLanguage(profile.languageProficiency);
  return {
    currentEducationLevel: profile.currentEducationLevel ?? "",
    academicStatus: profile.academicStatus ?? "",
    gpa: profile.gpa?.toString() ?? "",
    gpaScale: profile.gpaScale?.toString() ?? "",
    intendedDegreeLevel: profile.intendedDegreeLevel,
    fieldOfStudy: (COMMON_FIELDS as readonly string[]).includes(profile.fieldOfStudy)
      ? profile.fieldOfStudy
      : "",
    fieldOfStudyCustom: (COMMON_FIELDS as readonly string[]).includes(profile.fieldOfStudy)
      ? ""
      : profile.fieldOfStudy,
    fieldCustomMode: !(COMMON_FIELDS as readonly string[]).includes(profile.fieldOfStudy),
    languageTest: language.test,
    languageScore: language.score,
    citizenship: profile.citizenship ?? "",
    preferredDestinations: profile.preferredDestinations ?? [],
    personalBudgetAmount: profile.personalBudgetAmount?.toString() ?? "",
    personalBudgetCurrency: profile.personalBudgetCurrency ?? "",
  };
}

const inputClass =
  "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
const labelClass = "block text-sm font-medium text-zinc-800 dark:text-zinc-200";
const errorClass = "mt-1 text-sm text-red-600 dark:text-red-400";
const hintClass = "mt-1 text-xs text-zinc-500 dark:text-zinc-400";

export default function ProfilePage() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<StudentProfile | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = studentProfileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        setSaved(parsed.data);
        setForm(toForm(parsed.data));
      }
    } catch {
      // Corrupt local data is ignored; the form stays editable.
    }
  }, []);

  function update<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = studentProfileSchema.safeParse(toCandidate(form));

    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? "form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      setSaved(null);
      return;
    }

    setErrors({});
    setSaved(result.data);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result.data));
    } catch {
      // Profile still validates for this session if storage is unavailable.
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <Link href="/" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
        ← Back to overview
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        Your student profile
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Intended degree, field of study, and citizenship are required. Everything
        else is optional: leaving it empty means “unknown”, not zero or ineligible.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 space-y-5">
        <div>
          <label className={labelClass} htmlFor="currentEducationLevel">
            Current education level (optional)
          </label>
          <select
            id="currentEducationLevel"
            className={inputClass}
            value={form.currentEducationLevel}
            onChange={(e) => update("currentEducationLevel", e.target.value)}
          >
            <option value="">Select…</option>
            {currentEducationLevels.map((level) => (
              <option key={level} value={level}>
                {formatLabel(level)}
              </option>
            ))}
          </select>
          {errors.currentEducationLevel && (
            <p className={errorClass}>{errors.currentEducationLevel}</p>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="academicStatus">
            Academic status (optional)
          </label>
          <select
            id="academicStatus"
            className={inputClass}
            value={form.academicStatus}
            onChange={(e) => update("academicStatus", e.target.value)}
          >
            <option value="">Select…</option>
            {academicStatuses.map((status) => (
              <option key={status} value={status}>
                {formatLabel(status)}
              </option>
            ))}
          </select>
          {errors.academicStatus && <p className={errorClass}>{errors.academicStatus}</p>}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="gpa">
              GPA (optional)
            </label>
            <input
              id="gpa"
              className={inputClass}
              inputMode="decimal"
              placeholder="e.g. 3.7"
              value={form.gpa}
              onChange={(e) => update("gpa", e.target.value)}
            />
            {errors.gpa && <p className={errorClass}>{errors.gpa}</p>}
          </div>
          <div>
            <label className={labelClass} htmlFor="gpaScale">
              GPA scale (optional)
            </label>
            <select
              id="gpaScale"
              className={inputClass}
              value={form.gpaScale}
              onChange={(e) => update("gpaScale", e.target.value)}
            >
              <option value="">Select…</option>
              {["4", "4.3", "5", "10", "100"].map((scale) => (
                <option key={scale} value={scale}>{scale}</option>
              ))}
            </select>
            {errors.gpaScale && <p className={errorClass}>{errors.gpaScale}</p>}
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="intendedDegreeLevel">
            Intended degree level *
          </label>
          <select
            id="intendedDegreeLevel"
            className={inputClass}
            value={form.intendedDegreeLevel}
            onChange={(e) => update("intendedDegreeLevel", e.target.value)}
          >
            <option value="">Select…</option>
            {intendedDegreeLevels.map((level) => (
              <option key={level} value={level}>
                {formatLabel(level)}
              </option>
            ))}
          </select>
          {errors.intendedDegreeLevel && (
            <p className={errorClass}>{errors.intendedDegreeLevel}</p>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="fieldOfStudy">
            Intended field of study *
          </label>
          <select
            id="fieldOfStudy"
            className={inputClass}
            value={form.fieldOfStudy ? form.fieldOfStudy : form.fieldCustomMode ? "__custom" : ""}
            onChange={(e) => {
              if (e.target.value === "__custom") {
                update("fieldOfStudy", "");
                update("fieldCustomMode", true);
              } else {
                update("fieldOfStudy", e.target.value);
                update("fieldOfStudyCustom", "");
                update("fieldCustomMode", false);
              }
            }}
          >
            <option value="">Select…</option>
            {COMMON_FIELDS.map((field) => (
              <option key={field} value={field}>{field}</option>
            ))}
            <option value="__custom">Other (type below)…</option>
          </select>
          {form.fieldCustomMode && (
            <input
              id="fieldOfStudyCustom"
              className={`${inputClass} mt-2`}
              placeholder="Type your field, e.g. Supply Chain and Logistics"
              value={form.fieldOfStudyCustom}
              onChange={(e) => update("fieldOfStudyCustom", e.target.value)}
            />
          )}
          {errors.fieldOfStudy && <p className={errorClass}>{errors.fieldOfStudy}</p>}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="languageTest">
              Language test (optional)
            </label>
            <select
              id="languageTest"
              className={inputClass}
              value={form.languageTest}
              onChange={(e) => update("languageTest", e.target.value)}
            >
              <option value="">Select…</option>
              {LANGUAGE_TESTS.map((test) => (
                <option key={test} value={test}>{test}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="languageScore">
              Language score (optional)
            </label>
            <input
              id="languageScore"
              className={inputClass}
              inputMode="decimal"
              placeholder="e.g. 7.0 or 95"
              value={form.languageScore}
              onChange={(e) => update("languageScore", e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="citizenship">
            Citizenship — your passport country *
          </label>
          <select
            id="citizenship"
            className={inputClass}
            value={form.citizenship}
            onChange={(e) => update("citizenship", e.target.value)}
          >
            <option value="">Select…</option>
            {COUNTRIES.map((country) => (
              <option key={country} value={country}>{country}</option>
            ))}
          </select>
          <p className={hintClass}>Used to match scholarships restricted by nationality.</p>
          {errors.citizenship && <p className={errorClass}>{errors.citizenship}</p>}
        </div>

        <div>
          <div>
            <label className={labelClass} htmlFor="preferredDestinations">
              Preferred study destinations (optional)
            </label>
            <select
              id="preferredDestinations"
              className={inputClass}
              value=""
              onChange={(e) => {
                const country = e.target.value;
                if (country && !form.preferredDestinations.includes(country)) {
                  update("preferredDestinations", [...form.preferredDestinations, country]);
                }
              }}
            >
              <option value="">Add a destination…</option>
              {COUNTRIES.filter((country) => !form.preferredDestinations.includes(country)).map((country) => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
            {form.preferredDestinations.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="Selected destinations">
                {form.preferredDestinations.map((country) => (
                  <li
                    key={country}
                    className="inline-flex items-center gap-1 rounded-full border border-[#c9d4ea] bg-[#eef2fb] px-3 py-1 text-sm text-[#14213d]"
                  >
                    {country}
                    <button
                      type="button"
                      aria-label={`Remove ${country}`}
                      onClick={() =>
                        update(
                          "preferredDestinations",
                          form.preferredDestinations.filter((item) => item !== country),
                        )
                      }
                      className="rounded-full px-1 font-bold hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className={hintClass}>Choose from the dropdown; remove with ×. Leave empty if you have no preference.</p>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="personalBudgetAmount">
              Personal budget amount (optional)
            </label>
            <input
              id="personalBudgetAmount"
              className={inputClass}
              inputMode="decimal"
              placeholder="Leave empty if unknown"
              value={form.personalBudgetAmount}
              onChange={(e) => update("personalBudgetAmount", e.target.value)}
            />
            {errors.personalBudgetAmount && (
              <p className={errorClass}>{errors.personalBudgetAmount}</p>
            )}
            <p className={hintClass}>Empty means unknown, never treated as 0.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="personalBudgetCurrency">
              Budget currency (optional)
            </label>
            <select
              id="personalBudgetCurrency"
              className={inputClass}
              value={form.personalBudgetCurrency}
              onChange={(e) => update("personalBudgetCurrency", e.target.value)}
            >
              <option value="">Select…</option>
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>{currency}</option>
              ))}
            </select>
            {errors.personalBudgetCurrency && (
              <p className={errorClass}>{errors.personalBudgetCurrency}</p>
            )}
          </div>
        </div>

        {errors.form && <p className={errorClass}>{errors.form}</p>}

        <button
          type="submit"
          className="inline-flex h-12 items-center justify-center rounded-full bg-zinc-900 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Save profile
        </button>
      </form>

      {saved && (
        <section className="mt-10 rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950">
          <h2 className="font-semibold text-emerald-900 dark:text-emerald-100">
            Profile saved for this browser
          </h2>
          <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
            Your profile validates and can be edited and re-saved. Continue to
            discovery to search for scholarships with it.
          </p>
          <Link
            href="/opportunities"
            className="mt-4 inline-flex h-11 items-center rounded-full bg-emerald-800 px-5 font-medium text-white hover:bg-emerald-700"
          >
            Find my scholarships
          </Link>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-white/70 p-4 text-xs text-zinc-800 dark:bg-black/30 dark:text-zinc-200">
            {JSON.stringify(saved, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}
