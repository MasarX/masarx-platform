"use client";

import * as React from "react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "../dropdown";
import { cn } from "../utils";
import type { AggregationType } from "./metrics";
import type { TranslateFn } from "./types";

export type { AggregationType } from "./metrics";

const AGGREGATION_OPTIONS: AggregationType[] = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "none",
];

type CalculationPopoverProps = {
  t: TranslateFn;
  columnKey: string;
  selected: AggregationType;
  onSelect: (columnKey: string, aggregation: AggregationType) => void;
  children: React.ReactNode;
};

export function CalculationPopover({
  t,
  columnKey,
  selected,
  onSelect,
  children,
}: CalculationPopoverProps) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>{children}</DropdownTrigger>
      <DropdownContent align="end" className="min-w-[120px]">
        {AGGREGATION_OPTIONS.map((option) => (
          <DropdownItem
            key={option}
            onSelect={() => onSelect(columnKey, option)}
            className={cn(selected === option && "font-medium text-ui-accent")}
          >
            {t(`calculation.${option}`)}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}
