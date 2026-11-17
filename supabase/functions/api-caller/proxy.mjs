export class GuardedProxyConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardedProxyConfigurationError";
  }
}

const hasControlCharacters = (value) => /[\u0000-\u001f\u007f]/.test(value);

export const resolveGuardedProxyConfiguration = ({
  url,
  username,
  password,
} = {}) => {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) {
    throw new GuardedProxyConfigurationError("Guarded egress proxy URL is not configured");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw new GuardedProxyConfigurationError("Guarded egress proxy URL must be an exact HTTPS origin");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new GuardedProxyConfigurationError("Guarded egress proxy URL must be an exact HTTPS origin");
  }

  const proxyUsername = String(username || "");
  const proxyPassword = String(password || "");
  if (Boolean(proxyUsername) !== Boolean(proxyPassword)) {
    throw new GuardedProxyConfigurationError(
      "Guarded egress proxy username and password must be configured together",
    );
  }
  if (
    hasControlCharacters(proxyUsername) ||
    hasControlCharacters(proxyPassword) ||
    proxyUsername.includes(":")
  ) {
    throw new GuardedProxyConfigurationError("Guarded egress proxy credentials are invalid");
  }

  return {
    url: parsed.origin,
    basicAuth: proxyUsername ? { username: proxyUsername, password: proxyPassword } : undefined,
  };
};

export const createGuardedProxyFetch = ({
  url,
  username,
  password,
  createHttpClient,
  fetchImpl = fetch,
}) => {
  let client = null;

  return async (targetUrl, init) => {
    const configuration = resolveGuardedProxyConfiguration({ url, username, password });
    if (typeof createHttpClient !== "function") {
      throw new GuardedProxyConfigurationError("Deno guarded proxy transport is unavailable");
    }

    if (!client) {
      try {
        client = createHttpClient({
          proxy: {
            url: configuration.url,
            ...(configuration.basicAuth ? { basicAuth: configuration.basicAuth } : {}),
          },
        });
      } catch (_error) {
        // Do not surface runtime error text: proxy libraries may echo the proxy URL or credentials.
        throw new GuardedProxyConfigurationError("Deno guarded proxy client initialization failed");
      }
    }

    try {
      return await fetchImpl(targetUrl, { ...init, client });
    } catch (_error) {
      // The target URL is already policy-validated. Keep proxy configuration and credentials redacted.
      throw new Error("Guarded egress proxy request failed");
    }
  };
};
