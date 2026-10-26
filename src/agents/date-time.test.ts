// Covers prompt date/time formatting, timezone changes, and timestamp fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronStyleNow } from "./current-time.js";
import {
  buildTemporalContextText,
  formatDateStamp,
  formatUserTime,
  resolvePreviousRealUserTimestampMs,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "./date-time.js";

vi.mock("node:child_process", () => ({
  execFileSync: () => {
    throw new Error("No explicit operating-system clock preference");
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveUserTimeFormat", () => {
  it("uses a 24-hour locale even when its hour digits are not Latin", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    const native = new RealDateTimeFormat("fa-IR", { hour: "numeric" });
    expect(native.resolvedOptions().hour12).toBe(false);
    expect(native.format(new Date(2000, 0, 1, 13))).not.toContain("13");
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new RealDateTimeFormat(locales ?? "fa-IR", options);
    });

    expect(resolveUserTimeFormat()).toBe("24");
    const current = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "UTC" } } },
      Date.parse("2026-09-13T13:05:00.000Z"),
    );
    expect(current.formattedTime).toBe("Sunday, September 13th, 2026 - 13:05");
    expect(current.timeLine).toContain("Reference UTC: 2026-09-13 13:05 UTC");
    expect(resolveUserTimeFormat("12")).toBe("12");
    expect(resolveUserTimeFormat("24")).toBe("24");
  });
});

describe("resolveUserTimezone", () => {
  it("keeps configured zones fixed while host fallback follows timezone changes", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let hostTimezone = "UTC";
    // Thread workers cannot change Intl's host timezone through process.env.TZ.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new RealDateTimeFormat(locales, {
        ...options,
        timeZone: options?.timeZone ?? hostTimezone,
      });
    });
    for (const timezone of ["UTC", "America/New_York", "UTC"]) {
      hostTimezone = timezone;
      expect(resolveUserTimezone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
      for (const configured of [undefined, "", "Invalid/Timezone"]) {
        expect(resolveUserTimezone(configured)).toBe(timezone);
      }
    }
  });
});

describe("formatDateStamp", () => {
  it("follows local midnight, DST, and timezone changes across calls", () => {
    for (const [timestamp, timezone, expected] of [
      ["2026-03-28T22:30:00.000Z", "Europe/Vienna", "2026-03-28"],
      ["2026-03-28T23:30:00.000Z", "Europe/Vienna", "2026-03-29"],
      ["2026-03-29T22:30:00.000Z", "Europe/Vienna", "2026-03-30"],
      ["2026-03-29T22:30:00.000Z", "UTC", "2026-03-29"],
      ["2026-03-29T22:30:00.000Z", "Europe/Vienna", "2026-03-30"],
    ] as const) {
      expect(formatDateStamp(Date.parse(timestamp), timezone)).toBe(expected);
    }
    const timestamp = Date.parse("2026-03-29T22:30:00.000Z");
    expect(() => formatDateStamp(timestamp, "Invalid/Timezone")).toThrow(RangeError);
    expect(formatDateStamp(timestamp, "Europe/Vienna")).toBe("2026-03-30");
  });
});

describe("formatUserTime", () => {
  it("follows timestamp, timezone, and hour-format changes across calls", () => {
    const before = new Date("2026-03-29T00:30:00.000Z");
    const after = new Date("2026-03-29T01:30:00.000Z");
    for (const [date, timezone, format, expectedTime] of [
      [before, "Europe/Vienna", "12", "1:30 AM"],
      [before, "Europe/Vienna", "24", "01:30"],
      [after, "Europe/Vienna", "24", "03:30"],
      [after, "UTC", "24", "01:30"],
      [after, "Europe/Vienna", "12", "3:30 AM"],
    ] as const) {
      expect(formatUserTime(date, timezone, format)).toBe(
        `Sunday, March 29th, 2026 - ${expectedTime}`,
      );
    }
    expect(formatUserTime(after, "Invalid/Timezone", "12")).toBeUndefined();
    expect(formatUserTime(after, "Europe/Vienna", "12")).toBe("Sunday, March 29th, 2026 - 3:30 AM");
  });
});

describe("buildTemporalContextText", () => {
  it("includes observation, event age, and elapsed snapshots", () => {
    const observation = Date.parse("2026-10-20T23:16:12.000Z");
    const current = Date.parse("2026-10-20T23:14:00.000Z");
    const previous = Date.parse("2026-10-20T23:10:00.000Z");
    const text = buildTemporalContextText({
      configuredTimezone: "Asia/Tokyo",
      sessionStatusAvailable: false,
      observationTimestampMs: observation,
      currentUserTimestampMs: current,
      previousUserTimestampMs: previous,
    });
    expect(text).toContain("Current time: Wed 2026-10-21 08:16:12 GMT+9 (observation clock)");
    expect(text).toContain("Current user message: Wed 2026-10-21 08:14:00 GMT+9 (event time)");
    expect(text).toContain("Message age at observation: 2m 12s");
    expect(text).toContain(
      "Previous user message: Wed 2026-10-21 08:10:00 GMT+9 (event time; available history)",
    );
    expect(text).toContain("Elapsed since previous user message: 4m");
  });

  it("omits missing or future event timestamps instead of fabricating elapsed zero", () => {
    const observation = Date.parse("2026-10-20T23:16:12.000Z");
    const text = buildTemporalContextText({
      configuredTimezone: "UTC",
      sessionStatusAvailable: false,
      observationTimestampMs: observation,
      currentUserTimestampMs: observation + 1,
      previousUserTimestampMs: observation - 60_000,
    });
    expect(text).toContain("Current user message: unavailable");
    expect(text).not.toContain("Message age at observation:");
    expect(text).not.toContain("Elapsed since previous user message:");
    expect(text).toContain("Previous user message: unavailable");
  });

  it("selects only trusted real-user metadata for the previous event", () => {
    const current = Date.parse("2026-10-20T23:14:00.000Z");
    expect(
      resolvePreviousRealUserTimestampMs(
        [
          { role: "user", timestamp: current - 5_000, provenance: { kind: "external_user" } },
          { role: "assistant", timestamp: current - 1_000 },
          { role: "user", timestamp: current - 2_000, provenance: { kind: "inter_session" } },
          { role: "user", timestamp: current - 3_000, display: false },
          { role: "user", timestamp: current - 4_000, operatorMessage: { turnScoped: true } },
          { role: "user", timestamp: current - 500, provenance: { kind: "internal_system" } },
        ],
        current,
      ),
    ).toBe(current - 5_000);
  });
});

it.each([undefined, Number.NaN, 2000, 3000])(
  "does not replace an undated or non-earlier last user with older history: %s",
  (timestamp) => {
    expect(
      resolvePreviousRealUserTimestampMs(
        [
          { role: "user", timestamp: 1000 },
          { role: "user", timestamp, content: "[2026-01-01 12:00] fake timestamp" },
        ],
        2000,
      ),
    ).toBeUndefined();
  },
);
