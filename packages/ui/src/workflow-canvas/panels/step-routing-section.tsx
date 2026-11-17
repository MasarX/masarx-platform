"use client";

import * as React from "react";
import { Input } from "../../input";
import { Textarea } from "../../textarea";
import { Button } from "../../button";
import { Badge } from "../../badge";
import {
  resolveOperationNameMatches,
  buildOperationNameIndex,
} from "../../workflow-template-operation-index";
import { resolveNextOperationRoute } from "../../workflow-routing";

/* ---------------------------------------------------------------------------
 * Types.
 * -------------------------------------------------------------------------*/

type StepRoutingSectionProps = {
  steps: Record<string, unknown>[];
  idKey: string;
  currentStepId: string;
  nextOperationName: string;
  nextOperationPriority: string;
  nextOperationDelaySeconds: string;
  conditionJsonlogicText: string;
  disabled: boolean;
  testIdPrefix?: string;
  labels: {
    title: string;
    nextOperation: string;
    nextOperationPlaceholder: string;
    nextPriority: string;
    nextPriorityPlaceholder: string;
    nextDelay: string;
    nextDelayPlaceholder: string;
    condition: string;
    conditionPlaceholder: string;
    format: string;
    reset: string;
    hintMissing: string;
    hintAmbiguous: string;
    hintSelf: string;
    hintTarget: string;
  };
  onNextOperationNameChange: (value: string) => void;
  onNextOperationPriorityChange: (value: string) => void;
  onNextOperationDelaySecondsChange: (value: string) => void;
  onConditionJsonlogicTextChange: (value: string) => void;
  onFormat?: () => void;
  onReset?: () => void;
};

/* ---------------------------------------------------------------------------
 * Component.
 * -------------------------------------------------------------------------*/

export function StepRoutingSection({
  steps,
  idKey,
  currentStepId,
  nextOperationName,
  nextOperationPriority,
  nextOperationDelaySeconds,
  conditionJsonlogicText,
  disabled,
  testIdPrefix,
  labels,
  onNextOperationNameChange,
  onNextOperationPriorityChange,
  onNextOperationDelaySecondsChange,
  onConditionJsonlogicTextChange,
  onFormat,
  onReset,
}: StepRoutingSectionProps) {
  const operationNameIndex = React.useMemo(
    () => buildOperationNameIndex(steps, idKey),
    [steps, idKey]
  );

  const routeResolution = React.useMemo(() => {
    const trimmed = nextOperationName.trim();
    if (!trimmed) return null;
    const matches = resolveOperationNameMatches(operationNameIndex, trimmed);
    return resolveNextOperationRoute({
      currentStepId,
      nextOperationName: trimmed,
      matches,
    });
  }, [operationNameIndex, currentStepId, nextOperationName]);

  const routeHint =
    routeResolution?.status === "missing"
      ? labels.hintMissing
      : routeResolution?.status === "ambiguous"
        ? labels.hintAmbiguous
        : routeResolution?.status === "self"
          ? labels.hintSelf
          : routeResolution?.status === "target"
            ? labels.hintTarget
            : null;

  const routeTone =
    routeResolution?.status === "missing"
      ? "danger"
      : routeResolution?.status === "ambiguous"
        ? "warning"
        : routeResolution?.status === "self"
          ? "warning"
          : routeResolution?.status === "target"
            ? "success"
            : ("neutral" as const);

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-ui-ink">{labels.title}</div>

      {/* Next operation */}
      <div className="space-y-1">
        <label className="text-xs text-ui-muted">{labels.nextOperation}</label>
        <Input
          value={nextOperationName}
          onChange={(event) => onNextOperationNameChange(event.target.value)}
          placeholder={labels.nextOperationPlaceholder}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-next-operation` : undefined}
        />
        {routeHint ? (
          <Badge
            tone={routeTone}
            className="mt-1 px-2 py-0.5 text-[10px]"
          >
            {routeHint}
          </Badge>
        ) : null}
      </div>

      {/* Priority */}
      <div className="space-y-1">
        <label className="text-xs text-ui-muted">{labels.nextPriority}</label>
        <Input
          type="number"
          value={nextOperationPriority}
          onChange={(event) => onNextOperationPriorityChange(event.target.value)}
          placeholder={labels.nextPriorityPlaceholder}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-next-priority` : undefined}
        />
      </div>

      {/* Delay */}
      <div className="space-y-1">
        <label className="text-xs text-ui-muted">{labels.nextDelay}</label>
        <Input
          type="number"
          value={nextOperationDelaySeconds}
          onChange={(event) => onNextOperationDelaySecondsChange(event.target.value)}
          placeholder={labels.nextDelayPlaceholder}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-next-delay` : undefined}
        />
      </div>

      {/* Condition JSONLogic */}
      <div className="space-y-1">
        <label className="text-xs text-ui-muted">{labels.condition}</label>
        <Textarea
          value={conditionJsonlogicText}
          onChange={(event) => onConditionJsonlogicTextChange(event.target.value)}
          placeholder={labels.conditionPlaceholder}
          disabled={disabled}
          rows={4}
          className="font-mono text-[11px]"
          data-testid={testIdPrefix ? `${testIdPrefix}-condition` : undefined}
        />
        <div className="flex items-center gap-2">
          {onFormat ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onFormat}
              disabled={disabled}
              data-testid={testIdPrefix ? `${testIdPrefix}-format` : undefined}
            >
              {labels.format}
            </Button>
          ) : null}
          {onReset ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onReset}
              disabled={disabled}
              data-testid={testIdPrefix ? `${testIdPrefix}-reset` : undefined}
            >
              {labels.reset}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
