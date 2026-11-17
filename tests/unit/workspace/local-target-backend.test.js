const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertNoForbiddenCommand,
  assertDeclaredPortsMatch,
  assertLiveEvidenceMatchesDeclared,
  checkHttpReadiness,
  createTargetBackend,
  prepareTargetProject,
  prepareSchemaArtifactForTargetRestore,
  readSourceDescriptor,
  resolveCommandOnPath,
  resolveRequiredExecutable,
  resolveSpawnCommand,
  resolveTargetPsqlExecutable,
  resolveWindowsShortPath,
  runCheckedCommand,
} = require('../../../scripts/ops/workspace/local-target-backend');

function writeDescriptor(cwd, descriptor = {}) {
  const filePath = path.join(cwd, 'tmp', 'source-descriptor.json');
  const artifactPath = path.join(cwd, 'tmp', 'baseline.schema.sql');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(artifactPath, '-- schema only\n', 'utf8');
  fs.writeFileSync(filePath, JSON.stringify({
    workspace: 'main-review',
    schema_ready: true,
    schema_only: true,
    no_data: true,
    schema_artifact: 'baseline.schema.sql',
    ...descriptor,
  }, null, 2), 'utf8');
  return path.relative(cwd, filePath);
}

describe('local target backend tooling', () => {
  let psqlTools;

  beforeAll(() => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-psql-bin-'));
    const psqlPath = path.join(binDir, process.platform === 'win32' ? 'psql.exe' : 'psql');
    fs.writeFileSync(path.join(binDir, 'psql'), '#!/bin/sh\nexit 0\n', 'utf8');
    fs.writeFileSync(path.join(binDir, 'psql.exe'), '', 'utf8');
    psqlTools = { binDir, psqlPath };
  });

  afterAll(() => {
    if (psqlTools?.binDir) fs.rmSync(psqlTools.binDir, { recursive: true, force: true });
  });

  function envWithFakePsql(extra = {}) {
    const basePath = String(extra.PATH || process.env.PATH || '');
    return {
      ...process.env,
      ...extra,
      PATH: [psqlTools.binDir, basePath].filter(Boolean).join(path.delimiter),
      PATHEXT: extra.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    };
  }

  test('carries the local invite config asset into an isolated target without overwriting an existing template', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-invite-template-'));
    try {
      const source = path.join(cwd, 'supabase', 'templates', 'invite.html');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, '<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=invite">Confirm invitation</a>', 'utf8');
      fs.writeFileSync(path.join(cwd, 'supabase', 'config.toml'), '[auth.email.template.invite]\ncontent_path = "./supabase/templates/invite.html"\n', 'utf8');
      const result = prepareTargetProject({ cwd, workspace: 'invite-target' });
      const target = path.join(result.supabase_dir, 'templates', 'invite.html');
      expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(source, 'utf8'));
      fs.writeFileSync(target, 'preserved target-owned template', 'utf8');
      prepareTargetProject({ cwd, workspace: 'invite-target' });
      expect(fs.readFileSync(target, 'utf8')).toBe('preserved target-owned template');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('refuses proof-data descriptors', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-proof-data-'));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd, { proof_data: true }),
    }, {
      cwd,
      commandRunner: jest.fn(),
      fetchImpl: jest.fn(),
    })).rejects.toThrow(/proof data/);
  });

  test('refuses shared target or source workspace as target', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-shared-'));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'main-review',
      'source-descriptor': writeDescriptor(cwd),
    }, {
      cwd,
      commandRunner: jest.fn(),
      fetchImpl: jest.fn(),
    })).rejects.toThrow(/refusing shared target/);

    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'lane-source',
      'source-descriptor': writeDescriptor(cwd, { workspace: 'lane-source' }),
    }, {
      cwd,
      commandRunner: jest.fn(),
      fetchImpl: jest.fn(),
    })).rejects.toThrow(/target workspace must differ/);
  });

  test('refuses full migration replay command path', () => {
    expect(() => assertNoForbiddenCommand('supabase', ['db', 'reset'])).toThrow(/full migration replay/);
    expect(() => assertNoForbiddenCommand('node', ['scripts/ops/migrate-local.js'])).toThrow(/full migration replay/);
    expect(() => assertNoForbiddenCommand('npx', ['supabase', 'start', '--ignore-health-check'])).not.toThrow();
  });

  test('Windows command shim resolution uses npx.cmd when plain npx would be unavailable', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-win-shim-'));
    try {
      const shimPath = path.join(binDir, 'npx.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\nexit /b 0\r\n', 'utf8');
      const env = {
        PATH: binDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      };
      expect(resolveCommandOnPath('npx', env, 'win32')).toBe(shimPath);
      const spawn = resolveSpawnCommand('npx', ['supabase', 'start'], {
        env,
        platform: 'win32',
        comspec: 'cmd.exe',
      });
      expect(spawn).toEqual({
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `call ${shimPath} supabase start`],
      });
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('Windows command shim execution handles paths with spaces without literal escaped quotes', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-program-files-'));
    try {
      const binDir = path.join(rootDir, 'Program Files', 'nodejs');
      const shortBinDir = path.join(rootDir, 'PROGRA~1', 'nodejs');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(shortBinDir, { recursive: true });
      const shimPath = path.join(binDir, 'npx.cmd');
      const shortShimPath = path.join(shortBinDir, 'npx.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\nexit /b 0\r\n', 'utf8');
      fs.writeFileSync(shortShimPath, '@echo off\r\nexit /b 0\r\n', 'utf8');
      const spawn = resolveSpawnCommand('npx', ['supabase', 'start'], {
        env: {
          PATH: binDir,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        platform: 'win32',
        comspec: 'cmd.exe',
        shortPathResolver: () => shortShimPath,
      });
      expect(spawn.command).toBe('cmd.exe');
      expect(spawn.args).toEqual([
        '/d',
        '/s',
        '/c',
        `call ${shortShimPath} supabase start`,
      ]);
      expect(spawn.args[3]).not.toContain('\\"');
      expect(spawn.args[3]).not.toContain(`"${shimPath}"`);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('Windows short path discovery uses Program Files short equivalent before cmd fallback', () => {
    const longPath = 'C:\\Program Files\\nodejs\\npx.cmd';
    const shortPath = 'C:\\PROGRA~1\\nodejs\\npx.cmd';
    const shortPathRunner = jest.fn();
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => (
      candidate === longPath || candidate === shortPath
    ));
    try {
      expect(resolveWindowsShortPath(longPath, { shortPathRunner })).toBe(shortPath);
      expect(shortPathRunner).not.toHaveBeenCalled();
      const spawn = resolveSpawnCommand('npx', ['--version'], {
        env: {
          PATH: 'C:\\Program Files\\nodejs',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        platform: 'win32',
        comspec: 'cmd.exe',
        shortPathRunner,
      });
      expect(spawn).toEqual({
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `call ${shortPath} --version`],
      });
      expect(spawn.args[3]).not.toContain('\\"');
    } finally {
      existsSpy.mockRestore();
    }
  });

  test('Windows command shim execution fails closed when no safe short path is available', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-no-short-path-'));
    try {
      const binDir = path.join(rootDir, 'Program Files', 'nodejs');
      fs.mkdirSync(binDir, { recursive: true });
      const shimPath = path.join(binDir, 'npx.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\nexit /b 0\r\n', 'utf8');
      expect(() => resolveWindowsShortPath(shimPath, {
        shortPathResolver: () => shimPath,
      })).toThrow(/short path is unavailable/);
      expect(() => resolveSpawnCommand('npx', ['supabase', 'start'], {
        env: {
          PATH: binDir,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        platform: 'win32',
        comspec: 'cmd.exe',
        shortPathResolver: () => shimPath,
      })).toThrow(/short path is unavailable/);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('Windows command shim resolution prefers PATHEXT candidate over extensionless path', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-win-pathext-'));
    try {
      const extensionlessPath = path.join(binDir, 'npx');
      const shimPath = path.join(binDir, 'npx.cmd');
      fs.writeFileSync(extensionlessPath, '', 'utf8');
      fs.writeFileSync(shimPath, '@echo off\r\nexit /b 0\r\n', 'utf8');
      expect(resolveCommandOnPath('npx', {
        PATH: binDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }, 'win32')).toBe(shimPath);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('Windows command shim resolution prefers exe PATHEXT candidate', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-win-exe-'));
    try {
      const extensionlessPath = path.join(binDir, 'psql');
      const exePath = path.join(binDir, 'psql.exe');
      fs.writeFileSync(extensionlessPath, '', 'utf8');
      fs.writeFileSync(exePath, '', 'utf8');
      expect(resolveCommandOnPath('psql', {
        PATH: binDir,
        PATHEXT: '.EXE;.CMD',
      }, 'win32')).toBe(exePath);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('Windows extensionless path is accepted only when no PATHEXT candidate exists', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-win-extensionless-'));
    try {
      const extensionlessPath = path.join(binDir, 'npx');
      fs.writeFileSync(extensionlessPath, '', 'utf8');
      expect(resolveCommandOnPath('npx', {
        PATH: binDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }, 'win32')).toBe(extensionlessPath);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test('missing Windows executable fails closed with a clear message', () => {
    const runner = jest.fn();
    expect(() => runCheckedCommand('isolated supabase service start', 'npx', ['supabase', 'start'], {
      runner,
      env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
      resolveExecutables: true,
    })).toThrow(/required executable not found: npx/);
    expect(runner).not.toHaveBeenCalled();
  });

  test('resolves host psql from an explicit override path', () => {
    expect(resolveTargetPsqlExecutable({
      'psql-path': psqlTools.psqlPath,
    }, {
      env: { PATH: '' },
    })).toBe(psqlTools.psqlPath);
  });

  test('resolves psql from LOCAL_TARGET_BACKEND_PSQL', () => {
    expect(resolveTargetPsqlExecutable({}, {
      env: {
        PATH: '',
        LOCAL_TARGET_BACKEND_PSQL: psqlTools.psqlPath,
      },
    })).toBe(psqlTools.psqlPath);
  });

  test('Windows psql override resolves path with spaces and exe extension', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-psql-spaces-'));
    try {
      const binDir = path.join(rootDir, 'Program Files', 'PostgreSQL', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const exePath = path.join(binDir, 'psql.exe');
      fs.writeFileSync(exePath, '', 'utf8');
      expect(resolveRequiredExecutable(path.join(binDir, 'psql'), {
        env: { PATH: '', PATHEXT: '.EXE;.CMD' },
        platform: 'win32',
      })).toBe(exePath);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('missing psql fails closed before target start or env write', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-missing-psql-'));
    const commandRunner = jest.fn(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd),
      'summary-out': 'tmp/target-summary.json',
      'env-out': 'tmp/target.env',
    }, {
      cwd,
      commandRunner,
      env: { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    })).rejects.toThrow(/required executable not found: psql/);

    expect(commandRunner).not.toHaveBeenCalled();
    const summary = JSON.parse(fs.readFileSync(path.join(cwd, 'tmp', 'target-summary.json'), 'utf8'));
    expect(summary).toMatchObject({
      status: 'blocked',
      reason: 'psql_executable_missing',
      rollback: { env_written: false },
    });
    expect(fs.existsSync(path.join(cwd, 'tmp', 'target.env'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'supabase', '.temp', 'local-target-backends'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'supabase', '.temp', 'local_target_backend_port_reservations.json'))).toBe(false);
  });

  test('rewrites Supabase bootstrap CREATE SCHEMA statements for target restore only', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-bootstrap-restore-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        [
          '-- bootstrap schema from Supabase local',
          'CREATE SCHEMA _realtime;',
          'CREATE SCHEMA "realtime";',
          '-- application schema must stay strict',
          'CREATE SCHEMA api;',
          '',
        ].join('\n'),
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toMatchObject({
        bootstrap_schema_policy: 'create_schema_if_not_exists',
        rewritten_bootstrap_schemas: ['_realtime', 'realtime'],
        managed_schema_filter: 'unchanged',
        skipped_managed_schema_objects: [],
      });
      const rewritten = fs.readFileSync(restoreArtifact.path, 'utf8');
      expect(rewritten).toContain('CREATE SCHEMA IF NOT EXISTS _realtime;');
      expect(rewritten).toContain('CREATE SCHEMA IF NOT EXISTS "realtime";');
      expect(rewritten).toContain('CREATE SCHEMA api;');
      expect(rewritten).not.toContain('CREATE SCHEMA IF NOT EXISTS api;');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('skips Supabase-managed schema object blocks while preserving application objects', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-managed-restore-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        [
          '--',
          '-- Name: aal_level; Type: TYPE; Schema: auth; Owner: -',
          '--',
          '',
          'CREATE TYPE auth.aal_level AS ENUM (',
          "    'aal1',",
          "    'aal2'",
          ');',
          '',
          '--',
          '-- Name: add_branch_member_v1(jsonb); Type: FUNCTION; Schema: api; Owner: -',
          '--',
          '',
          'CREATE FUNCTION api.add_branch_member_v1(p_args jsonb) RETURNS jsonb',
          '    LANGUAGE plpgsql SECURITY DEFINER',
          '    AS $$ begin return p_args; end $$;',
          '',
          '--',
          '-- Name: execute_driver_handoff_v1(jsonb); Type: FUNCTION; Schema: workflow_handlers; Owner: -',
          '--',
          '',
          'CREATE FUNCTION workflow_handlers.execute_driver_handoff_v1(p_args jsonb) RETURNS jsonb',
          '    LANGUAGE plpgsql SECURITY DEFINER',
          '    AS $$ begin return p_args; end $$;',
          '',
        ].join('\n'),
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toMatchObject({
        managed_schema_filter: 'skip_supabase_managed_schema_objects',
        skipped_managed_schemas: ['auth'],
      });
      expect(restoreArtifact.skipped_managed_schema_objects).toEqual([
        { schema: 'auth', name: 'aal_level', type: 'TYPE' },
      ]);
      const rewritten = fs.readFileSync(restoreArtifact.path, 'utf8');
      expect(rewritten).toContain('Skipped Supabase-managed schema object during local target restore: auth.aal_level (TYPE)');
      expect(rewritten).not.toContain('CREATE TYPE auth.aal_level');
      expect(rewritten).toContain('CREATE FUNCTION api.add_branch_member_v1');
      expect(rewritten).toContain('CREATE FUNCTION workflow_handlers.execute_driver_handoff_v1');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('leaves application-only schema restore artifact unchanged', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-app-restore-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(artifactPath, 'CREATE SCHEMA api;\nCREATE SCHEMA workflow_handlers;\n', 'utf8');
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toEqual({
        path: artifactPath,
        bootstrap_schema_policy: 'unchanged',
        rewritten_bootstrap_schemas: [],
        managed_schema_filter: 'unchanged',
        skipped_managed_schema_objects: [],
        managed_publication_filter: 'unchanged',
        skipped_managed_publications: [],
        managed_event_trigger_filter: 'unchanged',
        skipped_managed_event_triggers: [],
        policy_role_prelude: 'unchanged',
        policy_role_prelude_roles: [],
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('adds NOLOGIN prelude for custom policy roles before strict policy replay', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-policy-role-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        [
          'CREATE SCHEMA api;',
          'CREATE TABLE public.geocodes (organization_id uuid);',
          'CREATE POLICY geocodes_select_manual ON public.geocodes FOR SELECT TO geocoding_manual_role USING (true);',
          'CREATE POLICY geocodes_select_authenticated ON public.geocodes FOR SELECT TO authenticated USING (true);',
          '',
        ].join('\n'),
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toMatchObject({
        policy_role_prelude: 'create_missing_nologin_policy_roles',
        policy_role_prelude_roles: ['geocoding_manual_role'],
        managed_schema_filter: 'unchanged',
      });
      const rewritten = fs.readFileSync(restoreArtifact.path, 'utf8');
      expect(rewritten).toContain("WHERE rolname = 'geocoding_manual_role'");
      expect(rewritten).toContain('CREATE ROLE "geocoding_manual_role" NOLOGIN;');
      expect(rewritten.indexOf('CREATE ROLE "geocoding_manual_role" NOLOGIN;'))
        .toBeLessThan(rewritten.indexOf('CREATE POLICY geocodes_select_manual'));
      expect(rewritten).toContain('CREATE POLICY geocodes_select_manual');
      expect(rewritten).not.toContain('CREATE ROLE "authenticated" NOLOGIN;');
      expect(rewritten).not.toContain('CREATE SCHEMA IF NOT EXISTS api;');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('skips only known Supabase-managed publications during target restore', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-publication-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        [
          '--',
          '-- Name: supabase_realtime; Type: PUBLICATION; Schema: -; Owner: -',
          '--',
          '',
          "CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete, truncate');",
          '',
          '--',
          '-- Name: tenant_operational_events; Type: PUBLICATION; Schema: -; Owner: -',
          '--',
          '',
          'CREATE PUBLICATION tenant_operational_events FOR TABLE public.operational_events;',
          '',
        ].join('\n'),
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toMatchObject({
        managed_publication_filter: 'skip_supabase_managed_publications',
        skipped_managed_publications: [
          { name: 'supabase_realtime', type: 'PUBLICATION' },
        ],
      });
      const rewritten = fs.readFileSync(restoreArtifact.path, 'utf8');
      expect(rewritten).toContain('Skipped Supabase-managed publication during local target restore: supabase_realtime');
      expect(rewritten).not.toContain('CREATE PUBLICATION supabase_realtime');
      expect(rewritten).toContain('CREATE PUBLICATION tenant_operational_events');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('skips only known Supabase-managed event triggers during target restore', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-event-trigger-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        [
          '--',
          '-- Name: issue_graphql_placeholder; Type: EVENT TRIGGER; Schema: -; Owner: -',
          '--',
          '',
          'CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop',
          "         WHEN TAG IN ('DROP EXTENSION')",
          '   EXECUTE FUNCTION extensions.set_graphql_placeholder();',
          '',
          '--',
          '-- Name: pgrst_ddl_watch; Type: EVENT TRIGGER; Schema: -; Owner: -',
          '--',
          '',
          'CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end',
          '   EXECUTE FUNCTION extensions.pgrst_ddl_watch();',
          '',
          '--',
          '-- Name: tenant_audit_watch; Type: EVENT TRIGGER; Schema: -; Owner: -',
          '--',
          '',
          'CREATE EVENT TRIGGER tenant_audit_watch ON ddl_command_end',
          '   EXECUTE FUNCTION public.record_tenant_audit_event();',
          '',
        ].join('\n'),
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toMatchObject({
        managed_event_trigger_filter: 'skip_supabase_managed_event_triggers',
        skipped_managed_event_triggers: [
          { name: 'issue_graphql_placeholder', function: 'extensions.set_graphql_placeholder', type: 'EVENT TRIGGER' },
          { name: 'pgrst_ddl_watch', function: 'extensions.pgrst_ddl_watch', type: 'EVENT TRIGGER' },
        ],
      });
      const rewritten = fs.readFileSync(restoreArtifact.path, 'utf8');
      expect(rewritten).toContain('Skipped Supabase-managed event trigger during local target restore: issue_graphql_placeholder');
      expect(rewritten).toContain('Skipped Supabase-managed event trigger during local target restore: pgrst_ddl_watch');
      expect(rewritten).not.toContain('CREATE EVENT TRIGGER issue_graphql_placeholder');
      expect(rewritten).not.toContain('CREATE EVENT TRIGGER pgrst_ddl_watch');
      expect(rewritten).toContain('CREATE EVENT TRIGGER tenant_audit_watch');
      expect(rewritten).toContain('EXECUTE FUNCTION public.record_tenant_audit_event();');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('preserves allowlisted trigger names when the function does not match', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-event-trigger-strict-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        [
          '--',
          '-- Name: issue_graphql_placeholder; Type: EVENT TRIGGER; Schema: -; Owner: -',
          '--',
          '',
          'CREATE EVENT TRIGGER issue_graphql_placeholder ON ddl_command_end',
          '   EXECUTE FUNCTION public.issue_graphql_placeholder();',
          '',
        ].join('\n'),
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      const restoreArtifact = prepareSchemaArtifactForTargetRestore(artifactPath, project);
      expect(restoreArtifact).toEqual({
        path: artifactPath,
        bootstrap_schema_policy: 'unchanged',
        rewritten_bootstrap_schemas: [],
        managed_schema_filter: 'unchanged',
        skipped_managed_schema_objects: [],
        managed_publication_filter: 'unchanged',
        skipped_managed_publications: [],
        managed_event_trigger_filter: 'unchanged',
        skipped_managed_event_triggers: [],
        policy_role_prelude: 'unchanged',
        policy_role_prelude_roles: [],
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('fails closed on unclassifiable policy role tokens', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-policy-role-bad-'));
    try {
      const artifactPath = path.join(cwd, 'schema.sql');
      fs.writeFileSync(
        artifactPath,
        'CREATE POLICY bad_policy ON public.geocodes FOR SELECT TO bad-role USING (true);\n',
        'utf8',
      );
      const project = { supabase_dir: path.join(cwd, 'supabase') };
      fs.mkdirSync(project.supabase_dir, { recursive: true });

      expect(() => prepareSchemaArtifactForTargetRestore(artifactPath, project))
        .toThrow(/cannot classify policy role token/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('POSIX command resolution remains unchanged', () => {
    expect(resolveCommandOnPath('npx', { PATH: '' }, 'linux')).toBe('npx');
    const runner = jest.fn(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    expect(runCheckedCommand('posix check', 'npx', ['--version'], {
      runner,
      env: { PATH: '' },
      platform: 'linux',
    })).toMatchObject({
      command: 'npx',
      args: ['--version'],
      status: 0,
    });
    expect(runner).toHaveBeenCalledWith('npx', ['--version'], expect.any(Object));
  });

  test('emits rollback summary and withholds env on failed target creation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-fail-'));
    const commandRunner = jest.fn(() => ({ status: 1, stderr: 'cannot expose API' }));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd),
      'summary-out': 'tmp/target-summary.json',
      'env-out': 'tmp/target.env',
    }, {
      cwd,
      commandRunner,
      fetchImpl: jest.fn(),
      env: envWithFakePsql(),
    })).rejects.toThrow(/cannot expose API/);

    const summary = JSON.parse(fs.readFileSync(path.join(cwd, 'tmp', 'target-summary.json'), 'utf8'));
    expect(summary).toMatchObject({
      status: 'blocked',
      reason: 'local_target_backend_failed_closed',
      rollback: {
        env_written: false,
        target_must_be_discarded_or_recreated: true,
      },
    });
    expect(fs.existsSync(path.join(cwd, 'tmp', 'target.env'))).toBe(false);
  });

  test('uses Supabase REST gateway path for API readiness instead of API root', async () => {
    const fetchImpl = jest.fn(async (url) => ({
      status: url.endsWith('/rest/v1/') ? 200 : 200,
    }));

    const results = await checkHttpReadiness({
      api_url: 'http://127.0.0.1:59100',
      auth_url: 'http://127.0.0.1:59100/auth/v1/health',
      studio_url: 'http://127.0.0.1:59103',
    }, { fetchImpl });

    expect(results.find((entry) => entry.name === 'api')).toMatchObject({
      url: 'http://127.0.0.1:59100/rest/v1/',
      status: 200,
    });
    expect(fetchImpl).not.toHaveBeenCalledWith('http://127.0.0.1:59100', expect.any(Object));
  });

  test('fails closed when Supabase REST gateway readiness is unreachable', async () => {
    const fetchImpl = jest.fn(async (url) => ({
      status: url.endsWith('/rest/v1/') ? 404 : 200,
    }));

    await expect(checkHttpReadiness({
      api_url: 'http://127.0.0.1:59100',
      auth_url: 'http://127.0.0.1:59100/auth/v1/health',
      studio_url: 'http://127.0.0.1:59103',
    }, { fetchImpl })).rejects.toThrow(/api readiness failed with status 404/);
  });

  test('refuses start when declared target port config cannot be written or verified', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-port-config-fail-'));
    const commandRunner = jest.fn(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd),
      'summary-out': 'tmp/target-summary.json',
      'env-out': 'tmp/target.env',
    }, {
      cwd,
      commandRunner,
      fetchImpl: jest.fn().mockResolvedValue({ status: 200 }),
      env: envWithFakePsql(),
      portConfigWriter: () => {
        throw new Error('declared port config write failed');
      },
    })).rejects.toThrow(/declared port config write failed/);

    expect(commandRunner).not.toHaveBeenCalled();
    const summary = JSON.parse(fs.readFileSync(path.join(cwd, 'tmp', 'target-summary.json'), 'utf8'));
    expect(summary).toMatchObject({
      status: 'blocked',
      reason: 'local_target_backend_failed_closed',
      rollback: { env_written: false },
    });
    expect(fs.existsSync(path.join(cwd, 'tmp', 'target.env'))).toBe(false);
  });

  test('refuses env and lease handoff when live evidence is missing', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-live-missing-'));
    fs.mkdirSync(path.join(cwd, 'supabase'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'supabase', 'config.toml'), '# test config\n', 'utf8');
    const commandRunner = jest.fn(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd),
      'summary-out': 'tmp/target-summary.json',
      'env-out': 'tmp/target.env',
    }, {
      cwd,
      commandRunner,
      env: envWithFakePsql(),
      liveEvidenceReader: jest.fn(() => ({
        api: { port: 59100, healthy: true },
        auth: { port: 59100, healthy: true },
        db: { port: 59101, healthy: true },
      })),
      ports: {
        api: 59100,
        db: 59101,
        studio: 59103,
        inbucket: 59104,
      },
    })).rejects.toThrow(/studio_health_missing/);

    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(cwd, 'tmp', 'target.env'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'supabase', '.temp', 'local_target_backend_leases.json'))).toBe(false);
  });

  test('refuses env and lease handoff when live evidence reports different ports than declared', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-port-mismatch-'));
    fs.mkdirSync(path.join(cwd, 'supabase'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'supabase', 'config.toml'), '# test config\n', 'utf8');
    const commandRunner = jest.fn(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    await expect(createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd),
      'summary-out': 'tmp/target-summary.json',
      'env-out': 'tmp/target.env',
    }, {
      cwd,
      commandRunner,
      env: envWithFakePsql(),
      liveEvidenceReader: jest.fn(() => ({
        api: { port: 59200, healthy: true },
        auth: { port: 59200, healthy: true },
        db: { port: 59101, healthy: true },
        studio: { port: 59103, healthy: true },
      })),
      ports: {
        api: 59100,
        db: 59101,
        studio: 59103,
        inbucket: 59104,
      },
    })).rejects.toThrow(/live binding proof failed/);

    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(cwd, 'tmp', 'target.env'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'supabase', '.temp', 'local_target_backend_leases.json'))).toBe(false);
  });

  test('writes env only after healthy complete target', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-ok-'));
    fs.mkdirSync(path.join(cwd, 'supabase'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'supabase', 'config.toml'), '# test config\n', 'utf8');
    const commandRunner = jest.fn(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });

    const summary = await createTargetBackend({
      owner: 'product-auth',
      workspace: 'product-auth-target',
      'source-descriptor': writeDescriptor(cwd),
      'summary-out': 'tmp/target-summary.json',
      'env-out': 'tmp/target.env',
    }, {
      cwd,
      commandRunner,
      fetchImpl,
      env: envWithFakePsql(),
      ports: {
        api: 59100,
        db: 59101,
        studio: 59103,
        inbucket: 59104,
      },
    });

    expect(summary.status).toBe('complete');
    expect(summary.reason).toBe('local_target_backend_created');
    expect(summary.target.ports).toEqual({
      api: 59100,
      db: 59101,
      studio: 59103,
      inbucket: 59104,
    });
    expect(summary.target.port_config_path).toBeTruthy();
    expect(summary.target.port_reservation_path).toBeTruthy();
    expect(summary.live_port_evidence).toMatchObject({
      api: { port: 59100, healthy: true },
      auth: { port: 59100, healthy: true },
      db: { port: 59101, healthy: true },
      studio: { port: 59103, healthy: true },
    });
    expect(summary.refused_actions).toMatchObject({
      full_migration_replay: true,
      proof_data_copy: true,
      shared_target: true,
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    const commandText = commandRunner.mock.calls.map(([command, args]) => [command, ...args].join(' ')).join('\n');
    expect(commandText).toContain(psqlTools.psqlPath);
    expect(commandText).not.toMatch(/\bmigrate\b|db reset|db push|seed\b/);
    expect(fs.readFileSync(path.join(cwd, 'tmp', 'target.env'), 'utf8')).toContain('DATABASE_URL=');
    const redactedDatabaseUrl = JSON.parse(
      fs.readFileSync(path.join(cwd, 'tmp', 'target-summary.json'), 'utf8'),
    ).target.database_url;
    expect(redactedDatabaseUrl).toContain('[redacted]');
    expect(redactedDatabaseUrl).not.toContain('postgres:postgres');
    const targetConfig = fs.readFileSync(
      path.join(cwd, 'supabase', '.temp', 'local-target-backends', 'product-auth-target', 'supabase', 'config.toml'),
      'utf8',
    );
    expect(targetConfig).toContain('[api]');
    expect(targetConfig).toContain('port = 59100');
    expect(targetConfig).toContain('[db]');
    expect(targetConfig).toContain('port = 59101');
    expect(targetConfig).toContain('[studio]');
    expect(targetConfig).toContain('port = 59103');
    expect(fs.existsSync(path.join(cwd, 'supabase', '.temp', 'local_target_backend_leases.json'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'supabase', '.temp', 'local_target_backend_port_reservations.json'))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('declared port comparison catches runtime mismatches', () => {
    expect(() => assertDeclaredPortsMatch('target', {
      api: 59100,
      db: 59101,
      studio: 59103,
      inbucket: 59104,
    }, {
      api: 59100,
      db: 59111,
      studio: 59103,
      inbucket: 59104,
    })).toThrow(/db 59101 != 59111/);
  });

  test('live evidence comparison requires healthy declared API/Auth/DB/Studio ports', () => {
    expect(() => assertLiveEvidenceMatchesDeclared('target', {
      api: 59100,
      db: 59101,
      studio: 59103,
      inbucket: 59104,
    }, {
      api: { port: 59100, healthy: true },
      auth: { port: 59199, healthy: true },
      db: { port: 59101, healthy: true },
      studio: { port: 59103, healthy: false },
    })).toThrow(/auth_port 59100 != 59199, studio_health_missing/);
  });

  test('requires a schema-only baseline artifact', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-target-descriptor-'));
    expect(() => readSourceDescriptor(writeDescriptor(cwd, { schema_artifact: '' }), { cwd }))
      .toThrow(/schema-only baseline artifact/);
  });
});
