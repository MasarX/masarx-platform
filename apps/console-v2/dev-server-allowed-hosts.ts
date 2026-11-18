const DOCKER_RUNTIME_DEV_SERVER_HOSTS = ['console-v2'];

function splitHostList(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveDevServerAllowedHosts(
  env: Record<string, string | undefined> = process.env,
): string[] | undefined {
  const hosts = new Set([
    ...splitHostList(env.VITE_DEV_SERVER_ALLOWED_HOSTS),
    ...splitHostList(env.CONSOLE_V2_DEV_SERVER_ALLOWED_HOSTS),
  ]);
  const dockerRuntime =
    env.MASARX_DOCKER_RUNTIME === '1' ||
    env.MASARX_RUNTIME_DRIVER === 'docker' ||
    Boolean(env.MASARX_APP_COMPOSE_PROJECT_NAME);

  if (dockerRuntime) {
    for (const host of DOCKER_RUNTIME_DEV_SERVER_HOSTS) {
      hosts.add(host);
    }
  }

  return hosts.size ? Array.from(hosts) : undefined;
}
