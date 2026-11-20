"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createUiClient } from "@masarx/api";
import {
  OnboardingChecklist,
  type OnboardingStep,
} from "../../../../packages/ui/src/onboarding/onboarding-checklist";

const STORAGE_KEY = "masarx_onboarding_dismissed";
const useBrowserLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * Resource keys checked for onboarding auto-completion detection.
 * Maps onboarding step IDs to the resource keys whose count > 0 means
 * that step is considered complete.
 */
const STEP_RESOURCE_MAP: Record<string, string> = {
  "create-shipment": "shipments",
  "setup-webhooks": "webhook_sources",
};

/** Resources to query for auto-detect. */
const AUTO_DETECT_RESOURCES = Object.values(STEP_RESOURCE_MAP);

function buildSteps(
  resourceCounts: Map<string, number | null> | null,
  t: (key: string) => string,
): OnboardingStep[] {
  const isComplete = (stepId: string): boolean => {
    const resourceKey = STEP_RESOURCE_MAP[stepId];
    if (!resourceKey || !resourceCounts) return false;
    const count = resourceCounts.get(resourceKey);
    return typeof count === "number" && count > 0;
  };

  return [
    {
      id: "sign-in",
      title: t("steps.signIn.title"),
      description: t("steps.signIn.description"),
      completed: true,
    },
    {
      id: "review-settings",
      title: t("steps.reviewSettings.title"),
      description: t("steps.reviewSettings.description"),
      completed: false,
      href: "/settings/request",
      actionLabel: t("steps.reviewSettings.action"),
    },
    {
      id: "create-shipment",
      title: t("steps.createShipment.title"),
      description: t("steps.createShipment.description"),
      completed: isComplete("create-shipment"),
      href: "/resources/shipments/new",
      actionLabel: t("steps.createShipment.action"),
    },
    {
      id: "setup-webhooks",
      title: t("steps.setupWebhooks.title"),
      description: t("steps.setupWebhooks.description"),
      completed: isComplete("setup-webhooks"),
      href: "/resources/webhook_sources",
      actionLabel: t("steps.setupWebhooks.action"),
    },
    {
      id: "explore-commands",
      title: t("steps.exploreCommands.title"),
      description: t("steps.exploreCommands.description"),
      completed: false,
      href: "/commands",
      actionLabel: t("steps.exploreCommands.action"),
    },
  ];
}

type OnboardingBannerProps = {
  appBasePath?: string;
};

export function OnboardingBanner({ appBasePath }: OnboardingBannerProps) {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const [dismissed, setDismissed] = React.useState(false);
  const [resourceCounts, setResourceCounts] = React.useState<Map<
    string,
    number | null
  > | null>(null);

  useBrowserLayoutEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") setDismissed(true);
    } catch {
      setDismissed(false);
    }
  }, []);

  // Fetch resource counts to auto-detect completed onboarding steps.
  React.useEffect(() => {
    if (dismissed !== false) return;
    let cancelled = false;
    const ui = createUiClient();
    Promise.allSettled(
      AUTO_DETECT_RESOURCES.map(async (resource) => {
        const result = await ui.listResource(resource, {}, 1);
        return [resource, (result.items ?? []).length] as const;
      }),
    )
      .then((results) => {
        const counts = new Map<string, number>();
        for (const result of results) {
          if (result.status === "fulfilled") counts.set(...result.value);
        }
        if (cancelled) return;
        setResourceCounts(counts);
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  const handleDismiss = React.useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // localStorage may be unavailable
    }
    setDismissed(true);
  }, []);

  const handleStepClick = React.useCallback(
    (step: OnboardingStep) => {
      if (step.href) {
        const resolvedHref = appBasePath
          ? `${appBasePath}${step.href}`
          : step.href;
        router.push(resolvedHref);
      }
    },
    [appBasePath, router]
  );

  if (dismissed) return null;

  const steps = buildSteps(resourceCounts, t);

  return (
    <OnboardingChecklist
      steps={steps}
      onStepClick={handleStepClick}
      onDismiss={handleDismiss}
      className="mb-6"
    />
  );
}
