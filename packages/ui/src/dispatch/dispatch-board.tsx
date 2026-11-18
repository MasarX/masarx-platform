"use client";

import * as React from "react";
import { cn } from "../utils";
import { Badge } from "../badge";
import { createUiTranslator } from "../i18n";

export type DispatchJob = {
  id: string;
  title: string;
  subtitle?: string | null;
  eta?: string | null;
  priority?: "high" | "medium" | "low";
  assigned?: boolean;
};

export type DriverTimeline = {
  id: string;
  name: string;
  capacity: number;
  currentLoad: number;
  jobs: DispatchJob[];
};

type DispatchBoardProps = {
  unassignedJobs: DispatchJob[];
  drivers: DriverTimeline[];
  onAssignJob?: (jobId: string, driverId: string) => void;
  onUnassignJob?: (jobId: string, driverId: string) => void;
  className?: string;
};

const priorityTones: Record<string, "neutral" | "warning" | "danger"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

/**
 * Drag-and-drop dispatch board with unassigned job queue (left)
 * and driver timelines (right). Drag jobs from queue to drivers.
 */
export function DispatchBoard({
  unassignedJobs,
  drivers,
  onAssignJob,
  onUnassignJob,
  className,
}: DispatchBoardProps) {
  const t = createUiTranslator("ui.dispatchBoard");
  const [dragJob, setDragJob] = React.useState<string | null>(null);
  const [dragOverDriver, setDragOverDriver] = React.useState<string | null>(null);

  const handleDragStart = (jobId: string) => setDragJob(jobId);

  const handleDrop = (e: React.DragEvent, driverId: string) => {
    e.preventDefault();
    if (dragJob) {
      onAssignJob?.(dragJob, driverId);
      setDragJob(null);
      setDragOverDriver(null);
    }
  };

  return (
    <div className={cn("flex gap-4 lg:gap-6", className)}>
      {/* Unassigned jobs queue */}
      <div className="w-72 shrink-0">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ui-ink">{t("unassigned")}</h3>
          <Badge tone="neutral" size="sm">{unassignedJobs.length}</Badge>
        </div>
        <div className="space-y-2 rounded-lg border border-ui-border/40 bg-ui-surface/50 p-2">
          {unassignedJobs.map((job) => (
            <div
              key={job.id}
              draggable
              onDragStart={() => handleDragStart(job.id)}
              className={cn(
                "cursor-grab rounded-lg border border-ui-border/30 bg-ui-paper p-3 shadow-sm transition",
                "hover:border-ui-accent/30 hover:shadow-md",
                "active:cursor-grabbing active:scale-[0.97]",
                dragJob === job.id && "opacity-50"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-ui-ink">{job.title}</p>
                {job.priority ? (
                  <Badge tone={priorityTones[job.priority] ?? "neutral"} size="sm">
                    {job.priority}
                  </Badge>
                ) : null}
              </div>
              {job.subtitle ? (
                <p className="mt-0.5 text-xs text-ui-muted truncate">{job.subtitle}</p>
              ) : null}
              {job.eta ? (
                <p className="mt-1 text-[10px] text-ui-muted/60">{t("eta")}: {job.eta}</p>
              ) : null}
            </div>
          ))}
          {unassignedJobs.length === 0 ? (
            <div className="py-8 text-center text-xs text-ui-muted/40">
              {t("allJobsAssigned")}
            </div>
          ) : null}
        </div>
      </div>

      {/* Driver timelines */}
      <div className="flex-1 space-y-3 overflow-y-auto">
        <h3 className="text-sm font-semibold text-ui-ink">{t("drivers")}</h3>
        {drivers.map((driver) => {
          const utilization = driver.capacity > 0
            ? Math.round((driver.currentLoad / driver.capacity) * 100)
            : 0;
          return (
            <div
              key={driver.id}
              className={cn(
                "rounded-lg border border-ui-border/40 bg-ui-surface/50 p-3 transition",
                dragOverDriver === driver.id && "ring-2 ring-ui-accent/30"
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOverDriver(driver.id); }}
              onDragLeave={() => setDragOverDriver(null)}
              onDrop={(e) => handleDrop(e, driver.id)}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-ui-ink">{driver.name}</span>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-16 rounded-full bg-ui-border/30">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        utilization > 80
                          ? "bg-[rgb(var(--ui-danger))]"
                          : utilization > 50
                            ? "bg-[rgb(var(--ui-warning))]"
                            : "bg-[rgb(var(--ui-success))]"
                      )}
                      style={{ width: `${Math.min(utilization, 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-ui-muted">{utilization}%</span>
                </div>
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {driver.jobs.map((job) => (
                  <div
                    key={job.id}
                    className="shrink-0 rounded border border-ui-border/20 bg-ui-paper px-2 py-1 text-xs"
                  >
                    <span className="font-medium text-ui-ink">{job.title}</span>
                    {job.eta ? (
                      <span className="ms-1 text-ui-muted">{job.eta}</span>
                    ) : null}
                  </div>
                ))}
                {driver.jobs.length === 0 ? (
                  <span className="text-xs text-ui-muted/40">{t("noJobsDropHere")}</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
