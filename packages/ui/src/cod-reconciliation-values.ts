// Local COD presentation only: never infer collection from shipment state.
const currencies = new Set(Intl.supportedValuesOf("currency"));
const maximumMinor = BigInt(Number.MAX_SAFE_INTEGER);
export type CodAmounts = {
  currency: string | null;
  expected: bigint | null;
  collected: bigint | null;
  variance: bigint | null;
  state: "unknown" | "invalid" | "collected" | "refused";
};

function currencyCode(value: unknown): string | null {
  return typeof value === "string" && currencies.has(value) ? value : null;
}

function minorUnits(value: unknown, currency: string): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || text.length > 40) return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) return null;
  if (typeof value === "number" && Math.abs(value) * Number.EPSILON * 10 ** digits >= 0.5) return null;
  const fraction = match[3] ?? "";
  // Extra zero precision is lossless; any nonzero sub-minor fraction is not.
  if (/[1-9]/.test(fraction.slice(digits))) return null;
  const minor = BigInt((match[2] ?? "0") + fraction.slice(0, digits).padEnd(digits, "0")) * (match[1] ? -1n : 1n);
  return minor > maximumMinor || minor < -maximumMinor ? null : minor;
}

export function readCodAmounts(row: Record<string, unknown>): CodAmounts {
  const invalid: CodAmounts = { currency: null, expected: null, collected: null, variance: null, state: "invalid" };
  if (row.payment_collection_present === false && row.payment_collection == null) {
    const currency = currencyCode(row.original_cod_currency);
    const expected = currency ? minorUnits(row.original_cod_amount, currency) : null;
    return { ...invalid, currency, expected: expected !== null && expected >= 0n ? expected : null, state: "unknown" };
  }
  if (row.payment_collection_present !== true || !row.payment_collection || typeof row.payment_collection !== "object" || Array.isArray(row.payment_collection)) return invalid;
  const snapshot = row.payment_collection as Record<string, unknown>;
  const currency = currencyCode(snapshot.currency);
  if (!currency) return invalid;
  const expected = minorUnits(snapshot.expected_amount, currency);
  const collected = minorUnits(snapshot.collected_amount, currency);
  const variance = minorUnits(snapshot.variance_amount, currency);
  if (expected === null || collected === null || variance === null ||
      expected <= 0n || collected < 0n || expected - collected !== variance ||
      (snapshot.outcome !== "collected" && snapshot.outcome !== "refused") ||
      (snapshot.outcome === "refused" && collected !== 0n) ||
      (snapshot.outcome === "collected" && collected <= 0n)) return { ...invalid, currency };
  return { currency, expected, collected, variance, state: snapshot.outcome };
}

// Exact decimal text avoids Intl/Number silently rounding a safe integer's major-unit conversion.
export function formatCodMinor(value: bigint | null, currency: string | null): string | null {
  if (value === null || !currency) return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) return null;
  const absolute = (value < 0n ? -value : value).toString().padStart(digits + 1, "0");
  const amount = digits ? absolute.slice(0, -digits) + "." + absolute.slice(-digits) : absolute;
  return (value < 0n ? "-" : "") + amount + " " + currency;
}

export function totalCodAmounts(rows: CodAmounts[]) {
  const groups = new Map<string, { currency: string; expected: bigint | null; collected: bigint | null; variance: bigint | null }>();
  const keys = ["expected", "collected", "variance"] as const;
  for (const row of rows) {
    if (!row.currency) continue;
    const group = groups.get(row.currency) ?? { currency: row.currency, expected: 0n, collected: 0n, variance: 0n };
    for (const key of keys) {
      const current = group[key];
      const value = row[key];
      const sum = current === null || value === null ? null : current + value;
      group[key] = sum === null || sum > maximumMinor || sum < -maximumMinor ? null : sum;
    }
    groups.set(row.currency, group);
  }
  return { groups: [...groups.values()], unassigned: rows.some((row) => row.currency === null) };
}
