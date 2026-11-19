import { describe, expect, it } from 'vitest';

import { resolveDevServerAllowedHosts } from '../../../dev-server-allowed-hosts';

describe('resolveDevServerAllowedHosts', () => {
  it('leaves standard local dev host policy unchanged without runtime env', () => {
    expect(resolveDevServerAllowedHosts({})).toBeUndefined();
  });

  it('reads comma-separated explicit dev server hosts from env', () => {
    expect(
      resolveDevServerAllowedHosts({
        VITE_DEV_SERVER_ALLOWED_HOSTS: 'console.local, 127.0.0.1',
        CONSOLE_V2_DEV_SERVER_ALLOWED_HOSTS: 'console-v2.internal',
      }),
    ).toEqual(['console.local', '127.0.0.1', 'console-v2.internal']);
  });

  it('allows the canonical Docker service host for runtime proof probes', () => {
    expect(
      resolveDevServerAllowedHosts({
        MASARX_RUNTIME_DRIVER: 'docker',
      }),
    ).toEqual(['console-v2']);
  });
});
