import type { Page } from "@playwright/test";
import { resolveTrackingConfig } from "../../../packages/ui/src/tracking-config";
import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "./supabase";
import { ensureSignedIn } from "./session";

export async function fetchTrackingConfig(params: {
  email: string;
  password: string;
}) {
  const { email, password } = params;
  const supabase = await createAuthedSupabaseClient({
    email,
    password,
    label: `tracking:${email}`,
  });

  try {
    const { data, error } = await rpcWithRetry(supabase, "ui_tracking_registry_v1", null, {
      label: `ui_tracking_registry_v1:${email}`,
    });
    if (error) {
      throw new Error(
        `Failed to read ui_tracking_registry_v1: ${(error as any)?.message || String(error)}`
      );
    }
    return resolveTrackingConfig(data ?? null);
  } finally {
    await signOutSupabaseClient(supabase, { label: `tracking:${email}` });
  }
}

export function buildTrackingDetailUrl(params: {
  basePath: string;
  paramKey: string;
  trackingNumber: string;
  shipmentId: string;
}) {
  const { basePath, paramKey, trackingNumber, shipmentId } = params;
  const search = new URLSearchParams({
    [paramKey]: trackingNumber,
    id: shipmentId,
  });
  return `${basePath}/tracking?${search.toString()}`;
}

export async function openTrackingDetailForShipment(params: {
  page: Page;
  basePath: string;
  authTestId: string;
  email: string;
  password: string;
  trackingNumber: string;
  shipmentId: string;
  scopeType?: string | null;
}) {
  const {
    page,
    basePath,
    authTestId,
    email,
    password,
    trackingNumber,
    shipmentId,
    scopeType,
  } = params;

  const trackingConfig = await fetchTrackingConfig({
    email,
    password,
  });
  if (!trackingConfig.config) {
    throw new Error(
      `Tracking config missing: ${trackingConfig.error ?? "unknown error"}`
    );
  }

  await ensureSignedIn({
    page,
    basePath,
    authTestId,
    email,
    password,
    scopeType,
  });

  const detailUrl = buildTrackingDetailUrl({
    basePath,
    paramKey: trackingConfig.config.paramKey,
    trackingNumber,
    shipmentId,
  });

  await page.goto(detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  return {
    config: trackingConfig.config,
    detailUrl,
  };
}
