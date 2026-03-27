export function formatCurrency(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;

  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

export function formatCompactCurrency(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;

  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(date);
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) {
    return "Unknown";
  }

  const timestamp = new Date(value).getTime();

  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  for (const [unit, unitSeconds] of ranges) {
    if (Math.abs(diffSeconds) >= unitSeconds || unit === "minute") {
      return formatter.format(Math.round(diffSeconds / unitSeconds), unit);
    }
  }

  return formatter.format(diffSeconds, "second");
}