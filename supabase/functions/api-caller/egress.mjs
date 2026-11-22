const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_REDIRECT_SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
]);

export class EgressPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "EgressPolicyError";
  }
}

const normaliseHostname = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/^\[|\]$/g, "")
  .replace(/\.$/, "");

const parseIpv4 = (value) => {
  const parts = String(value || "").split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map((part) => Number(part));
  return octets.some((octet) => octet < 0 || octet > 255) ? null : octets;
};

const parseIpv6 = (value) => {
  let input = normaliseHostname(value);
  if (!input || input.includes("%")) return null;

  const ipv4Match = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    input = input.slice(0, input.length - ipv4Match[1].length) + replacement;
  }

  if (!input.includes(":")) return null;
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [
    ...left,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 ? groups : null;
};

export const isPublicIpv4 = (value) => {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

export const isPublicIpv6 = (value) => {
  const groups = parseIpv6(value);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5] = groups;

  if (groups.every((group) => group === 0)) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  if ((g0 & 0xfe00) === 0xfc00) return false;
  if ((g0 & 0xffc0) === 0xfe80) return false;
  if ((g0 & 0xff00) === 0xff00) return false;
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x2001 && g1 === 0x0002) return false;
  if (g0 === 0x2001 && g1 === 0x0000) return false;
  if (g0 === 0x2002) return false;
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false;
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false;
  if (g0 === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && g5 === 0xffff) return false;
  return true;
};

export const isPublicIpAddress = (value) => {
  const normalized = normaliseHostname(value);
  if (parseIpv4(normalized)) return isPublicIpv4(normalized);
  if (parseIpv6(normalized)) return isPublicIpv6(normalized);
  return false;
};

const isIpLiteral = (value) => Boolean(parseIpv4(normaliseHostname(value)) || parseIpv6(normaliseHostname(value)));

const matchesDomainPattern = (host, pattern) => {
  const normalizedHost = normaliseHostname(host);
  const normalizedPattern = normaliseHostname(pattern);
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
};

const matchesDomainDenyPattern = (host, pattern) => {
  const normalizedHost = normaliseHostname(host);
  const normalizedPattern = normaliseHostname(pattern);
  if (!normalizedHost || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  const suffix = normalizedPattern.startsWith("*.")
    ? normalizedPattern.slice(2)
    : normalizedPattern;
  return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
};

export const canonicalizeHttpsUrl = (value, httpAllowedHost) => {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (_error) {
    throw new EgressPolicyError("Egress policy violation: invalid URL");
  }

  const host = normaliseHostname(parsed.hostname);
  const allowedHttp = parsed.protocol === "http:" && httpAllowedHost &&
    host === normaliseHostname(httpAllowedHost) && !isIpLiteral(host);
  if (parsed.protocol !== "https:" && !allowedHttp) {
    throw new EgressPolicyError("Egress policy violation: only https:// or the approved HTTP hostname is allowed");
  }
  if (parsed.username || parsed.password) {
    throw new EgressPolicyError("Egress policy violation: URL userinfo is not allowed");
  }
  if (!host) {
    throw new EgressPolicyError("Egress policy violation: target hostname is missing");
  }
  parsed.hash = "";
  return parsed;
};

const assertDomainPolicy = (url, policy) => {
  const host = normaliseHostname(url.hostname);
  const denylist = Array.isArray(policy.domainDenylist) ? policy.domainDenylist : [];
  if (denylist.some((pattern) => matchesDomainDenyPattern(host, pattern))) {
    throw new EgressPolicyError(`Egress policy violation: domain denied by policy (${host})`);
  }

  const allowlist = Array.isArray(policy.domainAllowlist) ? policy.domainAllowlist : [];
  if (policy.transportMode === "direct_trusted_host") {
    if (!isIpLiteral(host) || !isPublicIpAddress(host)) {
      throw new EgressPolicyError(
        `Egress policy violation: direct transport requires an exact public IP literal (${host})`,
      );
    }
    const trustedAddresses = allowlist
      .map(normaliseHostname)
      .filter((entry) => isIpLiteral(entry) && isPublicIpAddress(entry));
    if (!trustedAddresses.length || !trustedAddresses.includes(host)) {
      throw new EgressPolicyError(`Egress policy violation: direct IP is not exactly allowlisted (${host})`);
    }
  } else if (allowlist.length > 0 && !allowlist.some((pattern) => matchesDomainPattern(host, pattern))) {
    throw new EgressPolicyError(`Egress policy violation: domain not present in allowlist (${host})`);
  }
};

const resolvePublicAddresses = async (hostname, resolveDns, signal) => {
  const host = normaliseHostname(hostname);
  if (isIpLiteral(host)) {
    if (!isPublicIpAddress(host)) {
      throw new EgressPolicyError(`Egress policy violation: non-public IP target blocked (${host})`);
    }
    return [host];
  }
  if (typeof resolveDns !== "function") {
    throw new EgressPolicyError("Egress policy violation: direct DNS validation is unavailable");
  }

  const lookups = await Promise.all(["A", "AAAA"].map(async (recordType) => {
    let values;
    try {
      values = await resolveDns(host, recordType, { signal });
    } catch (_error) {
      throw new EgressPolicyError(
        `Egress policy violation: ${recordType} DNS lookup failed (${host})`,
      );
    }
    if (!Array.isArray(values)) {
      throw new EgressPolicyError(
        `Egress policy violation: ${recordType} DNS lookup returned an invalid result (${host})`,
      );
    }
    return values;
  }));
  const addresses = lookups.flat();
  if (!addresses.length) {
    throw new EgressPolicyError(`Egress policy violation: target DNS produced no addresses (${host})`);
  }
  for (const address of addresses) {
    if (!isPublicIpAddress(address)) {
      throw new EgressPolicyError(`Egress policy violation: target DNS includes a non-public address (${address})`);
    }
  }
  return addresses;
};

const headersToRecord = (headers) => {
  const output = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
};

const bytesToBase64 = (bytes) => {
  const chunkSize = 0x8000;
  const chunks = [];
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + chunkSize)));
  }
  return btoa(chunks.join(""));
};

