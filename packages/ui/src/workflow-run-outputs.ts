export type WorkflowRunOutputLink = {
  label: string;
  fullLabel: string;
  url: string;
};

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

function shortenPathLabel(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return { label: "output", fullLabel: "output" };
  const parts = trimmed.split(".").filter(Boolean);
  const label = parts.length > 3 ? parts.slice(-3).join(".") : trimmed;
  return { label, fullLabel: trimmed };
}

function collectUrls(
  value: unknown,
  path: string,
  out: Map<string, WorkflowRunOutputLink>,
  depth: number
) {
  if (depth > 6) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || !isHttpUrl(trimmed)) return;
    if (out.has(trimmed)) return;
    const meta = shortenPathLabel(path);
    out.set(trimmed, { ...meta, url: trimmed });
    return;
  }

  if (Array.isArray(value)) {
    value.slice(0, 25).forEach((entry, index) => {
      collectUrls(entry, `${path}[${index}]`, out, depth + 1);
    });
    return;
  }

  if (!value || typeof value !== "object") return;

  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    const nextPath = path ? `${path}.${key}` : key;
    collectUrls(entry, nextPath, out, depth + 1);
  });
}

export function extractWorkflowRunOutputs(detail: Record<string, unknown> | null) {
  if (!detail) return [] as WorkflowRunOutputLink[];
  const out = new Map<string, WorkflowRunOutputLink>();
  collectUrls(detail.context, "context", out, 0);
  collectUrls(detail.metadata, "metadata", out, 0);
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function parsePathSegments(pathValue: string) {
  const segments: Array<string | number> = [];
  const normalized = pathValue.replace(/\[(\d+)\]/g, ".$1");
  for (const part of normalized.split(".").filter(Boolean)) {
    if (/^\d+$/.test(part)) {
      segments.push(Number.parseInt(part, 10));
    } else {
      segments.push(part);
    }
  }
  return segments;
}

function getPathValue(source: unknown, pathValue: string) {
  const segments = parsePathSegments(pathValue);
  let current = source;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return null;
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function extractWorkflowRunOutputUrlsByPaths(
  detail: Record<string, unknown> | null,
  outputPaths: string[]
) {
  if (!detail || !Array.isArray(outputPaths) || outputPaths.length === 0) {
    return [] as string[];
  }
  const unique = new Set<string>();
  for (const outputPath of outputPaths) {
    const pathValue = outputPath.trim();
    if (!pathValue) continue;
    const value = getPathValue(detail, pathValue);
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || !isHttpUrl(trimmed)) continue;
    unique.add(trimmed);
  }
  return [...unique];
}
