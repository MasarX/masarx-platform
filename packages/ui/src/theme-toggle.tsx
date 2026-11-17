"use client";

import * as React from "react";
import { createUiTranslator } from "./i18n";
import { cn } from "./utils";
import { Select } from "./select";
import { useTheme, type ThemeMode } from "./theme";

type ThemeToggleProps = {
  className?: string;
};

/**
 * Theme mode selector for system/light/dark.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const t = createUiTranslator("ui.theme");
  const { theme, resolvedTheme, setTheme } = useTheme();
  const selectId = React.useId();
  const labelId = `${selectId}-label`;
  const statusId = `${selectId}-status`;
  const activeLabel =
    theme === "system"
      ? t("activeSystem", { theme: t(`value.${resolvedTheme}`) })
      : t("active", { theme: t(`value.${theme}`) });

  return (
    <div
      className={cn(
        "rounded-2xl border border-ui-accent/15 bg-ui-highlight/40 p-3 text-xs text-ui-muted shadow-soft",
        className
      )}
    >
      <label
        id={labelId}
        htmlFor={selectId}
        className="text-[10px] uppercase tracking-wide text-ui-muted"
      >
        {t("label")}
      </label>
      <Select
        id={selectId}
        aria-labelledby={labelId}
        aria-describedby={statusId}
        value={theme}
        onChange={(event) => setTheme(event.target.value as ThemeMode)}
        className="mt-2 w-full px-2 py-1 text-xs"
      >
        <option value="system">{t("value.system")}</option>
        <option value="light">{t("value.light")}</option>
        <option value="dark">{t("value.dark")}</option>
      </Select>
      <div
        id={statusId}
        className="mt-2 text-[10px] uppercase tracking-wide text-ui-muted"
      >
        {activeLabel}
      </div>
    </div>
  );
}
