"use client";

import { isTrustedDownloadUrl, resolveBaseOrigin } from "./url-guard";

export function downloadBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  try {
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}

export async function downloadTrustedFile(url: string) {
  if (typeof window === "undefined" || !isTrustedDownloadUrl(url)) return false;
  const controller = new AbortController();
  // Bound both response headers and file transfer so download actions cannot stay busy indefinitely.
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const resolved = new URL(url, resolveBaseOrigin());
    const response = await fetch(resolved.href, {
      credentials: resolved.origin === window.location.origin ? "include" : "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    const plainName = disposition.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i);
    let name = encodedName ?? plainName?.[1] ?? plainName?.[2] ?? resolved.pathname.split("/").at(-1) ?? "download";
    if (encodedName || !plainName) {
      try { name = decodeURIComponent(name); } catch { /* Keep malformed filename text. */ }
    }
    name = name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
    return downloadBlob(await response.blob(), name && name !== "." && name !== ".." ? name : "download");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

