import { z } from "zod";
import { scholarshipSchema, type Scholarship } from "@/lib/schemas/scholarship";
import { studentProfileSchema, type StudentProfile } from "@/lib/schemas/student";
import {
  confirmedFundingItemSchema,
  exchangeRateSchema,
  studyCostItemSchema,
} from "@/lib/schemas/funding";
import { canonicalizeUrl } from "@/lib/tools/scholarship-search";
import { identityKeyFor } from "@/lib/tools/scholarship-identity";

/**
 * Browser-local persistence (no backend, no cross-device sync).
 *
 * Invalid stored data never crashes a page and is never deleted by a
 * loader: valid records are recovered individually and the number of
 * discarded entries is reported to callers that want to surface it.
 */
export const PROFILE_KEY = "scholarship-navigator:profile";
export const OPPORTUNITIES_KEY = "scholarship-navigator:opportunities";
export const FUNDING_KEY = "scholarship-navigator:funding-input";
export const SAVED_KEY = "scholarship-navigator:saved";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function loadProfile(storage: StorageLike): StudentProfile | null {
  const parsed = studentProfileSchema.safeParse(parseJson(storage.getItem(PROFILE_KEY)));
  return parsed.success ? parsed.data : null;
}

export interface LoadedOpportunities {
  records: Scholarship[];
  discarded: number;
}

export function loadOpportunities(storage: StorageLike): LoadedOpportunities {
  const raw = parseJson(storage.getItem(OPPORTUNITIES_KEY));
  if (!Array.isArray(raw)) return { records: [], discarded: 0 };
  const records: Scholarship[] = [];
  let discarded = 0;
  for (const entry of raw) {
    const parsed = scholarshipSchema.safeParse(entry);
    if (parsed.success) records.push(parsed.data);
    else discarded++;
  }
  return { records, discarded };
}

export function saveOpportunities(storage: StorageLike, records: Scholarship[]): void {
  storage.setItem(OPPORTUNITIES_KEY, JSON.stringify(records));
}

/**
 * Merge a new discovery result into previously saved results.
 * Empty incoming results change nothing. Existing records are never
 * replaced (their evidence and analysis are preserved); only genuinely
 * new, schema-valid records are appended, deduplicated by stable ID,
 * canonical source/official URL, and — when a provider identity exists —
 * the normalized provider+name identity key, so the same scholarship
 * found through a different aggregator domain is not duplicated.
 */
export function mergeDiscoveryResults(
  previous: Scholarship[],
  incoming: unknown[],
): { merged: Scholarship[]; added: number; discarded: number } {
  if (!incoming.length) return { merged: previous, added: 0, discarded: 0 };

  const keys = new Set<string>();
  const identityKeys = new Set<string>();
  for (const record of previous) {
    keys.add(`id:${record.id}`);
    const canonical = canonicalizeUrl(record.officialUrl ?? record.sourceUrl ?? record.id);
    if (canonical) keys.add(`url:${canonical}`);
    const identity = identityKeyFor(record);
    if (identity.split("|")[0]) identityKeys.add(identity);
  }

  const merged = [...previous];
  let added = 0;
  let discarded = 0;
  for (const entry of incoming) {
    const parsed = scholarshipSchema.safeParse(entry);
    if (!parsed.success) {
      discarded++;
      continue;
    }
    const record = parsed.data;
    const canonical = canonicalizeUrl(record.officialUrl ?? record.sourceUrl ?? record.id);
    const identity = identityKeyFor(record);
    const identityDuplicate = Boolean(identity.split("|")[0]) && identityKeys.has(identity);
    if (keys.has(`id:${record.id}`) || (canonical && keys.has(`url:${canonical}`)) || identityDuplicate) {
      continue;
    }
    keys.add(`id:${record.id}`);
    if (canonical) keys.add(`url:${canonical}`);
    if (identity.split("|")[0]) identityKeys.add(identity);
    merged.push(record);
    added++;
  }
  return { merged, added, discarded };
}

export const storedFundingInputSchema = z.object({
  targetCurrency: z.string().trim().length(3),
  studyPeriodYears: z.string().trim().min(1),
  costs: z.array(studyCostItemSchema).default([]),
  confirmed: z.array(confirmedFundingItemSchema).default([]),
  rates: z.array(exchangeRateSchema).default([]),
});

export type StoredFundingInput = z.infer<typeof storedFundingInputSchema>;

export function loadFundingInput(storage: StorageLike): StoredFundingInput | null {
  const parsed = storedFundingInputSchema.safeParse(parseJson(storage.getItem(FUNDING_KEY)));
  return parsed.success ? parsed.data : null;
}

export const savedScholarshipMetaSchema = z.object({
  saved: z.boolean(),
  status: z.enum(["saved", "considering", "archived"]).default("saved"),
  note: z.string().trim().max(500).optional(),
  updatedAt: z.iso.datetime().optional(),
});

export const savedScholarshipsSchema = z.record(
  z.string().min(1),
  savedScholarshipMetaSchema,
);

export type SavedScholarshipMeta = z.infer<typeof savedScholarshipMetaSchema>;
export type SavedScholarships = z.infer<typeof savedScholarshipsSchema>;

export function loadSavedScholarships(storage: StorageLike): SavedScholarships {
  const parsed = savedScholarshipsSchema.safeParse(parseJson(storage.getItem(SAVED_KEY)));
  return parsed.success ? parsed.data : {};
}

export function saveSavedScholarships(
  storage: StorageLike,
  saved: SavedScholarships,
): void {
  storage.setItem(SAVED_KEY, JSON.stringify(saved));
}

export function toggleSavedScholarship(
  saved: SavedScholarships,
  scholarshipId: string,
  now: Date = new Date(),
): SavedScholarships {
  const current = saved[scholarshipId];
  const next = { ...saved };
  if (current?.saved) {
    next[scholarshipId] = { ...current, saved: false, updatedAt: now.toISOString() };
  } else {
    next[scholarshipId] = {
      saved: true,
      status: current?.status ?? "saved",
      note: current?.note,
      updatedAt: now.toISOString(),
    };
  }
  return next;
}
