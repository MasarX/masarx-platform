type DriverSafetyUiMode = "full" | "text_only" | "suppressed";

export function resolveDriverSafetyUiMode(speedKph: number | null | undefined, stages: unknown): DriverSafetyUiMode {
  if (typeof speedKph !== "number" || !Number.isFinite(speedKph) || speedKph < 0) return "suppressed";
  if (!Array.isArray(stages)) return speedKph < 5 ? "full" : speedKph < 25 ? "text_only" : "suppressed";

  // An incomplete or overlapping configured set cannot relax the safety fallback.
  const active = stages.filter((stage) => stage !== null && typeof stage === "object"
    && typeof stage.speed_min_kph === "number" && Number.isFinite(stage.speed_min_kph)
    && stage.speed_min_kph >= 0 && stage.speed_min_kph <= speedKph
    && (stage.speed_max_kph === null || (typeof stage.speed_max_kph === "number"
      && Number.isFinite(stage.speed_max_kph) && speedKph < stage.speed_max_kph)));
  if (active.length !== 1) return "suppressed";
  const mode = active[0].ui_mode;
  if (mode === "full" || mode === "text_only") return mode;
  return "suppressed";
}
