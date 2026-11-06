import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { formatDateTime } from "./utils";

describe("formatDateTime", () => {
  // Local construction avoids assuming the test runner's timezone.
  const timestamp = new Date(2026, 8, 7, 13, 2, 54);

  it("preserves minute precision for existing callers", () => {
    expect(formatDateTime(timestamp)).toBe("Sep 7, 2026, 1:02 PM");
  });

  it("distinguishes activity in the same minute when seconds are requested", () => {
    expect(formatDateTime(timestamp, { includeSeconds: true })).toBe(
      "Sep 7, 2026, 1:02:54 PM",
    );
    expect(
      formatDateTime(new Date(2026, 8, 7, 13, 2, 55), { includeSeconds: true }),
    ).toBe("Sep 7, 2026, 1:02:55 PM");
  });

  it("uses Chinese date formatting when the interface language is Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatDateTime(timestamp)).toBe(timestamp.toLocaleString("zh-CN", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }));
    expect(formatDateTime(timestamp, { includeSeconds: true })).toContain("54");
  });

  it("formats serialized server timestamps identically to Date values", () => {
    expect(
      formatDateTime(timestamp.toISOString(), { includeSeconds: true }),
    ).toBe(formatDateTime(timestamp, { includeSeconds: true }));
  });
});
