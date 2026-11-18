/** Verify branded empty-state copy, dead-entry detection and bounded outbox diagnostics. */

import * as fs from "fs";
import * as path from "path";

import {
  IDEMPOTENCY_KEY_TAIL_LENGTH,
  LAST_ERROR_TRUNCATE_LENGTH,
  OUTBOX_EMPTY_STATE_DESCRIPTION,
  OUTBOX_EMPTY_STATE_TITLE,
  deriveEntryDiagnostics,
  hasDeadEntries,
  shortIdempotencyKey,
  truncateError,
} from "../../apps/fieldops/src/screens/outbox-screen-helpers";

const NOW = Date.parse("2026-04-23T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("OutboxScreen — branded empty-state copy", () => {
  test("title and description are short, branded, and human-readable", () => {
    expect(OUTBOX_EMPTY_STATE_TITLE).toBe("All caught up");
    expect(OUTBOX_EMPTY_STATE_DESCRIPTION).toBe(
      "Actions you take offline appear here until synced."
    );
    expect(OUTBOX_EMPTY_STATE_TITLE.length).toBeLessThanOrEqual(40);
    expect(OUTBOX_EMPTY_STATE_DESCRIPTION.length).toBeLessThanOrEqual(120);
  });

  test("OutboxScreen.tsx wires the branded copy through <EmptyState />", () => {
    const screenSrc = fs.readFileSync(
      path.resolve(__dirname, "../../apps/fieldops/src/screens/OutboxScreen.tsx"),
      "utf8"
    );
    expect(screenSrc).toMatch(/<EmptyState\b/);
    expect(screenSrc).toContain("OUTBOX_EMPTY_STATE_TITLE");
    expect(screenSrc).toContain("OUTBOX_EMPTY_STATE_DESCRIPTION");
    expect(screenSrc).toContain('testID="mobile-outbox-empty-state"');
    // Regression guard: the prior plain `<Text>{i18nStrings.outbox.empty}</Text>`
    // empty fallback must be gone.
    expect(screenSrc).not.toMatch(/i18nStrings\.outbox\.empty\s*\}/);
  });
});

describe("hasDeadEntries — Clear-dead button gating", () => {
  test("returns false for an empty list", () => {
    expect(hasDeadEntries([])).toBe(false);
  });

  test("returns false when no entry has status 'dead'", () => {
    expect(
      hasDeadEntries([
        { status: "queued" },
        { status: "in_flight" },
        { status: "failed" },
      ])
    ).toBe(false);
  });

  test("returns true when at least one entry has status 'dead'", () => {
    expect(
      hasDeadEntries([
        { status: "queued" },
        { status: "dead" },
        { status: "failed" },
      ])
    ).toBe(true);
  });

  test("tolerates null / undefined / non-array input (defensive)", () => {
    expect(hasDeadEntries(null)).toBe(false);
    expect(hasDeadEntries(undefined)).toBe(false);
    expect(hasDeadEntries("not-an-array" as unknown as never)).toBe(false);
  });

  test("ignores entries with missing/invalid status field", () => {
    expect(
      hasDeadEntries([
        { status: null },
        { status: undefined },
        {} as { status?: string },
      ])
    ).toBe(false);
  });

  test("OutboxScreen.tsx renders Clear-dead conditionally on showClearDead", () => {
    const screenSrc = fs.readFileSync(
      path.resolve(__dirname, "../../apps/fieldops/src/screens/OutboxScreen.tsx"),
      "utf8"
    );
    expect(screenSrc).toContain("hasDeadEntries(entries)");
    // Conditional render guard around the Clear-dead Pressable.
    expect(screenSrc).toMatch(/\{showClearDead\s*\?[\s\S]*Clear dead[\s\S]*:\s*null\}/);
  });
});

describe("shortIdempotencyKey — last 8 chars", () => {
  test("returns the last 8 chars when the key is long enough", () => {
    expect(shortIdempotencyKey("abcdefghijklmno0123456789")).toBe("23456789");
    expect(shortIdempotencyKey("abcdefghijklmno0123456789")).toHaveLength(
      IDEMPOTENCY_KEY_TAIL_LENGTH
    );
  });

  test("returns the full string when shorter than the tail length", () => {
    expect(shortIdempotencyKey("abc")).toBe("abc");
    expect(shortIdempotencyKey("abcdefgh")).toBe("abcdefgh");
  });

  test("returns null for empty / non-string input", () => {
    expect(shortIdempotencyKey("")).toBeNull();
    expect(shortIdempotencyKey("   ")).toBeNull();
    expect(shortIdempotencyKey(null)).toBeNull();
    expect(shortIdempotencyKey(undefined)).toBeNull();
    expect(shortIdempotencyKey(12345 as unknown as string)).toBeNull();
  });
});

