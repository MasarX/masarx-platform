export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayDateInputValue(now = new Date()): string {
  return toDateInputValue(now);
}

export function toDateTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${toDateInputValue(date)}T${hours}:${minutes}`;
}

export function localDateTimeInputToUtc(value: string): string | null {
  const date = new Date(value);
  // A local time skipped at a clock change can otherwise silently move forward.
  if (Number.isNaN(date.getTime()) || toDateTimeInputValue(date) !== value) return null;
  return date.toISOString();
}
