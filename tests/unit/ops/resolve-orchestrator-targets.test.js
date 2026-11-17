const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTargets } = require('../../../scripts/ops/ci/resolve-orchestrator-targets');
const { loadDeploySurfaceRegistry } = require('../../../scripts/ops/ci/deploy-surface-registry');

describe('resolve-orchestrator-targets', () => {
  let workflowRoot;
  beforeAll(() => {
    workflowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-contract-'));
    const directory = path.join(workflowRoot, '.github', 'workflows');
    fs.mkdirSync(directory, { recursive: true });
    const { registry } = loadDeploySurfaceRegistry({});
    const inputsByFile = new Map();
    for (const surface of registry.surfaces) {
      const entrypoint = surface.deploy?.entrypoint;
      for (const [stage, file] of Object.entries(entrypoint?.workflow_file_by_stage || {})) {
        if (!file) continue;
        const inputs = inputsByFile.get(file) || new Set(['ref']);
        for (const key of Object.keys(entrypoint.workflow_dispatch_inputs_by_stage?.[stage] || {})) inputs.add(key);
        inputsByFile.set(file, inputs);
      }
    }
    for (const [file, inputs] of inputsByFile) {
      fs.writeFileSync(path.join(directory, file), [
        'name: Synthetic dispatch', 'on:', '  workflow_dispatch:', '    inputs:',
        ...[...inputs].map(key => `      ${key}:\n        type: string`), 'jobs: {}', '',
      ].join('\n'));
    }
  });
  afterAll(() => fs.rmSync(workflowRoot, { recursive: true, force: true }));

  test('resolves dev targets from registry without approval environments', () => {
    const out = resolveTargets({
      stage: 'dev',
      sha: 'abc1234',
      surfacesCsv: 'console,db',
      configPath: '',
      workflowRoot,
    });

    expect(out.skip).toBe('0');
    expect(out.approval_mode).toBe('none');
    expect(out.commit_approval_env).toBe('');
    expect(out.surface_ids).toBe('console,db');

    const targets = JSON.parse(out.targets_json);
    expect(targets).toHaveLength(2);

    const consoleTarget = targets.find((t) => t.surface_id === 'console');
    expect(consoleTarget).toBeTruthy();
    expect(consoleTarget.workflow_id).toBe('deploy-console.yml');
    expect(consoleTarget.approval_env_surface).toBe('');
    expect(JSON.parse(consoleTarget.dispatch_inputs_json)).toEqual({
      environment: 'dev',
      ref: 'abc1234',
    });

    const dbTarget = targets.find((t) => t.surface_id === 'db');
    expect(dbTarget).toBeTruthy();
    expect(dbTarget.workflow_id).toBe('deploy-dev.yml');
    expect(JSON.parse(dbTarget.dispatch_inputs_json)).toEqual({
      ref: 'abc1234',
    });
  });

  test('splits same-stage dependent targets into a second dispatch wave', () => {
    const out = resolveTargets({
      stage: 'dev',
      sha: 'abc1234',
      surfacesCsv: 'mobile_fieldops,db,console',
      configPath: '',
      workflowRoot,
    });

    expect(out.skip).toBe('0');
    expect(out.has_dependent_targets).toBe('1');
    expect(out.primary_targets_count).toBe('2');
    expect(out.dependent_targets_count).toBe('1');

    const primaryTargets = JSON.parse(out.primary_targets_json);
    const dependentTargets = JSON.parse(out.dependent_targets_json);
    expect(primaryTargets.map((target) => target.surface_id).sort()).toEqual(['console', 'db']);
    expect(dependentTargets.map((target) => target.surface_id)).toEqual(['mobile_fieldops']);
    expect(dependentTargets[0].dependency_surface_ids).toEqual(['db']);
  });

  test('resolves stg targets from registry without approval environments', () => {
    const out = resolveTargets({
      stage: 'stg',
      sha: 'abc1234',
      surfacesCsv: 'console,db',
      configPath: '',
      workflowRoot,
    });

    expect(out.skip).toBe('0');
    expect(out.approval_mode).toBe('none');
    expect(out.commit_approval_env).toBe('');
    expect(out.surface_ids).toBe('console,db');

    const targets = JSON.parse(out.targets_json);
    expect(targets).toHaveLength(2);

    const consoleTarget = targets.find((t) => t.surface_id === 'console');
    expect(consoleTarget).toBeTruthy();
    expect(consoleTarget.workflow_id).toBe('deploy-console.yml');
    expect(consoleTarget.approval_env_surface).toBe('');
    const consoleInputs = JSON.parse(consoleTarget.dispatch_inputs_json);
    expect(consoleInputs).toEqual({
      environment: 'stg',
      skip_approval: 'true',
      ref: 'abc1234',
    });

    const dbTarget = targets.find((t) => t.surface_id === 'db');
    expect(dbTarget).toBeTruthy();
    expect(dbTarget.workflow_id).toBe('deploy-stg-promote.yml');
    const dbInputs = JSON.parse(dbTarget.dispatch_inputs_json);
    expect(dbInputs).toEqual({
      ref: 'abc1234',
    });
  });

  test('resolves prod docs target from registry', () => {
    const out = resolveTargets({
      stage: 'prod',
      sha: 'def5678',
      surfacesCsv: 'docs',
      configPath: '',
      workflowRoot,
    });

    expect(out.skip).toBe('0');
    expect(out.approval_mode).toBe('surface');
    expect(out.commit_approval_env).toBe('');
    const targets = JSON.parse(out.targets_json);
    expect(targets).toHaveLength(1);

    const t = targets[0];
    expect(t.surface_id).toBe('docs');
    expect(t.workflow_id).toBe('publish-public-docs.yml');
    expect(t.approval_env_surface).toBe('prod-approval-docs');
    expect(JSON.parse(t.dispatch_inputs_json)).toEqual({
      skip_approval: 'true',
      ref: 'def5678',
    });
  });

  test('fails closed for unknown surfaces', () => {
    expect(() => resolveTargets({
      stage: 'stg',
      sha: 'abc1234',
      surfacesCsv: 'unknown_surface',
      configPath: '',
      workflowRoot,
    })).toThrow('Unknown surface_id');
  });

  test('fails closed when registry dispatch inputs are not declared by target workflow', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-orchestrator-targets-'));
    const workflowsDir = path.join(tempRoot, '.github', 'workflows');
    const configPath = path.join(tempRoot, 'deploy-surfaces.json');
    const { registry } = loadDeploySurfaceRegistry({});

    try {
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowsDir, 'deploy-stg-promote.yml'),
        [
          'name: Deploy (Stg)',
          'on:',
          '  workflow_dispatch:',
          '    inputs:',
          '      ref:',
          '        required: false',
          '        type: string',
          'jobs:',
          '  noop:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: echo ok',
          '',
        ].join('\n'),
        'utf8',
      );

      fs.writeFileSync(
        configPath,
        (() => {
          const mutated = JSON.parse(JSON.stringify(registry));
          const dbSurface = mutated.surfaces.find((surface) => surface.surface_id === 'db');
          dbSurface.deploy.entrypoint.workflow_file_by_stage.stg = 'deploy-stg-promote.yml';
          dbSurface.deploy.entrypoint.workflow_dispatch_inputs_by_stage.stg = {
            skip_approval: 'true',
          };
          return JSON.stringify(mutated, null, 2);
        })(),
        'utf8',
      );

      expect(() =>
        resolveTargets({
          stage: 'stg',
          sha: 'abc1234',
          surfacesCsv: 'db',
          configPath,
          workflowRoot: tempRoot,
        }),
      ).toThrow('does not declare workflow_dispatch input');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
