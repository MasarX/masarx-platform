// Mobile V2 native-intent runners — the React Native bridge layer that
// turns the pure URL builders in `mobile-v2-intent-helpers.ts` into real
// device actions (open dialer, open WhatsApp, open maps, share / copy
// text).
//
// Engineering audit B1 (BLOCKER): the V2 shell's call / WhatsApp /
// navigate / copy / share handlers were toast-only stubs that performed
// no real action. These runners are the production implementations —
// they work on native (iOS/Android) AND on the `?v2=preview` Expo Web
// surface, so the audit gallery still exercises a genuine action path.
//
// This file imports `react-native` (Linking, Share), so — like
// `mobile-v2-confirm.ts` — it is kept separate from the pure
// `mobile-v2-intent-helpers.ts` module which the RN-free jest unit
// runner covers directly.

import { Linking, Platform, Share } from "react-native";

import {
  buildMobileV2MapsUrl,
  buildMobileV2TelUrl,
  buildMobileV2WhatsAppUrl,
} from "./mobile-v2-intent-helpers";

/**
 * Result of an intent attempt. `ok` is true when the device intent was
 * dispatched; `reason` carries a short human-readable failure cause so
 * the caller can pick the right toast tone / message.
 */
export interface MobileV2IntentResult {
  readonly ok: boolean;
  readonly reason?: "no-target" | "unsupported" | "error";
}

const OK: MobileV2IntentResult = Object.freeze({ ok: true });

function fail(reason: NonNullable<MobileV2IntentResult["reason"]>): MobileV2IntentResult {
  return Object.freeze({ ok: false, reason });
}

/**
 * Open a URL via `Linking`. Probes `canOpenURL` first so an unsupported
 * scheme surfaces as a clean `unsupported` result instead of an
 * uncaught rejection. On web `canOpenURL` resolves true for http(s) and
 * `Linking.openURL` delegates to `window.open`.
 */
async function openUrl(url: string): Promise<MobileV2IntentResult> {
  try {
    // `canOpenURL` can throw on some platforms for exotic schemes; the
    // try/catch keeps a probe failure from masking an otherwise-openable
    // URL — we still attempt the open below.
    let canOpen = true;
    try {
      canOpen = await Linking.canOpenURL(url);
    } catch {
      canOpen = true;
    }
    if (!canOpen) return fail("unsupported");
    await Linking.openURL(url);
    return OK;
  } catch {
    return fail("error");
  }
}

/** Dial a phone number via the device dialer (`tel:`). */
export async function openMobileV2Call(
  phone: string | null | undefined,
): Promise<MobileV2IntentResult> {
  const url = buildMobileV2TelUrl(phone);
  if (url === null) return fail("no-target");
  return openUrl(url);
}

/** Open a WhatsApp conversation (`https://wa.me/<digits>`). */
export async function openMobileV2WhatsApp(
  phone: string | null | undefined,
  message?: string,
): Promise<MobileV2IntentResult> {
  const url = buildMobileV2WhatsAppUrl(phone, message);
  if (url === null) return fail("no-target");
  return openUrl(url);
}

/** Open turn-by-turn navigation to a free-text destination address. */
export async function openMobileV2Maps(
  destination: string | null | undefined,
): Promise<MobileV2IntentResult> {
  const url = buildMobileV2MapsUrl(destination);
  if (url === null) return fail("no-target");
  return openUrl(url);
}

/** Open an arbitrary already-built URL (e.g. a coordinate maps URL). */
export async function openMobileV2Url(
  url: string | null | undefined,
): Promise<MobileV2IntentResult> {
  if (typeof url !== "string" || url.trim().length === 0) return fail("no-target");
  return openUrl(url.trim());
}

/**
 * Share a block of text via the OS share sheet (`Share.share`). On web
 * `Share.share` is a no-op, so the web path falls through to the
 * Web Share API (`navigator.share`) when present and finally to a
 * clipboard write so the action is never silently dropped on the
 * `?v2=preview` showcase.
 */
export async function shareMobileV2Text(
  text: string | null | undefined,
  title?: string,
): Promise<MobileV2IntentResult> {
  const body = (text ?? "").trim();
  if (body.length === 0) return fail("no-target");
  if (Platform.OS === "web") {
    const nav =
      typeof navigator !== "undefined"
        ? (navigator as unknown as {
            share?: (data: { title?: string; text: string }) => Promise<void>;
          })
        : undefined;
    if (nav?.share !== undefined) {
      try {
        await nav.share({ title, text: body });
        return OK;
      } catch {
        // User dismissed the share sheet or the API rejected — fall
        // through to a clipboard copy so the address is still captured.
      }
    }
    return copyMobileV2Text(body);
  }
  try {
    await Share.share(title !== undefined ? { title, message: body } : { message: body });
    return OK;
  } catch {
    return fail("error");
  }
}

/**
 * Copy text to the clipboard. RN 0.81 removed the core `Clipboard`
 * module and the FieldOps app does not bundle `expo-clipboard`, so:
 *
 *   - web (incl. the `?v2=preview` showcase + Expo Web): uses the
 *     `navigator.clipboard` Async Clipboard API — a genuine copy.
 *   - native: falls through to the OS share sheet (`Share.share`),
 *     which lets the driver copy / forward the address. A share sheet
 *     IS a real device action, so the native path is never a no-op.
 *
 * This keeps "copy address" a real production action on every surface
 * without adding a native dependency that would force an Expo prebuild.
 */
export async function copyMobileV2Text(
  text: string | null | undefined,
): Promise<MobileV2IntentResult> {
  const body = (text ?? "").trim();
  if (body.length === 0) return fail("no-target");
  if (Platform.OS === "web") {
    const clip =
      typeof navigator !== "undefined"
        ? (navigator as unknown as {
            clipboard?: { writeText?: (value: string) => Promise<void> };
          }).clipboard
        : undefined;
    if (clip?.writeText !== undefined) {
      try {
        await clip.writeText(body);
        return OK;
      } catch {
        return fail("error");
      }
    }
    return fail("unsupported");
  }
  // Native: no clipboard module bundled — fall through to the share
  // sheet so the action still does something real for the driver.
  try {
    await Share.share({ message: body });
    return OK;
  } catch {
    return fail("error");
  }
}
