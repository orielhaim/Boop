import type { AppLanguage } from "./index";

const dateTimes = new Map<string, Intl.DateTimeFormat>();

export function formatDateTime(
  value: number | Date,
  language: AppLanguage,
  hour12?: boolean,
  seconds = false,
) {
  const key = `${language}:${hour12}:${seconds}`;
  let formatter = dateTimes.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: seconds ? "medium" : "short",
      hour12,
    });
    dateTimes.set(key, formatter);
  }
  return formatter.format(value);
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remaining = total % 60;

  const parts = hours > 0 ? [hours, minutes, remaining] : [minutes, remaining];

  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export function isolateText(value: string) {
  return `\u2068${value}\u2069`;
}

const byteFormatters = new Map<string, Intl.NumberFormat>();

export function formatBytes(bytes: number, locale: string) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log10(Math.max(1, bytes)) / 3),
  );
  const key = `${locale}:${index}`;
  let formatter = byteFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: "unit",
      unit: units[index],
      maximumFractionDigits: index === 0 ? 0 : 1,
    });
    byteFormatters.set(key, formatter);
  }
  return formatter.format(bytes / 1000 ** index);
}
