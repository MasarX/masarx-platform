"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import en from "@masarx/config/messages/en.json";
import ar from "@masarx/config/messages/ar.json";
import type { createBrowserClient } from "@masarx/auth/browser";
import { Button } from "./button";
import { Input } from "./input";

type MfaApi = ReturnType<typeof createBrowserClient>["auth"]["mfa"];
type Factor = { id: string; friendly_name?: string };
type Enrollment = { qrCode: string; secret: string };

type AuthMfaProps = {
  mfa: MfaApi;
  onVerified: () => void | Promise<void>;
  onSignOut: () => Promise<void>;
};

export function AuthMfa({ mfa, onVerified, onSignOut }: AuthMfaProps) {
  const locale = useLocale();
  const t = (locale.split("-")[0] === "ar" ? ar : en).ui.auth.mfa;
  const codeId = React.useId();
  const factorInputId = React.useId();
  const [factors, setFactors] = React.useState<Factor[] | null>(null);
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [factorId, setFactorId] = React.useState("");
  const [code, setCode] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<keyof typeof t | null>(null);
  const busy = React.useRef(false);
  const codeInput = React.useRef<HTMLInputElement>(null);
  const hasFactor = Boolean(factorId);

  React.useEffect(() => {
    if (hasFactor) codeInput.current?.focus();
  }, [hasFactor]);

  async function run(action: () => Promise<void>, errorKey: keyof typeof t) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(errorKey);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function prepare() {
    const { data, error: listError } = await mfa.listFactors();
    if (listError) throw listError;
    if (data.totp.length) {
      setFactors(data.totp);
      setFactorId(data.totp[0].id);
      return;
    }

    // An abandoned setup has no usable key after a reload.
    for (const factor of data.all) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        const { error: removeError } = await mfa.unenroll({ factorId: factor.id });
        if (removeError) throw removeError;
      }
    }
    const { data: newFactor, error: enrollError } = await mfa.enroll({ factorType: "totp" });
    if (enrollError) throw enrollError;
    setEnrollment({
      qrCode: newFactor.totp.qr_code,
      secret: newFactor.totp.secret,
    });
    setFactorId(newFactor.id);
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const suppliedCode = code.trim();
    if (!factorId || !/^[0-9]{6}$/.test(suppliedCode)) return;
    await run(async () => {
      setCode("");
      const { error: verifyError } = await mfa.challengeAndVerify({ factorId, code: suppliedCode });
      if (verifyError) throw verifyError;
      setEnrollment(null);
      await onVerified();
    }, "verificationFailed");
  }

  return (
    <div className="space-y-4" data-testid="auth-mfa">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      {!factorId ? (
        <div className="space-y-3">
          <p>{t.description}</p>
          <Button type="button" loading={pending} onClick={() => void run(prepare, "setupFailed")}>
            {t.continue}
          </Button>
        </div>
      ) : (
        <form onSubmit={verify} className="space-y-3">
          {enrollment ? (
            <div className="space-y-2">
              <p>{t.setupInstructions}</p>
              {/* The authenticator service supplies this in-memory QR image. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrollment.qrCode} alt={t.qrLabel} width={160} height={160} />
              <p>{t.manualKey} <code dir="ltr" className="break-all">{enrollment.secret}</code></p>
            </div>
          ) : null}
          {factors && factors.length > 1 ? (
            <label htmlFor={factorInputId} className="block">
              {t.factorLabel}
              <select id={factorInputId} className="ms-2" value={factorId} disabled={pending}
                onChange={(event) => { setFactorId(event.target.value); setCode(""); }}>
                {factors.map((factor, index) => (
                  <option key={factor.id} value={factor.id}>{factor.friendly_name || index + 1}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label htmlFor={codeId} className="block">{t.codeLabel}</label>
          <Input
            ref={codeInput}
            id={codeId}
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]{6}"
            required
            disabled={pending}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" loading={pending}>{t.verify}</Button>
        </form>
      )}
      {error ? <p role="alert">{t[error]}</p> : null}
      <Button type="button" variant="ghost" disabled={pending} onClick={() => void run(onSignOut, "signOutFailed")}>
        {t.signOut}
      </Button>
    </div>
  );
}
