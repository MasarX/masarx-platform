import {
  mapFieldopsWalletEnvelope,
  mobileV2CashDropMatchesWrite,
  mobileV2WalletWithdrawalMatchesWrite,
  type MobileV2WalletEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

const FALLBACK: MobileV2WalletEnvelope = Object.freeze({
  wallet: Object.freeze({
    balanceSar: 184,
    weekToDateSar: 412,
    postsToBankLabel: "Posts to bank Monday",
  }),
  week: Object.freeze([]),
  breakdown: Object.freeze([]),
  latestWithdrawal: null,
});

describe("mapFieldopsWalletEnvelope", () => {
  test("maps latest_withdrawal into the Mobile V2 same-screen readback contract", () => {
    const envelope = mapFieldopsWalletEnvelope(
      {
        wallet: {
          balance_sar: "0",
          week_to_date_sar: 0,
          posts_to_bank_label: "Posts to bank Sunday",
        },
        week: [],
        breakdown: [],
        latest_withdrawal: {
          decision_log_id: "00000000-1111-4222-8333-444444444444",
          request_id: "55555555-6666-4777-8888-999999999999",
          state: "requested",
          amount_sar: "75",
          requested_at: "2026-05-27T12:34:00Z",
        },
      },
      FALLBACK,
    );

    expect(envelope.wallet).toEqual({
      balanceSar: 0,
      weekToDateSar: 0,
      postsToBankLabel: "Posts to bank Sunday",
    });
    expect(envelope.latestWithdrawal).toEqual({
      decisionLogId: "00000000-1111-4222-8333-444444444444",
      requestId: "55555555-6666-4777-8888-999999999999",
      state: "requested",
      amountSar: 75,
      requestedAt: "2026-05-27T12:34:00Z",
    });
  });

  test("does not replace malformed live withdrawal readback with fixture business data", () => {
    const envelope = mapFieldopsWalletEnvelope(
      {
        wallet: {
          balance_sar: null,
          week_to_date_sar: "bad",
          posts_to_bank_label: "",
        },
        latest_withdrawal: {
          state: "requested",
          amount_sar: 75,
        },
      },
      FALLBACK,
    );

    expect(envelope.wallet).toEqual(FALLBACK.wallet);
    expect(envelope.latestWithdrawal).toBeNull();
  });
});

describe("Mobile V2 same-context money readback guards", () => {
  test("accepts wallet success only when resolver readback matches the write decision and amount", () => {
    const write = {
      ok: true as const,
      state: "requested",
      decision_log_id: "00000000-1111-4222-8333-444444444444",
      request_id: "55555555-6666-4777-8888-999999999999",
    };

    expect(
      mobileV2WalletWithdrawalMatchesWrite(
        {
          decisionLogId: "00000000-1111-4222-8333-444444444444",
          requestId: "55555555-6666-4777-8888-999999999999",
          state: "requested",
          amountSar: 75,
          requestedAt: "2026-05-27T12:34:00Z",
        },
        write,
        75,
      ),
    ).toBe(true);

    expect(
      mobileV2WalletWithdrawalMatchesWrite(
        {
          decisionLogId: "00000000-1111-4222-8333-444444444444",
          requestId: "55555555-6666-4777-8888-999999999999",
          state: "requested",
          amountSar: 74,
          requestedAt: "2026-05-27T12:34:00Z",
        },
        write,
        75,
      ),
    ).toBe(false);
  });

  test("accepts COD handoff success only when resolver readback matches the write decision and amounts", () => {
    const write = {
      ok: true as const,
      state: "balanced",
      decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };

    expect(
      mobileV2CashDropMatchesWrite(
        {
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          state: "balanced",
          expectedSar: 137,
          actualSar: 137,
          varianceSar: 0,
          submittedAt: "2026-05-27T12:34:00Z",
          supervisorName: null,
        },
        write,
        137,
        137,
      ),
    ).toBe(true);

    expect(
      mobileV2CashDropMatchesWrite(
        {
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          state: "balanced",
          expectedSar: 137,
          actualSar: 136,
          varianceSar: -1,
          submittedAt: "2026-05-27T12:34:00Z",
          supervisorName: null,
        },
        write,
        137,
        137,
      ),
    ).toBe(false);
  });
});
