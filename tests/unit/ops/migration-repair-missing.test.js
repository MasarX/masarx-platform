const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  hasMarketplaceNetworkRegistryRls,
  normalizeDbUrl,
  resolveDbUrlCandidates,
  resolveConnectTimeoutMs,
  resolveRepairConfigPath,
  loadRepairRules,
  resolveRuleSqlPath,
} = require('../../../scripts/ops/migration-repair-missing');

describe('migration-repair-missing', () => {
  test('normalizeDbUrl strips quotes and trims', () => {
    expect(normalizeDbUrl('')).toBe('');
    expect(normalizeDbUrl('  postgresql://x  ')).toBe('postgresql://x');
    expect(normalizeDbUrl('\"postgresql://x\"')).toBe('postgresql://x');
    expect(normalizeDbUrl("'postgresql://x'")).toBe('postgresql://x');
  });

  test('resolveDbUrlCandidates prefers DATABASE_URL_DIRECT then DATABASE_URL', () => {
    const env = {
      DATABASE_URL_DIRECT: 'postgresql://direct',
      DATABASE_URL: 'postgresql://canonical',
    };
    expect(resolveDbUrlCandidates(env)).toEqual([
      { label: 'direct', url: 'postgresql://direct' },
      { label: 'canonical', url: 'postgresql://canonical' },
    ]);
  });

  test('resolveDbUrlCandidates de-dupes when direct equals canonical', () => {
    const env = {
      DATABASE_URL_DIRECT: 'postgresql://same',
      DATABASE_URL: 'postgresql://same',
    };
    expect(resolveDbUrlCandidates(env)).toEqual([{ label: 'direct', url: 'postgresql://same' }]);
  });

  test('resolveConnectTimeoutMs defaults and validates', () => {
    expect(resolveConnectTimeoutMs({})).toBe(15000);
    expect(resolveConnectTimeoutMs({ MIGRATION_REPAIR_CONNECT_TIMEOUT_MS: '' })).toBe(15000);
    expect(resolveConnectTimeoutMs({ MIGRATION_REPAIR_CONNECT_TIMEOUT_MS: '9000' })).toBe(9000);
    expect(resolveConnectTimeoutMs({ MIGRATION_REPAIR_CONNECT_TIMEOUT_MS: 'nope' })).toBe(15000);
    expect(resolveConnectTimeoutMs({ MIGRATION_REPAIR_CONNECT_TIMEOUT_MS: '-1' })).toBe(15000);
  });

  test('resolveRepairConfigPath defaults under the repo and honors absolute overrides', () => {
    expect(resolveRepairConfigPath({})).toBe(
      path.join(process.cwd(), 'config/ops/migration-repair-rules.json'),
    );

    const absolute = path.join(os.tmpdir(), 'migration-repair-rules.json');
    expect(
      resolveRepairConfigPath({ MIGRATION_REPAIR_RULES_PATH: absolute }),
    ).toBe(absolute);
  });

  test('loadRepairRules reads the registry-driven repair contract', () => {
    const rules = loadRepairRules({});
    const target = rules.find((rule) => rule.version === '202603062500');
    const marketplaceTarget = rules.find((rule) => rule.version === '202603071110');

    expect(Array.isArray(rules)).toBe(true);
    expect(target).toEqual({
      version: '202603062500',
      mode: 'pre_push_apply_sql',
      probe_handler: 'labels_print_workflow_v2_referenced_steps_present',
      sql_path: 'scripts/ops/sql/202603062500_labels_print_workflow_v2_history_detach_guard.sql',
      description: expect.stringContaining('Detach referenced labels_print_workflow_v2 template steps'),
    });
    expect(resolveRuleSqlPath(target)).toBe(
      path.join(
        process.cwd(),
        'scripts/ops/sql/202603062500_labels_print_workflow_v2_history_detach_guard.sql',
      ),
    );
    expect(marketplaceTarget).toEqual({
      version: '202603071110',
      mode: 'history_only_mark_applied',
      probe_handler: 'marketplace_network_registry_rls_present',
      sql_path: '',
      description: expect.stringContaining('marketplace network registry RLS'),
    });
  });

  test('loadRepairRules honors env override paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-repair-rules-'));
    const configPath = path.join(tempDir, 'rules.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      rules: [
        {
          version: '202699999999',
          mode: 'history_only_mark_applied',
          probe_handler: 'dialog360_reply_webhook_policy_present',
          description: 'test rule',
        },
      ],
    }), 'utf8');

    expect(loadRepairRules({ MIGRATION_REPAIR_RULES_PATH: configPath })).toEqual([
      {
        version: '202699999999',
        mode: 'history_only_mark_applied',
        probe_handler: 'dialog360_reply_webhook_policy_present',
        sql_path: '',
        description: 'test rule',
      },
    ]);
  });

  test('hasMarketplaceNetworkRegistryRls is exported for the runtime repair registry', () => {
    expect(typeof hasMarketplaceNetworkRegistryRls).toBe('function');
  });
});
