export function sanitizeTargetFieldForTestId(targetField: string) {
  const sanitized = targetField.replace(/\./g, "-").replace(/[^a-z0-9_-]+/gi, "-");
  let start = 0;
  let end = sanitized.length;
  while (start < end && sanitized[start] === "-") start++;
  while (end > start && sanitized[end - 1] === "-") end--;
  return sanitized.slice(start, end);
}
