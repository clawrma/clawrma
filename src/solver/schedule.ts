import { ALWAYS_ON_SCHEDULE_WINDOW, SCHEDULE_PRESETS } from "../constants.js";
import type {
  SchedulePreset,
  ScheduleWindow,
  SolverSchedule,
} from "../types.js";

const DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Evaluates whether the solver schedule is active at the given time.
 */
export function isInScheduleWindow(
  schedule: SolverSchedule,
  now: Date = new Date(),
): boolean {
  if (!Array.isArray(schedule.windows) || schedule.windows.length === 0) {
    return false;
  }

  const parts = getZonedDateParts(now, schedule.timezone);
  if (!parts) {
    return false;
  }

  const minuteOfDay = parts.hour * 60 + parts.minute;
  const previousDay = (((parts.dayIndex + 6) % 7) + 7) % 7;

  for (const window of schedule.windows) {
    const bounds = parseWindowBounds(window);
    if (!bounds) {
      continue;
    }

    const normalizedDays = window.days
      .map((day) => normalizeDay(day))
      .filter((day): day is string => Boolean(day));
    if (normalizedDays.length === 0) {
      continue;
    }

    const includesCurrentDay = normalizedDays.some(
      (day) => DAY_INDEX[day] === parts.dayIndex,
    );
    const includesPreviousDay = normalizedDays.some(
      (day) => DAY_INDEX[day] === previousDay,
    );

    if (bounds.start === bounds.end) {
      if (includesCurrentDay) {
        return true;
      }
      continue;
    }

    if (bounds.start < bounds.end) {
      if (
        includesCurrentDay &&
        minuteOfDay >= bounds.start &&
        minuteOfDay < bounds.end
      ) {
        return true;
      }
      continue;
    }

    if (includesCurrentDay && minuteOfDay >= bounds.start) {
      return true;
    }
    if (includesPreviousDay && minuteOfDay < bounds.end) {
      return true;
    }
  }

  return false;
}

/**
 * Parses a schedule preset, falling back when the input is blank.
 */
export function parseSchedulePreset(
  value: string,
  fallback: SchedulePreset,
): SchedulePreset {
  const normalized = value.trim();
  if (!normalized) {
    return fallback;
  }

  if ((SCHEDULE_PRESETS as readonly string[]).includes(normalized)) {
    return normalized as SchedulePreset;
  }

  throw new Error(
    `Invalid schedule preset '${value}'. Expected one of: ${SCHEDULE_PRESETS.join(", ")}.`,
  );
}

/**
 * Builds a concrete schedule from a preset and the existing schedule state.
 */
export function buildScheduleForPreset(
  preset: SchedulePreset,
  existing: SolverSchedule,
): SolverSchedule {
  const timezone =
    existing.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  if (preset === "off") {
    return {
      preset,
      source: "manual",
      timezone,
      windows: [],
    };
  }

  if (preset === "idle-always") {
    return {
      preset,
      source: "manual",
      timezone,
      windows: [{ ...ALWAYS_ON_SCHEDULE_WINDOW }],
    };
  }

  if (preset === "overnight") {
    return {
      preset,
      source: "manual",
      timezone,
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "06:00",
        },
      ],
    };
  }

  return {
    ...existing,
    preset,
    source: preset === "outside-active-hours" ? existing.source : "manual",
    timezone,
    windows: existing.windows,
  };
}

/**
 * Parses a CSV list of days, normalizing values and applying the fallback when blank.
 */
export function parseDayList(input: string, fallback: string[]): string[] {
  if (!input.trim()) {
    return fallback
      .map((day) => normalizeDay(day))
      .filter((day): day is string => Boolean(day));
  }

  const parsed = input
    .split(",")
    .map((entry) => normalizeDay(entry))
    .filter((entry): entry is string => Boolean(entry));

  if (parsed.length === 0) {
    throw new Error(
      "Custom schedule days must include at least one valid day (mon..sun).",
    );
  }

  return Array.from(new Set(parsed));
}

/**
 * Validates and normalizes a clock-time input.
 */
export function validateClockTime(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error("Clock time cannot be empty.");
  }
  if (parseClockMinutes(value) === null) {
    throw new Error(
      `Invalid clock time '${input}'. Expected HH:MM in 24-hour format.`,
    );
  }
  return value;
}

/**
 * Reads weekday and clock parts for a date in the requested timezone.
 */
export function getZonedDateParts(
  date: Date,
  timezone: string,
): { weekday: string; dayIndex: number; hour: number; minute: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const weekday =
      parts.find((part) => part.type === "weekday")?.value.toLowerCase() ?? "";
    const hourRaw = parts.find((part) => part.type === "hour")?.value ?? "";
    const minuteRaw = parts.find((part) => part.type === "minute")?.value ?? "";

    const day = normalizeDay(weekday);
    if (!day) {
      return null;
    }

    const dayIndex = DAY_INDEX[day];
    const parsedHour = Number.parseInt(hourRaw, 10);
    const minute = Number.parseInt(minuteRaw, 10);
    const hour = parsedHour === 24 ? 0 : parsedHour;
    if (
      dayIndex === undefined ||
      !Number.isInteger(dayIndex) ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute)
    ) {
      return null;
    }

    return { weekday, dayIndex, hour, minute };
  } catch {
    return null;
  }
}

/**
 * Converts a schedule window into minute-based bounds.
 */
export function parseWindowBounds(
  window: ScheduleWindow,
): { start: number; end: number } | null {
  const start = parseClockMinutes(window.start);
  const end = parseClockMinutes(window.end);
  if (start === null || end === null) {
    return null;
  }

  return { start, end };
}

/**
 * Parses a HH:MM clock string into minutes since midnight.
 */
export function parseClockMinutes(value: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    return null;
  }

  const [hoursRaw, minutesRaw] = value.split(":");
  if (!hoursRaw || !minutesRaw) {
    return null;
  }

  const hours = Number.parseInt(hoursRaw, 10);
  const minutes = Number.parseInt(minutesRaw, 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

/**
 * Normalizes a day token to the internal three-letter lowercase format.
 */
export function normalizeDay(value: string): string | null {
  const normalized = value.trim().toLowerCase().slice(0, 3);
  return normalized in DAY_INDEX ? normalized : null;
}
