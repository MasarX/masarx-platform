"use client";

import { parseTabularFile, type ParsedTabularFile } from "../tabular-file";

export async function parseTabularFileWithWorker(
  file: File,
  preferredSheet?: string | null,
  signal?: AbortSignal,
): Promise<ParsedTabularFile> {
  if (signal?.aborted) throw new DOMException("File parsing cancelled.", "AbortError");
  const fallback = async () => {
    const parsed = await parseTabularFile(file, preferredSheet);
    if (signal?.aborted) throw new DOMException("File parsing cancelled.", "AbortError");
    return parsed;
  };
  let worker: Worker;
  try {
    if (typeof Worker === "undefined") return fallback();
    worker = new Worker(new URL("./tabular-file-parser.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return fallback();
  }
  // One worker per request keeps cancellation and large workbook memory local to that request.
  try {
    return await new Promise<ParsedTabularFile>((resolve, reject) => {
      const settle = (error?: Error, parsed?: ParsedTabularFile) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(parsed!);
      };
      const abort = () => settle(new DOMException("File parsing cancelled.", "AbortError"));
      const timeout = setTimeout(() => settle(new Error("File parsing timed out.")), 120_000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<{ ok: boolean; parsed?: ParsedTabularFile; error?: string }>) => {
        if (event.data?.ok && event.data.parsed) settle(undefined, event.data.parsed);
        else settle(new Error(event.data?.error || "Unable to read the uploaded file."));
      };
      worker.onerror = () => settle(new Error("File parsing worker failed."));
      worker.onmessageerror = () => settle(new Error("File parsing worker returned an unreadable response."));
      if (signal?.aborted) return abort();
      Promise.resolve().then(() => file.arrayBuffer()).then((buffer) => {
        if (signal?.aborted) return abort();
        try { worker.postMessage({ buffer, fileName: file.name, preferredSheet }, [buffer]); }
        catch (error) { settle(error instanceof Error ? error : new Error("Unable to read the uploaded file.")); }
      }).catch((error) => settle(error instanceof Error ? error : new Error("Unable to read the uploaded file.")));
    });
  } finally {
    worker.terminate();
  }
}
