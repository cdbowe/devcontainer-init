import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface TimezoneInfo {
  /** IANA zone id, e.g. "America/New_York". */
  id: string;
  /** tzdata abbreviation for the current instant, e.g. "EDT". */
  abbreviation: string;
  /** UTC offset for the current instant, always `(+|-)\d\d:\d\d`. */
  offset: string;
}

/**
 * Zones offered before the full IANA list, chosen to cover the offsets most
 * users land on. The detected host zone is prepended separately.
 */
const COMMON_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** True when the runtime accepts the id as an IANA zone (aliases included). */
export function isValidTimezone(id: string): boolean {
  if (!id.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every zone the runtime knows about. `supportedValuesOf` returns canonical
 * ids only, so legacy aliases (US/Pacific, Asia/Calcutta) are absent from the
 * picker but still accepted by --timezone.
 */
export function listTimezones(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return [...COMMON_ZONES];
  }
}

export function commonTimezones(): string[] {
  return COMMON_ZONES.filter(isValidTimezone);
}

function intlPart(id: string, style: "short" | "longOffset"): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: id,
      timeZoneName: style,
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/** "GMT-04:00" -> "-04:00"; bare "GMT" (i.e. UTC) -> "+00:00". */
function offsetFor(id: string): string {
  const raw = intlPart(id, "longOffset");
  if (raw) {
    if (raw === "GMT" || raw === "UTC") return "+00:00";
    const match = raw.match(/([+-])(\d{1,2}):?(\d{2})/);
    if (match) {
      const [, sign, hours, minutes] = match;
      return `${sign}${hours.padStart(2, "0")}:${minutes}`;
    }
  }
  return "+00:00";
}

/**
 * Ask tzdata for the real abbreviations in a single shell round-trip. One
 * `date` call per zone would be ~400 forks spread over as many execs; batching
 * keeps it to one. Returns an empty map on non-POSIX hosts or when tzdata is
 * missing, and callers fall back to `intlAbbreviation`.
 */
function tzdataAbbreviations(ids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;

  try {
    const output = execFileSync(
      "bash",
      [
        "-c",
        'while IFS= read -r zone; do printf "%s\\t%s\\n" "$zone" "$(TZ="$zone" date +%Z)"; done',
      ],
      {
        input: ids.join("\n") + "\n",
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "ignore"],
      }
    );

    for (const line of output.split("\n")) {
      const [zone, abbr] = line.split("\t");
      if (zone && abbr) result.set(zone, abbr.trim());
    }
  } catch {
    // No bash, no tzdata, or the loop timed out — fall back per zone.
  }

  return result;
}

/**
 * Intl only carries letter abbreviations for a handful of (mostly US) zones;
 * everywhere else it yields "GMT+5:30". Normalize that to "UTC+05:30" so the
 * label still reads as an abbreviation rather than a half-formatted offset.
 */
function intlAbbreviation(id: string, offset: string): string {
  const short = intlPart(id, "short");
  if (short && /^[A-Za-z]+$/.test(short)) return short;
  return offset === "+00:00" ? "UTC" : `UTC${offset}`;
}

/**
 * Resolve display metadata for many zones at once. Prefer this over repeated
 * `describeTimezone` calls — it batches the tzdata lookup.
 */
export function describeTimezones(ids: string[]): TimezoneInfo[] {
  const abbreviations = tzdataAbbreviations(ids);

  return ids.map((id) => {
    const offset = offsetFor(id);
    const fromTzdata = abbreviations.get(id);
    return {
      id,
      abbreviation: fromTzdata || intlAbbreviation(id, offset),
      offset,
    };
  });
}

export function describeTimezone(id: string): TimezoneInfo {
  return describeTimezones([id])[0];
}

/** "America/New_York (EDT, -04:00)" */
export function formatTimezone(info: TimezoneInfo): string {
  return `${info.id} (${info.abbreviation}, ${info.offset})`;
}

export interface DetectedTimezone {
  id: string;
  /** Where the value came from, for reporting when the guess may be wrong. */
  source: "TZ env" | "/etc/timezone" | "/etc/localtime" | "runtime" | "fallback";
}

/**
 * Best-effort guess at the machine's zone, used to preselect the wizard's
 * default. Note this reads the machine devcontainer-init runs on: when the
 * tool itself runs inside a container, that's the container's zone (usually
 * UTC), not the Docker host's. `--timezone` exists for that case.
 */
export function detectHostTimezone(): DetectedTimezone {
  const fromEnv = process.env.TZ?.trim();
  if (fromEnv && isValidTimezone(fromEnv)) {
    return { id: fromEnv, source: "TZ env" };
  }

  try {
    const fromFile = readFileSync("/etc/timezone", "utf-8").trim();
    if (fromFile && isValidTimezone(fromFile)) {
      return { id: fromFile, source: "/etc/timezone" };
    }
  } catch {
    // Not a Debian-family host, or the file isn't readable.
  }

  try {
    // e.g. /usr/share/zoneinfo/America/New_York -> America/New_York
    const link = readlinkSync("/etc/localtime");
    const match = link.match(/zoneinfo\/(.+)$/);
    if (match && isValidTimezone(match[1])) {
      return { id: match[1], source: "/etc/localtime" };
    }
  } catch {
    // Not a symlink (or not POSIX).
  }

  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && isValidTimezone(resolved)) {
      return { id: resolved, source: "runtime" };
    }
  } catch {
    // ICU without zone data.
  }

  return { id: "UTC", source: "fallback" };
}
