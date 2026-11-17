"use client";

import * as React from "react";
import { format, formatISO } from "date-fns";
import { arSA, enUS } from "date-fns/locale";
import { useLocale, useTranslations } from "next-intl";
import { DayPicker } from "react-day-picker";
import { Dropdown, DropdownContent, DropdownTrigger } from "./dropdown";
import { TimePicker } from "./time-picker";
import { formFieldClasses } from "./form-classes";
import { cn } from "./utils";

export type DatePickerProps = {
  value?: Date;
  onChange?: (value?: Date) => void;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  name?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
};

export type DateRange = {
  start?: Date;
  end?: Date;
};

export type DateRangePickerProps = {
  value?: DateRange;
  onChange?: (value: DateRange) => void;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  startName?: string;
  endName?: string;
  startId?: string;
  endId?: string;
  className?: string;
  startClassName?: string;
  endClassName?: string;
  startPlaceholder?: string;
  endPlaceholder?: string;
  startAriaLabel?: string;
  endAriaLabel?: string;
};

function resolveDateLocale(locale: string) {
  if (locale.toLowerCase().startsWith("ar")) return arSA;
  return enUS;
}

/**
 * Single-date picker with dropdown calendar and locale-aware formatting.
 */
export function DatePicker({
  value,
  onChange,
  disabled,
  minDate,
  maxDate,
  name,
  id,
  className,
  placeholder,
  ariaLabel,
}: DatePickerProps) {
  const t = useTranslations("ui.datePicker");
  const locale = useLocale();
  const calendarLocale = React.useMemo(() => resolveDateLocale(locale), [locale]);
  const stringValue = value ? formatISO(value, { representation: "date" }) : "";
  const displayValue = value ? format(value, "PP", { locale: calendarLocale }) : "";
  const buttonLabel = displayValue || placeholder || t("placeholder");
  const disabledRules = [
    ...(minDate ? [{ before: minDate }] : []),
    ...(maxDate ? [{ after: maxDate }] : []),
  ];

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel ?? t("ariaLabel")}
          className={cn(
            formFieldClasses,
            "text-left",
            !displayValue && "text-ui-muted",
            className
          )}
          disabled={disabled}
        >
          {buttonLabel}
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-auto p-3">
        <DayPicker
          mode="single"
          selected={value}
          onSelect={(next) => {
            onChange?.(next ?? undefined);
          }}
          locale={calendarLocale}
          disabled={disabledRules}
          weekStartsOn={1}
        />
      </DropdownContent>
      {name ? <input type="hidden" name={name} value={stringValue} /> : null}
    </Dropdown>
  );
}

/**
 * Two-date range picker composed of two single pickers.
 */
export function DateRangePicker({
  value,
  onChange,
  disabled,
  minDate,
  maxDate,
  startName,
  endName,
  startId,
  endId,
  className,
  startClassName,
  endClassName,
  startPlaceholder,
  endPlaceholder,
  startAriaLabel,
  endAriaLabel,
}: DateRangePickerProps) {
  const t = useTranslations("ui.datePicker");
  const start = value?.start;
  const end = value?.end;

  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row", className)}>
      <DatePicker
        id={startId}
        name={startName}
        value={start}
        disabled={disabled}
        minDate={minDate}
        maxDate={end ?? maxDate}
        className={startClassName}
        placeholder={startPlaceholder ?? t("range.startPlaceholder")}
        ariaLabel={startAriaLabel ?? t("range.startAria")}
        onChange={(nextStart) => {
          onChange?.({ start: nextStart, end });
        }}
      />
      <DatePicker
        id={endId}
        name={endName}
        value={end}
        disabled={disabled}
        minDate={start ?? minDate}
        maxDate={maxDate}
        className={endClassName}
        placeholder={endPlaceholder ?? t("range.endPlaceholder")}
        ariaLabel={endAriaLabel ?? t("range.endAria")}
        onChange={(nextEnd) => {
          onChange?.({ start, end: nextEnd });
        }}
      />
    </div>
  );
}

export type DateTimePickerProps = {
  value?: Date;
  onChange?: (value?: Date) => void;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  name?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
};

/**
 * Composed date+time picker: DatePicker for the day plus a TimePicker for HH:MM.
 */
export function DateTimePicker({
  value,
  onChange,
  disabled,
  minDate,
  maxDate,
  name,
  id,
  className,
  placeholder,
  ariaLabel,
}: DateTimePickerProps) {
  const timeValue = value
    ? `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`
    : "";

  const handleDateChange = React.useCallback(
    (nextDate?: Date) => {
      if (!nextDate) {
        onChange?.(undefined);
        return;
      }
      const merged = new Date(nextDate);
      if (value) {
        merged.setHours(value.getHours(), value.getMinutes(), 0, 0);
      }
      onChange?.(merged);
    },
    [onChange, value]
  );

  const handleTimeChange = React.useCallback(
    (nextTime: string) => {
      const [hours, minutes] = nextTime.split(":").map(Number);
      const base = value ? new Date(value) : new Date();
      base.setHours(hours ?? 0, minutes ?? 0, 0, 0);
      onChange?.(base);
    },
    [onChange, value]
  );

  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row", className)}>
      <DatePicker
        id={id}
        name={name}
        value={value}
        disabled={disabled}
        minDate={minDate}
        maxDate={maxDate}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        onChange={handleDateChange}
      />
      <TimePicker
        value={timeValue}
        onChange={handleTimeChange}
        disabled={disabled}
        ariaLabel="Select time"
      />
    </div>
  );
}
