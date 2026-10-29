/**
 * Human-readable labels for internal snake_case enum values.
 *
 * Data values (scholarship names, providers, evidence quotes) keep their
 * original casing. Only our own enum/status labels go through this.
 */

const ACRONYMS: Record<string, string> = {
  gpa: "GPA",
  ielts: "IELTS",
  toefl: "TOEFL",
  phd: "PhD",
  idr: "IDR",
  usd: "USD",
};

export function formatLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return ACRONYMS[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