const readBoundedBody = async (response, maxBytes, signal) => {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response_size_limit_exceeded");
        throw new EgressPolicyError(`Egress policy violation: response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  const isText = !contentType || contentType.startsWith("text/") || contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded") || contentType.includes("javascript");
  if (isJson || isText) {
    const text = new TextDecoder().decode(bytes);
    if (isJson) {
      try {
        return text ? JSON.parse(text) : null;
      } catch (_error) {
        return text;
      }
    }
    return text;
  }
  return { __edge_encoding: "base64", data: bytesToBase64(bytes) };
};

const retainCrossOriginSafeHeaders = (headers) => {
  const safeHeaders = new Headers();
  for (const name of CROSS_ORIGIN_REDIRECT_SAFE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) safeHeaders.set(name, value);
  }
  return safeHeaders;
};

export const executeBoundedEgress = async ({
  url,
  method,
  headers,
  body,
  timeoutMs,
  policy,
  httpAllowedHost,
  resolveDns,
  directFetch = fetch,
  guardedFetch,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let currentUrl = canonicalizeHttpsUrl(url, httpAllowedHost);
  const totalTimeoutMs = Math.max(Number(timeoutMs) || 0, 1);
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(new DOMException("Egress deadline exceeded", "TimeoutError")), totalTimeoutMs);
  const visited = new Set();
  let currentMethod = String(method || "POST").toUpperCase();
  let currentBody = body;
  let currentHeaders = new Headers(headers || {});
  const maxRedirects = Math.max(Math.min(Number(policy.maxRedirects) || 0, 10), 0);
  const maxResponseBytes = Math.max(Number(policy.maxResponseBytes) || 1_048_576, 1);

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (controller.signal.aborted || now() - startedAt >= totalTimeoutMs) {
        controller.abort(new DOMException("Egress deadline exceeded", "TimeoutError"));
        throw controller.signal.reason;
      }

      if (!Array.isArray(policy.allowedMethods) || !policy.allowedMethods.length ||
          policy.allowedMethods.some((entry) => typeof entry !== "string" || !entry || /[^A-Z]/.test(entry)) ||
          !policy.allowedMethods.includes(currentMethod)) {
        throw new EgressPolicyError(`Egress policy violation: HTTP method ${currentMethod} is not allowed`);
      }

      assertDomainPolicy(currentUrl, policy);
      if (policy.transportMode === "direct_trusted_host") {
        // Direct transport is safe only for public IP literals because native Deno fetch does
        // not expose a hostname-to-peer pinning hook. Hostnames require the guarded boundary.
        await resolvePublicAddresses(currentUrl.hostname, resolveDns, controller.signal);
      } else if (policy.transportMode === "guarded_proxy") {
        if (typeof guardedFetch !== "function") {
          throw new EgressPolicyError("Egress policy violation: guarded proxy transport is unavailable");
        }
        // This lookup is an additional fail-closed check. The guarded transport remains the
        // authoritative boundary that must validate and pin the address it actually connects to.
        await resolvePublicAddresses(currentUrl.hostname, resolveDns, controller.signal);
      } else {
        throw new EgressPolicyError("Egress policy violation: unsupported transport mode");
      }

      const visitKey = currentUrl.href;
      if (visited.has(visitKey)) {
        throw new EgressPolicyError("Egress policy violation: redirect loop detected");
      }
      visited.add(visitKey);

      const fetchImpl = policy.transportMode === "guarded_proxy" ? guardedFetch : directFetch;
      const response = await fetchImpl(currentUrl.href, {
        method: currentMethod,
        headers: headersToRecord(currentHeaders),
        body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
        redirect: "manual",
        signal: controller.signal,
      });

      const location = response.headers.get("location");
      if (!policy.followRedirects || !location || !REDIRECT_STATUSES.has(response.status)) {
        const responseBody = await readBoundedBody(response, maxResponseBytes, controller.signal);
        return {
          status: response.status,
          completed: true,
          headers: headersToRecord(response.headers),
          body: responseBody,
          latency_ms: Math.round(now() - startedAt),
        };
      }

      if (redirectCount >= maxRedirects) {
        await response.body?.cancel("redirect_limit_exceeded");
        throw new EgressPolicyError(`Egress policy violation: redirect limit ${maxRedirects} exceeded`);
      }

      const nextUrl = canonicalizeHttpsUrl(new URL(location, currentUrl).href, httpAllowedHost);
      if (nextUrl.origin !== currentUrl.origin) {
        currentHeaders = retainCrossOriginSafeHeaders(currentHeaders);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
        currentHeaders.delete("content-length");
        currentHeaders.delete("content-type");
      }
      await response.body?.cancel("redirect_followed");
      currentUrl = nextUrl;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EgressPolicyError("Egress deadline exceeded");
    }
    throw error;
  } finally {
    clearTimer(timer);
  }
};
