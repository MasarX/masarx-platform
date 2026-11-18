"use client";

import * as React from "react";
import { createUiClient, type OrganizationProfileResult, type OrganizationProfilePatch } from "@masarx/api";
import { Button } from "./button";
import { Input } from "./input";
import { Section } from "./section";
import { createUiTranslator } from "./i18n";
import { resolveTrustedExternalDataUrl } from "./url-guard";

function readLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

export function OrganizationProfileForm({ organizationId }: { organizationId: string }) {
  return <OrganizationProfileFormState key={organizationId} organizationId={organizationId} />;
}

function OrganizationProfileFormState({ organizationId }: { organizationId: string }) {
  const t = React.useMemo(() => createUiTranslator("ui.organizationProfile"), []);
  const [result, setResult] = React.useState<OrganizationProfileResult | null>(null);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState(0);
  const inFlight = React.useRef(false);
  const generation = React.useRef(0);
  React.useEffect(() => {
    const current = ++generation.current;
    createUiClient().organizationProfile.read(organizationId).then((data) => {
      if (generation.current !== current) return;
      if (!data.profile || data.profile.id !== organizationId) throw new Error("invalid_profile_readback");
      setResult(data);
    }).catch(() => { if (generation.current === current) setError(t("loadFailed")); });
    return () => { generation.current += 1; };
  }, [organizationId, t]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !result) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = generation.current;
    const args: OrganizationProfilePatch = { organization_id: organizationId };
    for (const key of ["name", "timezone", "locale", "primary_color", "secondary_color"] as const) {
      const value = String(data.get(key) || "").trim();
      if (value) args[key] = value;
    }
    const file = data.get("logo");
    if (file instanceof File && file.size > 0 && (file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      setError(t("invalidFile")); return;
    }
    inFlight.current = true;
    setPending(true);
    setError("");
    setSaved(false);
    try {
      if (file instanceof File && file.size > 0) {
        args.file_name = file.name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 120);
        args.content_type = file.type;
        args.file_base64 = await readLogo(file);
      }
      if (generation.current !== current) return;
      const next = await createUiClient().organizationProfile.save(args);
      if (generation.current !== current) return;
      if (!next.profile || next.profile.id !== organizationId) throw new Error("invalid_profile_readback");
      setResult(next);
      setPreview(null);
      setRevision((value) => value + 1);
      setSaved(true);
    } catch {
      if (generation.current === current) setError(t("saveFailed"));
    } finally {
      if (generation.current === current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }
  async function previewLogo() {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setPending(true);
    setError("");
    setPreview(null);
    try {
      const response = await createUiClient().organizationProfile.signedUrl(organizationId);
      const url = resolveTrustedExternalDataUrl(response.signed_url);
      if (!url) throw new Error("untrusted_logo_url");
      if (generation.current === current) setPreview(url);
    } catch { if (generation.current === current) setError(t("previewFailed")); }
    finally {
      if (generation.current === current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }
  const branding = result?.profile.default_settings?.branding;
  const colors = branding && typeof branding === "object" && !Array.isArray(branding) ? branding as Record<string, unknown> : {};
  return <Section title={t("title")} collapsible={false}>
    {!result ? <p role="status" className="text-sm text-ui-muted">{error || t("loading")}</p> : <>
      <form key={`${organizationId}:${revision}`} onSubmit={save} onChange={() => { setError(""); setSaved(false); }} data-testid="organization-profile-form">
        <fieldset disabled={pending} className="space-y-4">
          <legend className="sr-only">{t("title")}</legend>
          {(["name", "timezone", "locale", "primary_color", "secondary_color"] as const).map((key) => <div key={key} className="space-y-2">
            <label htmlFor={`organization-profile-${organizationId}-${key}`} className="block text-sm text-ui-ink">{t(key)}</label>
            <Input id={`organization-profile-${organizationId}-${key}`} name={key} required={["name", "timezone", "locale"].includes(key)}
              maxLength={key === "name" ? 200 : 100} pattern={key.endsWith("color") ? "#[0-9A-Fa-f]{6}" : undefined}
              defaultValue={key in result.profile ? String(result.profile[key as "name" | "timezone" | "locale"]) : String(colors[key] || "")}
              className="text-base" />
          </div>)}
          <div className="space-y-2">
            <label htmlFor={`organization-logo-${organizationId}`} className="block text-sm text-ui-ink">{t("logo")}</label>
            <Input id={`organization-logo-${organizationId}`} name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="text-base" aria-describedby={`organization-logo-help-${organizationId}`} />
            <p id={`organization-logo-help-${organizationId}`} className="text-sm text-ui-muted">{t("logoHelp")}</p>
            {result.logo ? <p className="break-words text-sm text-ui-muted">{result.logo.file_name}</p> : null}
          </div>
          <Button type="submit">{pending ? t("saving") : t("save")}</Button>
          {result.logo ? <Button type="button" variant="ghost" onClick={previewLogo}>{t("preview")}</Button> : null}
        </fieldset>
      </form>
      <p role="status" aria-live="polite" className="mt-3 text-sm text-ui-muted">{error || (saved ? t("saved") : "")}</p>
      {preview ? <a href={preview} target="_blank" rel="noopener noreferrer" className="text-sm underline">{t("openPreview")}</a> : null}
    </>}
  </Section>;
}
