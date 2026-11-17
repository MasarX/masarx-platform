export function requireLoopbackTestUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label}: local test URL required`); }
  if (!["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${label}: only an isolated loopback service is allowed`);
  }
  return url;
}

export function findInviteAcceptanceLink(html: string, callback: URL, requestId: string): URL | null {
  const matches: URL[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let url: URL;
    try { url = new URL((match[1] ?? "").replace(/&amp;|&#38;|&#x26;/gi, "&")); } catch { continue; }
    if (url.origin !== callback.origin || url.pathname !== callback.pathname
        || url.username || url.password
        || url.searchParams.get("request_id") !== requestId
        || [...url.searchParams.keys()].join(",") !== "request_id"
        || url.hash.length !== 71 || !/^#token=[a-f0-9]{64}$/.test(url.hash)) continue;
    matches.push(url);
  }
  if (matches.length > 1) throw new Error("invite mail contains ambiguous acceptance links");
  return matches[0] ?? null;
}

// Keep mailbox secrets out of Playwright request traces and transport error messages.
export async function privateInviteFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    const target = new URL(input);
    target.hash = "";
    return await fetch(target, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("invite test HTTP transport failed (URL and credentials redacted)");
  }
}

export async function readInviteFromLocalMailbox(params: {
  mailbox: URL; email: string; callback: URL; requestId: string;
}): Promise<URL> {
  const latest = new URL("/view/latest.html", params.mailbox);
  latest.searchParams.set("query", `to:${params.email}`);
  const deadline = Date.now() + 30_000;
  do {
    const response = await privateInviteFetch(latest);
    if (response.ok) {
      const html = await response.text();
      if (html.length > 1_048_576) throw new Error("invite test mailbox message too large");
      const link = findInviteAcceptanceLink(html, params.callback, params.requestId);
      if (link) return link;
    } else if (response.status !== 404) {
      throw new Error(`invite test mailbox returned HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error("fresh invite-bound acceptance mail was not delivered within 30 seconds");
}
