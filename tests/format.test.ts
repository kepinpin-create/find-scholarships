import { describe, expect, it } from "vitest";
import { formatLabel } from "@/lib/format";

describe("formatLabel", () => {
  it("capitalizes snake_case enum values for display", () => {
    expect(formatLabel("high_school")).toBe("High School");
    expect(formatLabel("gap_year")).toBe("Gap Year");
    expect(formatLabel("bachelor")).toBe("Bachelor");
    expect(formatLabel("one_time")).toBe("One Time");
    expect(formatLabel("partially_supported")).toBe("Partially Supported");
    expect(formatLabel("unknown")).toBe("Unknown");
  });

  it("keeps acronyms uppercase", () => {
    expect(formatLabel("gpa")).toBe("GPA");
  });
});
