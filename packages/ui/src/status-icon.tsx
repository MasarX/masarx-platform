import * as React from "react";
import {
  StatusCheckIcon,
  StatusClockIcon,
  StatusXIcon,
  StatusArrowIcon,
} from "./icons";
import type { BadgeTone } from "./badge";
import { STATUS_KEYWORD_GROUPS } from "./status-defaults";

type StatusIconResult = {
  tone: BadgeTone;
  icon: React.ReactElement;
};

/**
 * Pre-resolved status-to-tone mapping.
 * Keys are normalized status strings; values are badge tones.
 * Resolved server-side via {@link resolveStatusConfig} from lookup_values metadata.
 */
export type StatusToneMap = Record<string, BadgeTone>;

const ICON_BY_TONE: Record<BadgeTone, React.ReactElement> = {
  success: <StatusCheckIcon />,
  danger: <StatusXIcon />,
  warning: <StatusClockIcon />,
  info: <StatusArrowIcon />,
  neutral: <StatusClockIcon />,
  accent: <StatusArrowIcon />,
};

/**
 * Resolve the appropriate tone and icon for a status string.
 *
 * When a pre-resolved {@link StatusToneMap} is provided (DB-driven), the
 * normalized status is looked up directly. Otherwise the function falls
 * back to keyword matching against the built-in defaults for backward
 * compatibility.
 *
 * Returns null when the status does not match any known pattern.
 */
export function resolveStatusIcon(
  status: string | null | undefined,
  toneMap?: StatusToneMap,
): StatusIconResult | null {
  const value = (status ?? "").trim().toLowerCase().replace(/[\s-]/g, "_");
  if (!value) return null;

  // DB-driven path: direct lookup when a tone map is provided
  if (toneMap) {
    const tone = Object.hasOwn(toneMap, value) ? toneMap[value] : undefined;
    if (tone) {
      return { tone, icon: ICON_BY_TONE[tone] ?? ICON_BY_TONE.neutral };
    }
    return null;
  }

  // Fallback: keyword-based matching via shared status-defaults SSOT
  for (const group of STATUS_KEYWORD_GROUPS) {
    for (const kw of group.keywords) {
      if (value.includes(kw)) {
        return { tone: group.tone, icon: ICON_BY_TONE[group.tone] ?? ICON_BY_TONE.neutral };
      }
    }
  }

  return null;
}
