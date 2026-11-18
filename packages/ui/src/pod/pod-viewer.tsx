"use client";

import * as React from "react";
import { Badge } from "../badge";
import type { BadgeTone } from "../badge";
import { createUiTranslator } from "../i18n";
import { resolveStatusIcon } from "../status-icon";
import type { StatusToneMap } from "../status-icon";
import { cn } from "../utils";
import { resolveTrustedExternalDataUrl } from "../url-guard";
import { Modal, ModalClose, ModalContent, ModalTitle } from "../modal";

export type PodData = {
  capturedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  recipientName?: string | null;
  recipientClass?: string | null;
  otpConfirmed?: boolean | null;
  identityKind?: string | null;
  completionKind?: string | null;
  completionNotes?: string | null;
  photos?: { url: string; label?: string }[];
  signatureUrl?: string | null;
};

type PodViewerProps = {
  pod: PodData;
  className?: string;
  /** Pre-resolved status-to-tone map from resolveStatusConfig. Enables config-driven badge tones. */
  statusToneMap?: StatusToneMap;
};

/**
 * Proof of Delivery viewer showing photos, signature, GPS stamp,
 * and delivery metadata. Integrates into shipment detail as a tab.
 */
/** Resolve completion kind to a badge tone using the status icon resolver. */
function resolveCompletionTone(kind: string, toneMap?: StatusToneMap): BadgeTone {
  const result = resolveStatusIcon(kind, toneMap);
  return result?.tone ?? "warning";
}

export function PodViewer({ pod, className, statusToneMap }: PodViewerProps) {
  const translated = createUiTranslator("ui.podViewer");
  const fallback = createUiTranslator("ui.podViewer", {
    locale: "en",
    messages: { ui: { podViewer: {
      capturedAt: "Captured at", receivedBy: "Received by", completion: "Completion",
      otpVerified: "Code verification", confirmed: "Confirmed", notConfirmed: "Unconfirmed",
      gpsLocation: "GPS location", accuracy: "Accuracy: {meters} m",
      photos: "Photos ({count})", photoAlt: "Delivery photo {number}",
      signature: "Signature", signatureAlt: "Delivery signature", notes: "Notes",
      photoEnlarged: "Enlarged delivery photo", close: "Close",
    } } },
  });
  const t = (key: string, values?: Record<string, string | number>) =>
    translated.has?.(key) ? translated(key, values) : fallback(key, values);
  const [selectedPhoto, setSelectedPhoto] = React.useState<string | null>(null);
  const photos = (pod.photos ?? []).flatMap((photo) => {
    const url = resolveTrustedExternalDataUrl(photo.url);
    return url ? [{ ...photo, url }] : [];
  });
  const signatureUrl = pod.signatureUrl ? resolveTrustedExternalDataUrl(pod.signatureUrl) : null;

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pod.capturedAt ? (
          <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
            <p className="text-[10px] tracking-wide text-ui-muted">{t("capturedAt")}</p>
            <p className="mt-0.5 text-sm font-medium text-ui-ink">{new Date(pod.capturedAt).toLocaleString()}</p>
          </div>
        ) : null}
        {pod.recipientName ? (
          <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
            <p className="text-[10px] tracking-wide text-ui-muted">{t("receivedBy")}</p>
            <p className="mt-0.5 text-sm font-medium text-ui-ink">{pod.recipientName}</p>
            {pod.recipientClass ? (<Badge tone="neutral" size="sm" className="mt-1">{pod.recipientClass}</Badge>) : null}
          </div>
        ) : null}
        {pod.completionKind ? (
          <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
            <p className="text-[10px] tracking-wide text-ui-muted">{t("completion")}</p>
            <Badge tone={resolveCompletionTone(pod.completionKind, statusToneMap)} size="sm" dot className="mt-1">{pod.completionKind}</Badge>
          </div>
        ) : null}
        {pod.otpConfirmed != null ? (
          <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
            <p className="text-[10px] tracking-wide text-ui-muted">{t("otpVerified")}</p>
            <Badge tone={pod.otpConfirmed ? "success" : "danger"} size="sm" dot className="mt-1">{pod.otpConfirmed ? t("confirmed") : t("notConfirmed")}</Badge>
          </div>
        ) : null}
        {pod.latitude != null && pod.longitude != null ? (
          <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-3">
            <p className="text-[10px] tracking-wide text-ui-muted">{t("gpsLocation")}</p>
            <p className="mt-0.5 font-mono text-xs text-ui-ink">{pod.latitude.toFixed(6)}, {pod.longitude.toFixed(6)}</p>
            {pod.accuracyM != null ? (<p className="text-[10px] text-ui-muted">{t("accuracy", { meters: pod.accuracyM.toFixed(0) })}</p>) : null}
          </div>
        ) : null}
      </div>

      {photos.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-ui-muted">{t("photos", { count: photos.length })}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo, i) => (
              <button key={photo.url} type="button" className="group relative aspect-square overflow-hidden rounded-lg border border-ui-border/30 bg-ui-highlight transition hover:border-ui-accent/50" onClick={() => setSelectedPhoto(photo.url)}>
                <img src={photo.url} alt={photo.label ?? t("photoAlt", { number: i + 1 })} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" referrerPolicy="no-referrer" />
                {photo.label ? (<span className="absolute bottom-0 start-0 end-0 bg-black/50 px-2 py-1 text-[10px] text-white">{photo.label}</span>) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {signatureUrl ? (
        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-ui-muted">{t("signature")}</p>
          <div className="inline-block rounded-lg border border-ui-border/30 bg-white p-2">
            <img src={signatureUrl} alt={t("signatureAlt")} className="h-24 w-auto" loading="lazy" referrerPolicy="no-referrer" />
          </div>
        </div>
      ) : null}

      {pod.completionNotes ? (
        <div>
          <p className="mb-1 text-xs font-semibold tracking-wide text-ui-muted">{t("notes")}</p>
          <p className="text-sm text-ui-ink">{pod.completionNotes}</p>
        </div>
      ) : null}

      <Modal open={Boolean(selectedPhoto)} onOpenChange={(open) => { if (!open) setSelectedPhoto(null); }}>
        <ModalContent aria-describedby={undefined}>
          <ModalTitle>{t("photoEnlarged")}</ModalTitle>
          {selectedPhoto ? (
            <img src={selectedPhoto} alt={t("photoEnlarged")} referrerPolicy="no-referrer" className="max-h-[75dvh] w-full object-contain" />
          ) : null}
          <ModalClose className="mt-3 rounded-md px-3 py-2 text-sm">{t("close")}</ModalClose>
        </ModalContent>
      </Modal>
    </div>
  );
}
