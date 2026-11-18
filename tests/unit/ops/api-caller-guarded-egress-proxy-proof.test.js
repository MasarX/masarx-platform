const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const forge = require('node-forge');
const {
  CONTRACT_VERSION,
  REQUIRED_CAPABILITIES,
  executeProof,
  defaultAuthenticationProbe,
  defaultConnectProbe,
  isPublicIp,
  resolveConfig,
  writeReceipt,
} = require('../../../scripts/ops/verify-api-caller-guarded-egress-proxy');

function createLocalTlsCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '386';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  const attributes = [{ name: 'commonName', value: 'localhost' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([{
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ],
  }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(certificate),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function proofEnv(overrides = {}) {
  return {
    API_CALLER_GUARDED_EGRESS_PROOF_LANE: 'db-dev',
    API_CALLER_GUARDED_EGRESS_PROOF_SHA: '0123456789abcdef0123456789abcdef01234567',
    API_CALLER_GUARDED_EGRESS_PROXY_URL: 'https://proxy.example.test',
    API_CALLER_GUARDED_EGRESS_PROXY_USERNAME: 'credential-user-386',
    API_CALLER_GUARDED_EGRESS_PROXY_PASSWORD: 'secret-password',
    API_CALLER_GUARDED_EGRESS_PROXY_HEALTH_URL: 'https://proxy.example.test/healthz',
    API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL: 'https://probe.example.test/egress-ip',
    API_CALLER_GUARDED_EGRESS_EXPECTED_PUBLIC_IP: '8.8.8.8',
    API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL: 'https://192.0.2.10',
    API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL: 'https://rebinding-probe.example.test',
    API_CALLER_GUARDED_EGRESS_POLICY_DENIED_CODE: 'NON_PUBLIC_DESTINATION_DENIED',
    ...overrides,
  };
}

function healthyPayload() {
  return {
    status: 'ok',
    contract_version: CONTRACT_VERSION,
    capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map((name) => [name, true])),
  };
}

function authenticatedPayload() {
  return {
    correctStatus: 200,
    correctCode: '',
    missingStatus: 407,
    missingChallenge: 'Basic realm="masarx-guarded-egress"',
    wrongStatus: 407,
    wrongChallenge: 'Basic realm="masarx-guarded-egress"',
  };
}

describe('API caller guarded egress proxy proof', () => {
  test('configuration imports work when optional proof transport is unavailable', () => {
    const root = path.resolve(__dirname, '../../..');
    const script = (`
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const originalLoad = Module._load;
      let transportLoads = 0;
      Module._load = function(id, ...args) {
        if (id === 'undici') {
          transportLoads += 1;
          const error = new Error('optional transport unavailable');
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        }
        return originalLoad.call(this, id, ...args);
      };
      const proof = require('./scripts/ops/verify-api-caller-guarded-egress-proxy');
      const cloud = require('./scripts/ops/assert-cloud-env');
      cloud.validateCloudEnv({ env: {
        DATABASE_URL: '` + [`postgresql`,":","/","/",`postgres`,":",`fake-db-password`,"@",`db.abcdefghijklmnopqrst.supabase.co`,":",`5432`,"/",`postgres`].join("") + `',
        PREVIEW_MODE: '1', EDGE_REQUIRE_DB_JWT: '0', GITHUB_ACTIONS: 'false',
        EDGE_INTERNAL_CALLER_ROLES: 'edge_api_caller_role',
        API_CALLER_GUARDED_EGRESS_PROOF_REQUIRED: '0',
      } });
      const config = proof.resolveConfig(${JSON.stringify(proofEnv())});
      assert.equal(config.lane, 'db-dev');
      assert.equal(transportLoads, 0);
    `);
    expect(() => require('child_process').execFileSync(process.execPath, ['-e', script], {
      cwd: root, stdio: 'pipe', timeout: 10000,
    })).not.toThrow();
  });

  test('resolves separate credentials and exact lane configuration', () => {
    const config = resolveConfig(proofEnv());
    expect(config.lane).toBe('db-dev');
    expect(config.candidateSha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(config.proxyUrl.origin).toBe('https://proxy.example.test');
    expect(config.healthUrl.pathname).toBe('/healthz');
    expect(config.policyDeniedProbeUrl.hostname).toBe('192.0.2.10');
    expect(config.rebindingProbeUrl.hostname).toBe('rebinding-probe.example.test');
    expect(config.username).toBe('credential-user-386');
    expect(config.password).toBe('secret-password');
  });

  test.each([
    [{ API_CALLER_GUARDED_EGRESS_PROXY_URL: (['https',":","/","/",'user',":",'pass',"@",'proxy.example.test'].join("")) }, /exact_https_url_required/],
    [{ API_CALLER_GUARDED_EGRESS_PROOF_SHA: 'short-sha' }, /full_sha_required/],
    [{ API_CALLER_GUARDED_EGRESS_PROXY_URL: 'https://127.0.0.1' }, /local_or_private_host/],
    [{ API_CALLER_GUARDED_EGRESS_PROXY_HEALTH_URL: 'https://other.example.test/healthz' }, /health_origin_must_match/],
    [{ API_CALLER_GUARDED_EGRESS_EXPECTED_PUBLIC_IP: '127.0.0.1' }, /public_ip_required/],
    [{ API_CALLER_GUARDED_EGRESS_PUBLIC_PROBE_URL: 'https://127.0.0.1/probe' }, /local_or_private_host/],
    [{ API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL: 'https://8.8.8.8' }, /non_public_ip_literal_required/],
    [{ API_CALLER_GUARDED_EGRESS_POLICY_DENIED_PROBE_URL: 'https://denied.example.test' }, /non_public_ip_literal_required/],
    [{ API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL: 'https://127.0.0.1' }, /controlled_dns_hostname_required/],
    [{ API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL: 'https://metadata.localhost' }, /controlled_dns_hostname_required/],
    [{ API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL: 'https://proxy.example.test' }, /dedicated_origin_required/],
    [{ API_CALLER_GUARDED_EGRESS_REBINDING_PROBE_URL: 'https://probe.example.test' }, /dedicated_origin_required/],
    [{ API_CALLER_GUARDED_EGRESS_PROXY_USERNAME: 'user:name' }, /PROXY_USERNAME/],
    [{ API_CALLER_GUARDED_EGRESS_PROXY_PASSWORD: '' }, /PROXY_PASSWORD/],
    [{ API_CALLER_GUARDED_EGRESS_POLICY_DENIED_CODE: 'bad value' }, /DENIED_CODE/],
  ])('fails closed on invalid proof configuration %#', (override, expected) => {
    expect(() => resolveConfig(proofEnv(override))).toThrow(expected);
  });

  test('rejects private, mapped-private, site-local, benchmark, documentation, translation, and reserved addresses', () => {
    for (const ip of [
      '0.0.0.0',
      '192.0.2.10',
      '100.64.0.1',
      '127.0.0.1',
      '192.0.2.10',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:192.0.2.10',
      'fc00::1',
      'fec0::1',
      'fe80::1',
      'ff02::1',
      '64:ff9b::808:808',
      '64:ff9b:1::808:808',
      '100::1',
      '2001::1',
      '2001:2::1',
      '2001:db8::1',
      '2002::1',
      '3fff::1',
    ]) {
      expect(isPublicIp(ip)).toBe(false);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isPublicIp(ip)).toBe(true);
    }
  });

  test('requires both authoritative live denials and emits a hash-only credential-free receipt', async () => {
    const config = resolveConfig(proofEnv());
    const nowValues = ['2026-07-20T00:00:00.000Z', '2026-07-20T00:00:01.000Z'];
    const receipt = await executeProof(config, {
      now: () => nowValues.shift(),
      healthProbe: async () => ({ status: 200, body: healthyPayload() }),
      publicProbe: async () => ({ status: 200, body: { egress_ip: '8.8.8.8' } }),
      policyDeniedProbe: async () => ({ status: 403, code: 'NON_PUBLIC_DESTINATION_DENIED' }),
      rebindingTransitionProbe: async () => ({
        baselineStatus: 200,
        transitionStatus: 403,
        code: 'NON_PUBLIC_DESTINATION_DENIED',
      }),
      authenticationProbe: async () => authenticatedPayload(),
    });
    expect(receipt.status).toBe('passed');
    expect(receipt.authority).toBe('unsigned_component_only');
    expect(receipt.requires_external_signature).toBe(true);
    expect(receipt.check_count).toBe(6);
    expect(receipt.failure_count).toBe(0);
    expect(receipt.candidate_sha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(receipt.checks.map((check) => check.id)).toEqual([
      'local_private_denial_before_transport',
      'authenticated_health_capability',
      'fixed_public_egress_probe',
      'live_private_target_proxy_denial',
      'live_dns_rebinding_proxy_denial',
      'live_proxy_authentication_contract',
    ]);
    expect(receipt.checks[0].evidence.transport_attempted).toBe(false);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('secret-password');
    expect(serialized).not.toContain('credential-user-386');
    expect(serialized).not.toContain('proxy.example.test');
    expect(serialized).not.toContain('probe.example.test');
    expect(serialized).not.toContain('rebinding-probe.example.test');
    expect(serialized).not.toContain('192.0.2.10');
    expect(serialized).not.toContain('8.8.8.8');
    expect(serialized).not.toContain('NON_PUBLIC_DESTINATION_DENIED');
    expect(receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('does not accept skipped, 500, 502, retry-only, or ambiguous probe success', async () => {
    const config = resolveConfig(proofEnv());
    const receipt = await executeProof(config, {
      now: () => '2026-07-20T00:00:00.000Z',
      healthProbe: async () => ({ status: 500, body: healthyPayload() }),
      publicProbe: async () => ({ status: 502, body: { egress_ip: '8.8.8.8', skipped: true } }),
      policyDeniedProbe: async () => ({ status: 200, code: 'NON_PUBLIC_DESTINATION_DENIED' }),
      rebindingTransitionProbe: async () => ({ baselineStatus: 403, transitionStatus: 403, code: 'WRONG_DENIAL_CODE' }),
      authenticationProbe: async () => authenticatedPayload(),
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.failure_count).toBe(4);
    expect(receipt.checks.filter((check) => check.status === 'failed').map((check) => check.failure_class)).toEqual([
      'health_contract_mismatch',
      'public_probe_contract_mismatch',
      'policy_denial_contract_mismatch',
      'rebinding_denial_contract_mismatch',
    ]);
  });

  test('cannot pass when either authoritative denial is skipped or replaced by self-declaration', async () => {
    const config = resolveConfig(proofEnv());
    const receipt = await executeProof(config, {
      healthProbe: async () => ({ status: 200, body: healthyPayload() }),
      publicProbe: async () => ({ status: 200, body: { egress_ip: '8.8.8.8' } }),
      policyDeniedProbe: async () => ({ status: 403, code: 'NON_PUBLIC_DESTINATION_DENIED' }),
      rebindingTransitionProbe: async () => ({
        baselineStatus: 403,
        transitionStatus: 403,
        code: 'NON_PUBLIC_DESTINATION_DENIED',
      }),
      authenticationProbe: async () => authenticatedPayload(),
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.checks.find((check) => check.id === 'live_dns_rebinding_proxy_denial')).toMatchObject({
      status: 'failed',
      failure_class: 'rebinding_denial_contract_mismatch',
    });
  });

  test('parses real TLS CONNECT responses and proves correct, missing, wrong, and open-proxy auth behavior', async () => {
    const credentials = { username: 'wire-user', password: 'wire-password' };
    const expectedAuthorization = `Basic ${Buffer.from('wire-user:wire-password', 'utf8').toString('base64')}`;
    const { cert, key } = createLocalTlsCertificate();
    const authorities = [];
    let rebindingRequestCount = 0;
    let openProxyMode = false;
    const server = tls.createServer({ cert, key }, (socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString('latin1');
        if (!request.includes('\r\n\r\n')) return;
        const authority = /^CONNECT\s+(\S+)\s+HTTP\/1\.1/m.exec(request)?.[1] || '';
        authorities.push(authority);
        const authorization = /^Proxy-Authorization:\s*(.+)$/im.exec(request)?.[1]?.trim() || '';
        if (!openProxyMode && authorization !== expectedAuthorization) {
          socket.end([
            'HTTP/1.1 407 Proxy Authentication Required',
            'Proxy-Authenticate: Basic realm="masarx-guarded-egress"',
            '',
            '',
          ].join('\r\n'));
          return;
        }
        if (authority === 'timeout.example.test:443') return;
        if (authority === 'partial.example.test:443') {
          socket.end('HTTP/1.1 403 Forbidden\r\n');
          return;
        }
        if (authority === 'rebinding-probe.example.test:443') {
          rebindingRequestCount += 1;
          if (rebindingRequestCount === 1) {
            socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
            return;
          }
        }
        if (authority === 'probe.example.test:443') {
          socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
          return;
        }
        socket.end([
          'HTTP/1.1 403 Forbidden',
          'X-MasarX-Egress-Denial-Code: NON_PUBLIC_DESTINATION_DENIED',
          '',
          '',
        ].join('\r\n'));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const config = {
      ...resolveConfig(proofEnv()),
      ...credentials,
      proxyUrl: new URL(`https://localhost:${port}`),
    };
    const transport = {
      connectTls: (options) => tls.connect({ ...options, ca: cert }),
      timeoutMs: 1000,
    };
    try {
      await expect(defaultConnectProbe(
        config,
        new URL('https://192.0.2.10'),
        'private',
        transport,
      )).resolves.toEqual({ status: 403, code: 'NON_PUBLIC_DESTINATION_DENIED' });
      await expect(defaultConnectProbe(
        config,
        new URL('https://rebinding-probe.example.test'),
        'rebind-baseline',
        transport,
      )).resolves.toEqual({ status: 200, code: '' });
      await expect(defaultConnectProbe(
        config,
        new URL('https://rebinding-probe.example.test'),
        'rebind-transition',
        transport,
      )).resolves.toEqual({ status: 403, code: 'NON_PUBLIC_DESTINATION_DENIED' });
      await expect(defaultConnectProbe(
        config,
        new URL('https://[::1]'),
        'ipv6-private',
        transport,
      )).resolves.toEqual({ status: 403, code: 'NON_PUBLIC_DESTINATION_DENIED' });
      await expect(defaultConnectProbe(
        config,
        new URL('https://partial.example.test'),
        'partial',
        transport,
      )).rejects.toThrow('partial:response_incomplete');
      await expect(defaultConnectProbe(
        config,
        new URL('https://timeout.example.test'),
        'timeout',
        { ...transport, timeoutMs: 50 },
      )).rejects.toThrow('timeout:timeout');
      await expect(defaultAuthenticationProbe(config, transport)).resolves.toEqual({
        correctStatus: 200,
        correctCode: '',
        missingStatus: 407,
        missingChallenge: 'Basic realm="masarx-guarded-egress"',
        wrongStatus: 407,
        wrongChallenge: 'Basic realm="masarx-guarded-egress"',
      });

      openProxyMode = true;
      const openProxyReceipt = await executeProof(config, {
        healthProbe: async () => ({ status: 200, body: healthyPayload() }),
        publicProbe: async () => ({ status: 200, body: { egress_ip: '8.8.8.8' } }),
        policyDeniedProbe: async () => ({ status: 403, code: 'NON_PUBLIC_DESTINATION_DENIED' }),
        rebindingTransitionProbe: async () => ({
          baselineStatus: 200,
          transitionStatus: 403,
          code: 'NON_PUBLIC_DESTINATION_DENIED',
        }),
        authenticationProbe: () => defaultAuthenticationProbe(config, transport),
      });
      expect(openProxyReceipt.status).toBe('failed');
      expect(openProxyReceipt.checks.find((check) => check.id === 'live_proxy_authentication_contract')).toEqual({
        id: 'live_proxy_authentication_contract',
        status: 'failed',
        failure_class: 'proxy_authentication_contract_mismatch',
      });
      expect(authorities).toEqual([
        '192.0.2.10:443',
        'rebinding-probe.example.test:443',
        'rebinding-probe.example.test:443',
        '[::1]:443',
        'partial.example.test:443',
        'timeout.example.test:443',
        'probe.example.test:443',
        'probe.example.test:443',
        'probe.example.test:443',
        'probe.example.test:443',
        'probe.example.test:443',
        'probe.example.test:443',
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);

  test('harvests independent transport failures without leaking exception text', async () => {
    const config = resolveConfig(proofEnv());
    const receipt = await executeProof(config, {
      healthProbe: async () => { throw new Error('secret-password health unavailable'); },
      publicProbe: async () => { throw new Error('credential-user-386 probe unavailable'); },
      policyDeniedProbe: async () => { throw new Error('proxy.example.test denial unavailable'); },
      rebindingTransitionProbe: async () => { throw new Error('rebinding-probe.example.test unavailable'); },
      authenticationProbe: async () => { throw new Error('secret-password auth unavailable'); },
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.failure_count).toBe(5);
    expect(JSON.stringify(receipt)).not.toMatch(/secret-password|credential-user-386|proxy\.example\.test|rebinding-probe\.example\.test/);
  });

  test('writes the compact receipt to the requested path', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-egress-proof-'));
    const target = writeReceipt({ schema_version: CONTRACT_VERSION, status: 'passed' }, path.join(directory, 'receipt.json'));
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).status).toBe('passed');
  });
});
