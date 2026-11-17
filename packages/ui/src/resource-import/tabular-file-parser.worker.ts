import { parseTabularFileBuffer } from "../tabular-file";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ buffer: ArrayBuffer; fileName: string; preferredSheet?: string | null }>) => void) | null;
  postMessage: (response: unknown) => void;
};

scope.onmessage = async ({ data }) => {
  try {
    if (!(data.buffer instanceof ArrayBuffer) || typeof data.fileName !== "string"
      || (data.preferredSheet != null && typeof data.preferredSheet !== "string")) {
      throw new Error("Invalid file parsing request.");
    }
    const parsed = await parseTabularFileBuffer(data.buffer, data.fileName, data.preferredSheet);
    scope.postMessage({ ok: true, parsed });
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : "Unable to read the uploaded file." });
  }
};