describe("truncateError — bounded last-error preview", () => {
  test("returns the full string when shorter than the limit", () => {
    expect(truncateError("connection refused")).toBe("connection refused");
  });

  test("truncates to the configured limit with ellipsis", () => {
    const longError = "x".repeat(LAST_ERROR_TRUNCATE_LENGTH + 50);
    const truncated = truncateError(longError);
    expect(truncated).not.toBeNull();
    expect((truncated ?? "").length).toBe(LAST_ERROR_TRUNCATE_LENGTH);
    expect(truncated?.endsWith("\u2026")).toBe(true);
  });

  test("returns null for empty / non-string input", () => {
    expect(truncateError("")).toBeNull();
    expect(truncateError("   ")).toBeNull();
    expect(truncateError(null)).toBeNull();
    expect(truncateError(undefined)).toBeNull();
  });
});

describe("deriveEntryDiagnostics — full per-entry surface", () => {
  test("derives all four diagnostic fields when fully populated", () => {
    const entry = {
      id: "row-1",
      idempotency_key: "iddqd-2026-04-23-abcdef0123456789",
      attempt_count: 3,
      created_at: new Date(NOW - 17 * MINUTE).toISOString(),
      last_error: "RPC timed out after 3 attempts",
    };
    const diagnostics = deriveEntryDiagnostics(entry, NOW);
    expect(diagnostics.idempotencyKeyShort).toBe("23456789");
    expect(diagnostics.idempotencyKeyShort).toHaveLength(
      IDEMPOTENCY_KEY_TAIL_LENGTH
    );
    expect(diagnostics.attemptCount).toBe(3);
    expect(diagnostics.createdAtRelative).toBe("17m ago");
    expect(diagnostics.lastErrorTruncated).toBe(
      "RPC timed out after 3 attempts"
    );
    expect(diagnostics.rowKey).toBe(diagnostics.idempotencyKeyShort);
  });

  test("falls back to entry.id as the rowKey when no idempotency_key is set", () => {
    const diagnostics = deriveEntryDiagnostics(
      {
        id: "row-2",
        idempotency_key: null,
        attempt_count: 0,
        created_at: NOW,
        last_error: null,
      },
      NOW
    );
    expect(diagnostics.idempotencyKeyShort).toBeNull();
    expect(diagnostics.rowKey).toBe("row-2");
    expect(diagnostics.lastErrorTruncated).toBeNull();
    expect(diagnostics.createdAtRelative).toBe("just now");
  });

  test("formats relative time across minute / hour / day boundaries", () => {
    expect(
      deriveEntryDiagnostics(
        { id: "a", created_at: NOW - 30 * MINUTE },
        NOW
      ).createdAtRelative
    ).toBe("30m ago");
    expect(
      deriveEntryDiagnostics(
        { id: "b", created_at: NOW - 2 * HOUR },
        NOW
      ).createdAtRelative
    ).toBe("2h ago");
    expect(
      deriveEntryDiagnostics(
        { id: "c", created_at: NOW - 3 * DAY },
        NOW
      ).createdAtRelative
    ).toBe("3d ago");
  });

  test("normalizes invalid attempt_count values to 0", () => {
    expect(
      deriveEntryDiagnostics({ id: "a", attempt_count: -7 }, NOW).attemptCount
    ).toBe(0);
    expect(
      deriveEntryDiagnostics({ id: "b", attempt_count: Number.NaN }, NOW)
        .attemptCount
    ).toBe(0);
    expect(
      deriveEntryDiagnostics({ id: "c", attempt_count: 4.7 }, NOW).attemptCount
    ).toBe(4);
  });

  test("returns null createdAtRelative when created_at is unparseable", () => {
    expect(
      deriveEntryDiagnostics({ id: "a", created_at: "not-a-date" }, NOW)
        .createdAtRelative
    ).toBeNull();
    expect(
      deriveEntryDiagnostics({ id: "b", created_at: null }, NOW)
        .createdAtRelative
    ).toBeNull();
  });

  test("truncates very long last_error to the configured limit", () => {
    const longError = "boom! ".repeat(40);
    const diagnostics = deriveEntryDiagnostics(
      { id: "a", last_error: longError },
      NOW
    );
    expect(diagnostics.lastErrorTruncated).not.toBeNull();
    expect((diagnostics.lastErrorTruncated ?? "").length).toBe(
      LAST_ERROR_TRUNCATE_LENGTH
    );
  });
});
