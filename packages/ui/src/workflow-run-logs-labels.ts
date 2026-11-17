import type { WorkflowRunLogsPanelLabels } from "./workflow-run-logs-panel";
import type { UiTranslateFn } from "./translate";

type CreateWorkflowRunLogsPanelLabelsOptions = {
  keyPrefix: string;
};

function resolveKey(prefix: string, suffix: string) {
  const trimmedPrefix = prefix.trim().replace(/\.$/, "");
  const trimmedSuffix = suffix.trim().replace(/^\./, "");
  if (!trimmedPrefix) return trimmedSuffix;
  if (!trimmedSuffix) return trimmedPrefix;
  return `${trimmedPrefix}.${trimmedSuffix}`;
}

export function createWorkflowRunLogsPanelLabels(
  t: UiTranslateFn,
  options: CreateWorkflowRunLogsPanelLabelsOptions
): WorkflowRunLogsPanelLabels {
  const keyPrefix = options.keyPrefix;
  const key = (suffix: string) => resolveKey(keyPrefix, suffix);

  return {
    tabs: {
      simple: t(key("tabs.simple")),
      advanced: t(key("tabs.advanced")),
    },
    summary: {
      stepsLabel: t(key("summary.stepsLabel")),
      issuesLabel: t(key("summary.issuesLabel")),
    },
    controls: {
      issuesOnly: t(key("controls.issuesOnly")),
      replayLabel: t(key("controls.replayLabel")),
      replayLatestIssue: t(key("controls.replayLatestIssue")),
      replayFirstIssue: t(key("controls.replayFirstIssue")),
      replayAllIssues: t(key("controls.replayAllIssues")),
      replayModalTitle: t(key("controls.replayModalTitle")),
      replayModalDescription: t(key("controls.replayModalDescription")),
    },
    filters: {
      searchPlaceholder: t(key("filters.searchPlaceholder")),
      statusLabel: t(key("filters.statusLabel")),
      statusAll: t(key("filters.statusAll")),
    },
    actions: {
      copyJson: t(key("actions.copyJson")),
      downloadJson: t(key("actions.downloadJson")),
      copySuccessTitle: t(key("actions.copySuccessTitle")),
      copyFailedTitle: t(key("actions.copyFailedTitle")),
      downloadFailedTitle: t(key("actions.downloadFailedTitle")),
    },
    empty: {
      title: t(key("empty.title")),
      description: t(key("empty.description")),
    },
    emptyNoMatches: {
      title: t(key("emptyNoMatches.title")),
      description: t(key("emptyNoMatches.description")),
    },
    emptyNoIssues: {
      title: t(key("emptyNoIssues.title")),
      description: t(key("emptyNoIssues.description")),
    },
    emptyStepFilter: {
      title: t(key("emptyStepFilter.title")),
      description: t(key("emptyStepFilter.description")),
    },
    step: {
      statusLabel: t(key("step.statusLabel")),
      durationLabel: t(key("step.durationLabel")),
      attemptLabel: t(key("step.attemptLabel")),
      decisionLogLabel: t(key("step.decisionLogLabel")),
      openDecisionLog: t(key("step.openDecisionLog")),
      resultLabel: t(key("step.resultLabel")),
      metadataLabel: t(key("step.metadataLabel")),
      errorLabel: t(key("step.errorLabel")),
      notesLabel: t(key("step.notesLabel")),
      timestampsLabel: t(key("step.timestampsLabel")),
      enqueuedAtLabel: t(key("step.enqueuedAtLabel")),
      startedAtLabel: t(key("step.startedAtLabel")),
      completedAtLabel: t(key("step.completedAtLabel")),
      replayFromStep: t(key("step.replayFromStep")),
      replayModalTitle: t(key("step.replayModalTitle")),
      replayModalDescription: t(key("step.replayModalDescription")),
    },
  };
}
