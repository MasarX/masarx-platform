import {
  createContactGateState,
  evaluateContactAttempt,
  recordContactAttempt,
  type ContactPolicyLike,
} from "../../../apps/fieldops/src/mobile-contact-rate-limit";

const request = { channel: "sms" as const, stopId: "example-stop", templateId: "example-template", now: 100_000 };
const policy: ContactPolicyLike = {
  allowed_channels: ["sms", "call"],
  templates: { allowed_for_sms: [request.templateId] },
  min_interval_ms: 3_000,
};

test("applies channel and text template policy before rate limiting", () => {
  const state = createContactGateState();
  expect(evaluateContactAttempt(state, { ...request, channel: "whatsapp" }, policy)).toEqual({
    ok: false, reason: "channel_disallowed",
  });
  expect(evaluateContactAttempt(state, { ...request, templateId: null }, policy)).toEqual({
    ok: false, reason: "template_disallowed",
  });
  expect(evaluateContactAttempt(state, { ...request, channel: "call", templateId: null }, policy)).toEqual({ ok: true });
  expect(evaluateContactAttempt(state, request, policy)).toEqual({ ok: true });
});

test("uses the most recent attempt for the same channel and stop", () => {
  const attempt = { ...request, attemptedAt: request.now };
  const first = recordContactAttempt(createContactGateState(), attempt);
  const state = recordContactAttempt(first, { ...attempt, attemptedAt: request.now + 500 });
  expect(evaluateContactAttempt(state, { ...request, now: request.now + 1_000 }, policy)).toEqual({
    ok: false, reason: "rate_limited", retryAfterMs: 2_500,
  });
  expect(evaluateContactAttempt(state, { ...request, stopId: "another-example" }, policy)).toEqual({ ok: true });
  expect(evaluateContactAttempt(state, { ...request, channel: "call" }, policy)).toEqual({ ok: true });
  expect(evaluateContactAttempt(state, { ...request, now: request.now + 3_500 }, policy)).toEqual({ ok: true });
});

test("prunes attempts outside the retained window without mutating the previous state", () => {
  const attempt = { ...request, attemptedAt: request.now };
  const first = recordContactAttempt(createContactGateState(), attempt);
  const accepted = { ...attempt, attemptedAt: request.now + 60_001 };
  expect(recordContactAttempt(first, accepted).recent).toEqual([accepted]);
  expect(first.recent).toEqual([attempt]);
});
