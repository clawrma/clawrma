import { describe, expect, it } from "vitest";
import type { SolverSchedule } from "../types.js";
import {
  isInScheduleWindow,
  normalizeDay,
  parseClockMinutes,
  validateClockTime,
} from "./schedule.js";

function overnightSchedule(): SolverSchedule {
  return {
    preset: "overnight",
    source: "manual",
    timezone: "UTC",
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "00:00",
        end: "06:00",
      },
    ],
  };
}

describe("solver schedule evaluation", () => {
  it("handles midnight-crossing windows with day matching", () => {
    const schedule: SolverSchedule = {
      preset: "custom",
      source: "manual",
      timezone: "UTC",
      windows: [{ days: ["mon"], start: "22:00", end: "08:00" }],
    };

    expect(
      isInScheduleWindow(schedule, new Date("2026-02-23T23:00:00.000Z")),
    ).toBe(true);
    expect(
      isInScheduleWindow(schedule, new Date("2026-02-23T09:00:00.000Z")),
    ).toBe(false);
    expect(
      isInScheduleWindow(schedule, new Date("2026-02-24T03:00:00.000Z")),
    ).toBe(true);
    expect(
      isInScheduleWindow(
        overnightSchedule(),
        new Date("2026-02-23T00:05:00.000Z"),
      ),
    ).toBe(true);
  });

  it("evaluates windows in the configured timezone", () => {
    const schedule: SolverSchedule = {
      preset: "custom",
      source: "manual",
      timezone: "America/New_York",
      windows: [{ days: ["mon"], start: "09:00", end: "17:00" }],
    };

    expect(
      isInScheduleWindow(schedule, new Date("2026-02-23T15:00:00.000Z")),
    ).toBe(true);
    expect(
      isInScheduleWindow(schedule, new Date("2026-02-23T23:30:00.000Z")),
    ).toBe(false);
  });

  it("treats invalid timezones as out of schedule", () => {
    const schedule: SolverSchedule = {
      preset: "custom",
      source: "manual",
      timezone: "Mars/Olympus_Mons",
      windows: [{ days: ["mon"], start: "09:00", end: "17:00" }],
    };

    expect(
      isInScheduleWindow(schedule, new Date("2026-02-23T15:00:00.000Z")),
    ).toBe(false);
  });
});

describe("schedule helper normalization", () => {
  it("normalizes valid day names and rejects invalid ones", () => {
    expect(normalizeDay(" Tuesday ")).toBe("tue");
    expect(normalizeDay("noday")).toBeNull();
  });

  it("parses valid clock times and rejects invalid ones", () => {
    expect(parseClockMinutes("09:30")).toBe(570);
    expect(parseClockMinutes("24:00")).toBeNull();
    expect(() => validateClockTime(" 09:30 ")).not.toThrow();
    expect(() => validateClockTime("24:00")).toThrow(
      "Invalid clock time '24:00'. Expected HH:MM in 24-hour format.",
    );
  });
});
