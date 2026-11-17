"use client";

export function downloadBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

