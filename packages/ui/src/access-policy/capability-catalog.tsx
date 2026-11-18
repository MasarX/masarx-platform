"use client";
import * as React from "react";
import { Button } from "../button";
import { Input } from "../input";
import type {
  AccessPolicyTranslator,
  PolicyCapability,
} from "./types";

type CapabilityCatalogProps = {
  t: AccessPolicyTranslator;
  capabilities: PolicyCapability[];
  resolveCapabilityLabel?: (capabilityKey: string) => string;
  capabilityKey: string;
  onCapabilityKeyChange: (value: string) => void;
  capabilityLabel: string;
  onCapabilityLabelChange: (value: string) => void;
  capabilityDescription: string;
  onCapabilityDescriptionChange: (value: string) => void;
  capabilityError: string | null;
  onAddCapability: () => void;
  onRemoveCapability: (capability: PolicyCapability) => void;
};

export function CapabilityCatalog({
  t,
  capabilities,
  resolveCapabilityLabel,
  capabilityKey,
  onCapabilityKeyChange,
  capabilityLabel,
  onCapabilityLabelChange,
  capabilityDescription,
  onCapabilityDescriptionChange,
  capabilityError,
  onAddCapability,
  onRemoveCapability,
}: CapabilityCatalogProps) {
  return (
    <div className="space-y-4 rounded-2xl border border-ui-border bg-ui-surface/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs tracking-wide text-ui-muted">
            {t("capabilities.title", { count: capabilities.length })}
          </div>
          <div className="text-sm text-ui-muted">{t("capabilities.subtitle")}</div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          value={capabilityKey}
          onChange={(event) => onCapabilityKeyChange(event.target.value)}
          placeholder={t("capabilities.add.keyPlaceholder")}
          aria-label={t("capabilities.add.keyAria")}
        />
        <Input
          value={capabilityLabel}
          onChange={(event) => onCapabilityLabelChange(event.target.value)}
          placeholder={t("capabilities.add.labelPlaceholder")}
          aria-label={t("capabilities.add.labelAria")}
        />
        <Input
          value={capabilityDescription}
          onChange={(event) => onCapabilityDescriptionChange(event.target.value)}
          placeholder={t("capabilities.add.descriptionPlaceholder")}
          aria-label={t("capabilities.add.descriptionAria")}
        />
      </div>
      <Button type="button" onClick={onAddCapability}>
        {t("capabilities.add.action")}
      </Button>
      {capabilityError ? (
        <div className="text-xs text-ui-danger">{capabilityError}</div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {capabilities.map((capability) => (
          <div
            key={capability.key}
            className="flex items-center gap-2 rounded-full border border-ui-border bg-ui-surface px-3 py-1 text-xs"
          >
            <span>{resolveCapabilityLabel?.(capability.key) ?? capability.label ?? capability.key}</span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onRemoveCapability(capability)}
            >
              {t("capabilities.remove")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
