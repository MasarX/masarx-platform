import {
  POD_POLICY_LOADING_MESSAGE,
  POD_POLICY_UNAVAILABLE_MESSAGE,
  resolveComposerPodPolicyState,
  resolveComposerSignatureRequired,
} from "../../../apps/fieldops/src/mobile-composer-pod";

describe("fieldops mobile composer pod state", () => {
  test("does not block submission when proof policy is ready", () => {
    expect(
      resolveComposerPodPolicyState({
        supportsPod: true,
        hasPolicy: true,
        isLoading: false,
        isError: false,
      })
    ).toEqual({
      pending: false,
      unavailable: false,
      submitDisabled: false,
      blockingMessage: null,
    });
  });

  test("blocks submission while proof policy is loading", () => {
    expect(
      resolveComposerPodPolicyState({
        supportsPod: true,
        hasPolicy: false,
        isLoading: true,
        isError: false,
      })
    ).toEqual({
      pending: true,
      unavailable: false,
      submitDisabled: true,
      blockingMessage: POD_POLICY_LOADING_MESSAGE,
    });
  });

  test("blocks submission when proof policy is unavailable", () => {
    expect(
      resolveComposerPodPolicyState({
        supportsPod: true,
        hasPolicy: false,
        isLoading: false,
        isError: false,
      })
    ).toEqual({
      pending: false,
      unavailable: true,
      submitDisabled: true,
      blockingMessage: POD_POLICY_UNAVAILABLE_MESSAGE,
    });
  });

  test("ignores proof policy state for commands that do not require POD", () => {
    expect(
      resolveComposerPodPolicyState({
        supportsPod: false,
        hasPolicy: false,
        isLoading: true,
        isError: true,
      })
    ).toEqual({
      pending: false,
      unavailable: false,
      submitDisabled: false,
      blockingMessage: null,
    });
  });

  test("requires signature when pod policy marks it mandatory", () => {
    expect(
      resolveComposerSignatureRequired({
        podRequirements: {
          signature_required: true,
        },
        handoverMode: "mailroom",
        handoverModes: [],
      })
    ).toBe(true);
  });

  test("requires signature when selected handover mode metadata demands it", () => {
    expect(
      resolveComposerSignatureRequired({
        podRequirements: {
          signature_required: false,
        },
        handoverMode: "named_recipient",
        handoverModes: [
          {
            value: "named_recipient",
            metadata: {
              requires_signature: true,
            },
          },
        ],
      })
    ).toBe(true);
  });

  test("does not require signature when neither policy nor handover mode requires it", () => {
    expect(
      resolveComposerSignatureRequired({
        podRequirements: {
          signature_required: false,
        },
        handoverMode: "mailroom",
        handoverModes: [
          {
            value: "mailroom",
            metadata: {
              requires_signature: false,
            },
          },
        ],
      })
    ).toBe(false);
  });
});
