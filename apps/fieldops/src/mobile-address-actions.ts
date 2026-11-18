import { copyTextToClipboard } from "../../../packages/ui/src/clipboard";

export function composeStopAddressText(input: {
  address: string | null;
  note?: string | null;
  reference?: string | null;
}): string | null {
  const address = input.address?.trim();
  if (!address) return null;
  return [address, input.note?.trim(), input.reference?.trim()]
    .filter(Boolean)
    .join("\n");
}

export async function runStopAddressAction(
  action: "copy" | "share",
  text: string | null,
): Promise<"copied" | "shared" | "cancelled" | "missing" | "unsupported" | "failed"> {
  if (!text?.trim()) return "missing";
  try {
    if (action === "copy") {
      return (await copyTextToClipboard(text)) ? "copied" : "unsupported";
    }
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
      return "unsupported";
    }
    await navigator.share({ text });
    return "shared";
  } catch (error) {
    // Cancelling Share must never copy a private address as a side effect.
    if (action === "share" && (error as { name?: string } | null)?.name === "AbortError") {
      return "cancelled";
    }
    return "failed";
  }
}
