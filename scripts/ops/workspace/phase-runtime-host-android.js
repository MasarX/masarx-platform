const fs = require('fs');
const path = require('path');
const { redactRuntimeOutput } = require('./docker-runtime/redaction');

const DEFAULT_DEVICE_PORT = 8081;

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepSync(ms) {
  const duration = parsePositiveInteger(ms, 0);
  if (duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function jsonFromCommand(result = {}) {
  try {
    return JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function redactCommandText(value) {
  return redactRuntimeOutput(String(value || '')).slice(0, 1200);
}

function summarizeCommandResult(result = {}) {
  return {
    ok: result.ok === true,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: redactCommandText(result.stdout),
    stderr: redactCommandText(result.stderr),
  };
}

function summarizeCommandResults(results = {}) {
  return Object.fromEntries(
    Object.entries(results || {}).map(([key, result]) => [key, summarizeCommandResult(result)]),
  );
}

function commandFailedPayload(status, reason, commandResult = {}, extra = {}) {
  return {
    requested: true,
    status,
    reason,
    setup_status: status,
    proof_status: 'skipped',
    mobile_v2_development_runtime_proof: extra.mobile_v2_development_runtime_proof !== undefined
      ? extra.mobile_v2_development_runtime_proof
      : true,
    native_mobile_v2_host_emulator_proof: false,
    command_results: {
      [reason]: summarizeCommandResult(commandResult),
    },
    cleanup_status: 'not_started',
    cleanup_results: {},
    default_parallel_lane_proof_unchanged: true,
    routine_matrix_requires_emulator: false,
    ...extra,
  };
}

function proofGate(args = {}, names = []) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      return isTruthy(firstValue(args[name]));
    }
  }
  return false;
}

function proofEvidence(args = {}, names = []) {
  for (const name of names) {
    const value = String(firstValue(args[name]) || '').trim();
    if (value) return value;
  }
  return '';
}

function buildHostAndroidProofGates(args = {}) {
  return {
    mobile_v2_policy_enabled: proofGate(args, [
      'mobile-v2-policy-enabled',
      'mobile_v2_policy_enabled',
      'v2-enabled',
      'v2_enabled',
    ]),
    backend_readback: proofGate(args, [
      'backend-api-context',
      'backend_api_context',
      'backend-readback',
      'backend_readback',
      'api-rpc-readback',
      'api_rpc_readback',
    ]),
    native_mobile_v2_visible: proofGate(args, [
      'native-mobile-v2-visible',
      'native_mobile_v2_visible',
      'visible-native-mobile-v2',
      'visible_native_mobile_v2',
      'mobile-v2-visible',
      'mobile_v2_visible',
    ]),
    device_readback: proofGate(args, [
      'device-readback',
      'device_readback',
      'same-context-device-readback',
      'same_context_device_readback',
    ]),
    policy_evidence: proofEvidence(args, ['policy-evidence', 'policy_evidence']),
    backend_evidence: proofEvidence(args, [
      'backend-evidence',
      'backend_evidence',
      'backend-readback-evidence',
      'backend_readback_evidence',
    ]),
    native_evidence: proofEvidence(args, ['native-evidence', 'native_evidence']),
    device_evidence: proofEvidence(args, [
      'device-evidence',
      'device_evidence',
      'device-readback-evidence',
      'device_readback_evidence',
    ]),
  };
}

function allProofGatesSatisfied(gates = {}) {
  return Boolean(
    gates.mobile_v2_policy_enabled &&
      gates.backend_readback &&
      gates.native_mobile_v2_visible &&
      gates.device_readback,
  );
}

function allProofEvidenceSatisfied(gates = {}) {
  return Boolean(
    gates.policy_evidence &&
      gates.backend_evidence &&
      gates.native_evidence &&
      gates.device_evidence,
  );
}

function buildHostAndroidCommands(plan = {}) {
  const owner = plan.owner || '<owner>';
  const workspace = plan.workspace_id || '<workspace>';
  const avd = plan.android_avd_name || '<avd-name>';
  const serial = '<adb-serial>';
  const hostPort = '<fieldops-metro-port>';
  const devicePort = plan.android_device_port || DEFAULT_DEVICE_PORT;
  const bootTimeoutMs = parsePositiveInteger(plan.android_boot_timeout_ms, 0);
  const bootTimeoutArg = bootTimeoutMs ? ` --boot-timeout-ms ${bootTimeoutMs}` : '';
  const session = `${workspace}-native-mobile-v2`;
  return {
    allocate: `npm run android:emulator:allocate -- --owner ${owner} --avd ${avd} --start${bootTimeoutArg} --json`,
    heartbeat: `npm run android:emulator:heartbeat -- --owner ${owner} --serial ${serial} --json`,
    acquire_emulator_lease: `npm run runtime:leases:acquire -- --resource android-emulator --owner ${owner} --serial ${serial} --phase native-mobile-v2-host --json`,
    reverse: `npm run android:emulator:reverse -- --owner ${owner} --serial ${serial} --host-port ${hostPort} --device-port ${devicePort} --json`,
    acquire_reverse_lease: `npm run runtime:leases:acquire -- --resource adb-reverse --owner ${owner} --serial ${serial} --host-port ${hostPort} --device-port ${devicePort} --phase native-mobile-v2-host --json`,
    acquire_native_proof_slot: `npm run runtime:leases:acquire -- --resource fieldops-mobile-v2-proof --owner ${owner} --session ${session} --serial ${serial} --metro-port ${hostPort} --device-port ${devicePort} --mobile-v2-policy-enabled true --backend-api-context true --native-mobile-v2-visible true --device-readback true --policy-evidence <policy-evidence-json> --backend-evidence <backend-readback-json> --native-evidence <native-v2-visible-artifact> --device-evidence <same-device-readback-artifact> --json`,
  };
}

function buildHostAndroidPlan(plan = {}, args = {}) {
  const requested = Boolean(plan.host_android_emulator_requested);
  const proofGates = buildHostAndroidProofGates(args);
  const validation = validateHostAndroidPlan({ ...plan, native_mobile_v2_host_proof_gates: proofGates });
  return {
    requested,
    status: requested ? (validation.ok ? 'planned' : 'blocked') : 'skipped',
    reason: validation.ok ? '' : validation.reason,
    proof_tier: 'native_mobile_v2_host_emulator_proof',
    fieldops_service_name: 'fieldops-metro',
    native_proof_resource: 'fieldops-mobile-v2-proof',
    mobile_v2_development_runtime_proof_required: true,
    mobile_v2_development_runtime_proof: plan.mobile_v2_web_requested === true,
    native_mobile_v2_host_emulator_proof: false,
    default_parallel_lane_proof_unchanged: true,
    routine_matrix_requires_emulator: false,
    android_avd_name: plan.android_avd_name || '',
    android_device_port: plan.android_device_port || DEFAULT_DEVICE_PORT,
    android_boot_timeout_ms: parsePositiveInteger(plan.android_boot_timeout_ms, 0),
    keep_host_emulator: Boolean(plan.keep_host_emulator),
    proof_gates: proofGates,
    proof_gates_satisfied: allProofGatesSatisfied(proofGates),
    evidence_required: requested,
    proof_evidence_satisfied: allProofEvidenceSatisfied(proofGates),
    commands: requested ? buildHostAndroidCommands(plan) : {},
  };
}

function validateHostAndroidPlan(plan = {}) {
  if (!plan.host_android_emulator_requested) return { ok: true, reason: '' };
  if (plan.runtime_driver !== 'docker') {
    return { ok: false, reason: 'host_android_emulator_requires_docker_runtime_driver' };
  }
  if (!plan.mobile_v2_web_requested) {
    return { ok: false, reason: 'host_android_emulator_requires_mobile_v2_web' };
  }
  if (!String(plan.android_avd_name || '').trim()) {
    return { ok: false, reason: 'host_android_emulator_requires_avd' };
  }
  return { ok: true, reason: '' };
}

function hostAndroidStatePath(plan = {}) {
  const owner = String(plan.owner || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '-');
  const workspace = String(plan.workspace_id || 'workspace').replace(/[^A-Za-z0-9_.-]+/g, '-');
  return path.join(plan.cwd || process.cwd(), '.tmp', 'phase-runtime-bootstrap', owner, workspace, 'host-android-emulator-state.json');
}

function writeHostAndroidState(plan = {}, payload = {}) {
  const filePath = hostAndroidStatePath(plan);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function readHostAndroidState(plan = {}) {
  try {
    return JSON.parse(fs.readFileSync(hostAndroidStatePath(plan), 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function ownedLeasesFromDoctor(doctor = {}, owner = '') {
  return (doctor.status_snapshot?.leases || [])
    .filter((lease) => lease.owner === owner && !lease.expired);
}

function findOwnedFieldOpsMetroLease(doctor = {}, owner = '') {
  const leases = ownedLeasesFromDoctor(doctor, owner)
    .filter((lease) => lease.resource_class === 'fieldops-metro' && !lease.stale && !lease.runtime_missing);
  if (leases.length !== 1) {
    return {
      ok: false,
      reason: leases.length > 1
        ? 'multiple_owned_fieldops_metro_leases'
        : 'owned_fieldops_metro_lease_missing',
      leases,
    };
  }
  const port = parsePositiveInteger(leases[0].details?.port, 0);
  if (!port) return { ok: false, reason: 'owned_fieldops_metro_port_missing', leases };
  return { ok: true, lease: leases[0], port };
}

function runRequiredNodeScript(runNodeScript, scriptPath, args, options, key, commandResults) {
  const result = runNodeScript(scriptPath, args, options);
  commandResults[key] = summarizeCommandResult(result);
  return result;
}

function buildProofLeaseArgs(plan, serial, hostPort, gates) {
  const devicePort = plan.android_device_port || DEFAULT_DEVICE_PORT;
  const args = [
    'acquire',
    '--resource',
    'fieldops-mobile-v2-proof',
    '--owner',
    plan.owner,
    '--session',
    `${plan.workspace_id}-native-mobile-v2`,
    '--serial',
    serial,
    '--metro-port',
    String(hostPort),
    '--device-port',
    String(devicePort),
    '--mobile-v2-policy-enabled',
    'true',
    '--backend-api-context',
    'true',
    '--native-mobile-v2-visible',
    'true',
    '--device-readback',
    'true',
    '--worktree-id',
    plan.workspace_id,
    '--json',
  ];
  if (gates.policy_evidence) args.push('--policy-evidence', gates.policy_evidence);
  if (gates.backend_evidence) args.push('--backend-evidence', gates.backend_evidence);
  if (gates.native_evidence) args.push('--native-evidence', gates.native_evidence);
  if (gates.device_evidence) args.push('--device-evidence', gates.device_evidence);
  return args;
}

function runRollbackCommand(runNodeScript, scriptPath, args, commandOptions, key, cleanupResults) {
  try {
    const result = runNodeScript(scriptPath, args, commandOptions);
    cleanupResults[key] = summarizeCommandResult(result);
    return result;
  } catch (error) {
    cleanupResults[key] = {
      ok: false,
      status: null,
      stdout: '',
      stderr: redactCommandText(error?.message || String(error)),
    };
    return { ok: false, status: null, stdout: '', stderr: error?.message || String(error) };
  }
}

function releaseRuntimeLeaseForRollback(runNodeScript, plan, resource, extraArgs, commandOptions, key, cleanupResults) {
  return runRollbackCommand(
    runNodeScript,
    path.join('scripts', 'ops', 'runtime-leases.js'),
    ['release', '--resource', resource, '--owner', plan.owner, ...extraArgs, '--json'],
    commandOptions,
    key,
    cleanupResults,
  );
}

function rollbackHostAndroidSetup(plan = {}, state = {}, options = {}) {
  const runNodeScript = options.runNodeScript;
  const commandOptions = options.commandOptions || {};
  const cleanupResults = {};
  const preserved = [];
  if (typeof runNodeScript !== 'function') {
    return {
      cleanup_status: 'blocked',
      reason: 'host_android_runner_missing_for_cleanup',
      cleanup_results: cleanupResults,
      preserved,
    };
  }

  const serial = String(state.serial || '').trim();
  const hostPort = parsePositiveInteger(state.host_port, 0);
  const devicePort = parsePositiveInteger(state.device_port, plan.android_device_port || DEFAULT_DEVICE_PORT);
  const session = state.proof_session || `${plan.workspace_id}-native-mobile-v2`;
  const preserveEmulator = Boolean(plan.keep_host_emulator);

  if (state.proof_lease_acquired) {
    releaseRuntimeLeaseForRollback(
      runNodeScript,
      plan,
      'fieldops-mobile-v2-proof',
      ['--session', session],
      commandOptions,
      'release_fieldops_mobile_v2_proof',
      cleanupResults,
    );
  }

  if (state.reverse_applied && serial && hostPort) {
    runRollbackCommand(
      runNodeScript,
      path.join('scripts', 'ops', 'android-emulator-capacity.js'),
      ['reverse-remove', '--owner', plan.owner, '--serial', serial, '--host-port', String(hostPort), '--device-port', String(devicePort), '--json'],
      commandOptions,
      'reverse_remove',
      cleanupResults,
    );
  }

  if (state.reverse_runtime_lease_acquired && serial && hostPort) {
    releaseRuntimeLeaseForRollback(
      runNodeScript,
      plan,
      'adb-reverse',
      ['--serial', serial, '--host-port', String(hostPort), '--device-port', String(devicePort)],
      commandOptions,
      'release_adb_reverse',
      cleanupResults,
    );
  }

  if (preserveEmulator) {
    if (state.runtime_android_lease_acquired || state.capacity_allocated) {
      preserved.push({
        serial,
        avd_name: state.avd_name || plan.android_avd_name || '',
        runtime_android_lease_preserved: Boolean(state.runtime_android_lease_acquired),
        capacity_lease_preserved: Boolean(state.capacity_allocated),
        reason: 'keep_host_emulator_requested',
      });
      if (state.runtime_android_lease_acquired && serial) {
        runRollbackCommand(
          runNodeScript,
          path.join('scripts', 'ops', 'android-emulator-capacity.js'),
          ['heartbeat', '--owner', plan.owner, '--serial', serial, '--json'],
          commandOptions,
          'preserve_emulator_heartbeat',
          cleanupResults,
        );
      }
    }
  } else if (serial) {
    if (state.capacity_allocated) {
      const releaseArgs = ['release', '--owner', plan.owner, '--serial', serial];
      if (state.started_by_lane) releaseArgs.push('--stop');
      releaseArgs.push('--json');
      runRollbackCommand(
        runNodeScript,
        path.join('scripts', 'ops', 'android-emulator-capacity.js'),
        releaseArgs,
        commandOptions,
        'release_emulator_capacity',
        cleanupResults,
      );
      if (state.started_by_lane) {
        waitForAndroidSerialDetached(
          runNodeScript,
          plan,
          serial,
          commandOptions,
          'wait_emulator_detached',
          cleanupResults,
          {
            timeoutMs: options.hostAndroidStopWaitMs,
            intervalMs: options.hostAndroidStopPollMs,
          },
        );
      }
    }
    if (state.runtime_android_lease_acquired) {
      releaseRuntimeLeaseForRollback(
        runNodeScript,
        plan,
        'android-emulator',
        ['--serial', serial],
        commandOptions,
        'release_android_emulator_runtime',
        cleanupResults,
      );
    }
  }

  const failed = Object.values(cleanupResults).filter((result) => result && result.ok === false);
  return {
    cleanup_status: failed.length ? 'partial' : 'completed',
    cleanup_results: cleanupResults,
    preserved,
  };
}

function failedWithRollbackPayload(reason, commandResult, plan, setupState, commandOptions, commandResults, options = {}) {
  const rollback = rollbackHostAndroidSetup(plan, setupState, {
    runNodeScript: options.runNodeScript,
    commandOptions,
  });
  return commandFailedPayload('failed', reason, commandResult, {
    serial: setupState.serial || '',
    android_emulator_serial: setupState.serial || '',
    android_avd_name: setupState.avd_name || plan.android_avd_name || '',
    android_emulator_started_by_lane: Boolean(setupState.started_by_lane),
    adb_reverse: setupState.host_port
      ? {
        host_port: setupState.host_port,
        device_port: setupState.device_port || plan.android_device_port || DEFAULT_DEVICE_PORT,
        serial: setupState.serial || '',
      }
      : null,
    command_results: summarizeCommandResults(commandResults),
    cleanup_status: rollback.cleanup_status,
    cleanup_results: rollback.cleanup_results,
    cleanup_preserved: rollback.preserved,
  });
}

function configureHostAndroidEmulator(plan = {}, options = {}) {
  if (!plan.host_android_emulator_requested) {
    return buildHostAndroidPlan(plan, options.args || {});
  }
  const validation = validateHostAndroidPlan(plan);
  if (!validation.ok) {
    return {
      ...buildHostAndroidPlan(plan, options.args || {}),
      status: 'blocked',
      setup_status: 'blocked',
      proof_status: 'skipped',
      reason: validation.reason,
    };
  }

  const runNodeScript = options.runNodeScript;
  if (typeof runNodeScript !== 'function') {
    return {
      ...buildHostAndroidPlan(plan, options.args || {}),
      status: 'failed',
      setup_status: 'failed',
      proof_status: 'skipped',
      reason: 'host_android_runner_missing',
    };
  }

  const commandOptions = {
    cwd: plan.cwd,
    commandRunner: options.commandRunner,
    timeoutMs: options.hostAndroidTimeoutMs || 10 * 60 * 1000,
  };
  const commandResults = {};
  const setupState = {
    owner: plan.owner,
    workspace_id: plan.workspace_id,
    serial: '',
    avd_name: plan.android_avd_name || '',
    device_port: plan.android_device_port || DEFAULT_DEVICE_PORT,
    capacity_allocated: false,
    started_by_lane: false,
    runtime_android_lease_acquired: false,
    heartbeat_done: false,
    host_port: 0,
    reverse_applied: false,
    reverse_runtime_lease_acquired: false,
    proof_lease_acquired: false,
    proof_session: `${plan.workspace_id}-native-mobile-v2`,
  };
  const allocate = runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'android-emulator-capacity.js'),
    [
      'allocate',
      '--owner',
      plan.owner,
      '--avd',
      plan.android_avd_name,
      '--start',
      ...(parsePositiveInteger(plan.android_boot_timeout_ms, 0)
        ? ['--boot-timeout-ms', String(parsePositiveInteger(plan.android_boot_timeout_ms, 0))]
        : []),
      '--json',
    ],
    commandOptions,
    'allocate',
    commandResults,
  );
  if (!allocate.ok) {
    return commandFailedPayload('failed', 'android_emulator_allocate_failed', allocate, {
      android_avd_name: plan.android_avd_name,
    });
  }
  const allocated = jsonFromCommand(allocate) || {};
  const serial = String(allocated.serial || allocated.lease?.serial || '').trim();
  if (!serial) {
    return failedWithRollbackPayload(
      'android_emulator_serial_missing',
      allocate,
      plan,
      { ...setupState, capacity_allocated: true },
      commandOptions,
      commandResults,
      { runNodeScript },
    );
  }
  const startedByLane = String(allocated.status || '') === 'started';
  setupState.serial = serial;
  setupState.avd_name = String(allocated.avd_name || plan.android_avd_name || '');
  setupState.capacity_allocated = true;
  setupState.started_by_lane = startedByLane;
  const runtimeAndroidLease = runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'runtime-leases.js'),
    ['acquire', '--resource', 'android-emulator', '--owner', plan.owner, '--serial', serial, '--phase', 'native-mobile-v2-host', '--json'],
    commandOptions,
    'acquire_android_emulator_lease',
    commandResults,
  );
  if (!runtimeAndroidLease.ok) {
    return failedWithRollbackPayload(
      'android_emulator_runtime_lease_failed',
      runtimeAndroidLease,
      plan,
      setupState,
      commandOptions,
      commandResults,
      { runNodeScript },
    );
  }
  setupState.runtime_android_lease_acquired = true;
  const heartbeat = runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'android-emulator-capacity.js'),
    ['heartbeat', '--owner', plan.owner, '--serial', serial, '--json'],
    commandOptions,
    'heartbeat',
    commandResults,
  );
  if (!heartbeat.ok) {
    return failedWithRollbackPayload(
      'android_emulator_heartbeat_failed',
      heartbeat,
      plan,
      setupState,
      commandOptions,
      commandResults,
      { runNodeScript },
    );
  }
  setupState.heartbeat_done = true;
  const doctor = options.doctorBuilder(options.policy, {
    cwd: plan.cwd,
    'include-health': '1',
    'include-docker': '1',
  });
  const metro = findOwnedFieldOpsMetroLease(doctor, plan.owner);
  if (!metro.ok) {
    return failedWithRollbackPayload(
      metro.reason,
      {},
      plan,
      setupState,
      commandOptions,
      commandResults,
      { runNodeScript },
    );
  }
  const hostPort = metro.port;
  const devicePort = plan.android_device_port || DEFAULT_DEVICE_PORT;
  setupState.host_port = hostPort;
  setupState.device_port = devicePort;
  const reverse = runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'android-emulator-capacity.js'),
    ['reverse', '--owner', plan.owner, '--serial', serial, '--host-port', String(hostPort), '--device-port', String(devicePort), '--json'],
    commandOptions,
    'reverse',
    commandResults,
  );
  if (!reverse.ok) {
    return failedWithRollbackPayload(
      'adb_reverse_setup_failed',
      reverse,
      plan,
      setupState,
      commandOptions,
      commandResults,
      { runNodeScript },
    );
  }
  setupState.reverse_applied = true;
  const reverseLease = runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'runtime-leases.js'),
    [
      'acquire',
      '--resource',
      'adb-reverse',
      '--owner',
      plan.owner,
      '--serial',
      serial,
      '--host-port',
      String(hostPort),
      '--device-port',
      String(devicePort),
      '--phase',
      'native-mobile-v2-host',
      '--json',
    ],
    commandOptions,
    'acquire_adb_reverse_lease',
    commandResults,
  );
  if (!reverseLease.ok) {
    return failedWithRollbackPayload(
      'adb_reverse_runtime_lease_failed',
      reverseLease,
      plan,
      setupState,
      commandOptions,
      commandResults,
      { runNodeScript },
    );
  }
  setupState.reverse_runtime_lease_acquired = true;

  const gates = plan.native_mobile_v2_host_proof_gates || buildHostAndroidProofGates(options.args || {});
  const proofGatesSatisfied = allProofGatesSatisfied(gates);
  const proofEvidenceSatisfied = allProofEvidenceSatisfied(gates);
  const setup = {
    requested: true,
    status: 'blocked',
    reason: proofGatesSatisfied
      ? 'native_mobile_v2_evidence_artifacts_missing'
      : 'native_mobile_v2_evidence_gates_missing',
    setup_status: 'passed',
    proof_status: 'blocked',
    proof_tier: 'native_mobile_v2_host_emulator_proof',
    fieldops_service_name: 'fieldops-metro',
    native_proof_resource: 'fieldops-mobile-v2-proof',
    mobile_v2_development_runtime_proof: true,
    native_mobile_v2_host_emulator_proof: false,
    android_emulator_serial: serial,
    android_avd_name: String(allocated.avd_name || plan.android_avd_name || ''),
    android_allocation_status: String(allocated.status || ''),
    android_emulator_started_by_lane: startedByLane,
    adb_reverse: {
      host_port: hostPort,
      device_port: devicePort,
      serial,
    },
    fieldops_mobile_v2_proof_lease_id: '',
    native_mobile_v2_visible: gates.native_mobile_v2_visible === true,
    backend_readback: gates.backend_readback === true ? 'passed' : 'failed',
    default_parallel_lane_proof_unchanged: true,
    routine_matrix_requires_emulator: false,
    proof_gates: gates,
    proof_gates_satisfied: proofGatesSatisfied,
    evidence_required: true,
    proof_evidence_satisfied: proofEvidenceSatisfied,
    command_results: commandResults,
    cleanup_status: 'not_required',
    cleanup_results: {},
  };

  const statePath = writeHostAndroidState(plan, {
    generated_at: new Date().toISOString(),
    owner: plan.owner,
    workspace_id: plan.workspace_id,
    serial,
    avd_name: setup.android_avd_name,
    host_port: hostPort,
    device_port: devicePort,
    started_by_lane: startedByLane,
    allocation_status: setup.android_allocation_status,
  });
  setup.state_path = statePath;

  if (!setup.proof_gates_satisfied || !setup.proof_evidence_satisfied) return setup;

  const proofLease = runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'runtime-leases.js'),
    buildProofLeaseArgs(plan, serial, hostPort, gates),
    commandOptions,
    'acquire_fieldops_mobile_v2_proof',
    commandResults,
  );
  if (!proofLease.ok) {
    const rollback = rollbackHostAndroidSetup(plan, setupState, { runNodeScript, commandOptions });
    return {
      ...setup,
      status: 'failed',
      proof_status: 'failed',
      reason: 'fieldops_mobile_v2_proof_lease_failed',
      command_results: commandResults,
      cleanup_status: rollback.cleanup_status,
      cleanup_results: rollback.cleanup_results,
      cleanup_preserved: rollback.preserved,
    };
  }
  const proofPayload = jsonFromCommand(proofLease) || {};
  setupState.proof_lease_acquired = true;
  return {
    ...setup,
    status: 'passed',
    reason: '',
    proof_status: 'passed',
    native_mobile_v2_host_emulator_proof: true,
    fieldops_mobile_v2_proof_lease_id: String(proofPayload.lease?.id || ''),
    command_results: commandResults,
  };
}

function releaseRuntimeLeaseCommand(runNodeScript, plan, resource, extraArgs, commandOptions, key, commandResults) {
  return runRequiredNodeScript(
    runNodeScript,
    path.join('scripts', 'ops', 'runtime-leases.js'),
    ['release', '--resource', resource, '--owner', plan.owner, ...extraArgs, '--json'],
    commandOptions,
    key,
    commandResults,
  );
}

function waitForAndroidSerialDetached(runNodeScript, plan, serial, commandOptions, key, commandResults, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 30000);
  const intervalMs = parsePositiveInteger(options.intervalMs, 2000);
  const startedAt = Date.now();
  let attempts = 0;
  let lastResult = null;
  while ((Date.now() - startedAt) <= timeoutMs) {
    attempts += 1;
    lastResult = runNodeScript(
      path.join('scripts', 'ops', 'android-emulator-capacity.js'),
      ['inventory', '--json'],
      commandOptions,
    );
    const inventory = jsonFromCommand(lastResult);
    const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
    const stillAttached = devices.some((device) => String(device.serial || '').trim() === serial);
    if (lastResult?.ok === true && !stillAttached) {
      commandResults[key] = {
        ok: true,
        status: lastResult.status ?? 0,
        stdout: redactCommandText(JSON.stringify({
          status: 'detached',
          serial,
          attempts,
          elapsed_ms: Date.now() - startedAt,
        })),
        stderr: '',
      };
      return true;
    }
    sleepSync(intervalMs);
  }
  commandResults[key] = {
    ok: false,
    status: lastResult?.status ?? null,
    stdout: redactCommandText(JSON.stringify({
      status: 'still_attached',
      serial,
      attempts,
      elapsed_ms: Date.now() - startedAt,
    })),
    stderr: redactCommandText(lastResult?.stderr || `Timed out waiting for ${serial} to detach from adb.`),
  };
  return false;
}

function stopHostAndroidEmulator(plan = {}, options = {}) {
  if (!plan.host_android_emulator_requested) {
    return {
      requested: false,
      status: 'skipped',
      default_parallel_lane_proof_unchanged: true,
      routine_matrix_requires_emulator: false,
    };
  }
  const runNodeScript = options.runNodeScript;
  const doctor = options.doctorBuilder(options.policy, {
    cwd: plan.cwd,
    'include-health': '1',
    'include-docker': '1',
  });
  const owned = ownedLeasesFromDoctor(doctor, plan.owner);
  const commandOptions = {
    cwd: plan.cwd,
    commandRunner: options.commandRunner,
    timeoutMs: options.hostAndroidTimeoutMs || 10 * 60 * 1000,
  };
  const commandResults = {};
  const state = readHostAndroidState(plan) || {};
  const proofLeases = owned.filter((lease) => lease.resource_class === 'fieldops-mobile-v2-proof');
  const reverseLeases = owned.filter((lease) => lease.resource_class === 'adb-reverse');
  const emulatorLeases = owned.filter((lease) => lease.resource_class === 'android-emulator');

  for (const lease of proofLeases) {
    releaseRuntimeLeaseCommand(
      runNodeScript,
      plan,
      'fieldops-mobile-v2-proof',
      ['--session', lease.details?.session || `${plan.workspace_id}-native-mobile-v2`],
      commandOptions,
      `release_proof_${lease.id}`,
      commandResults,
    );
  }
  for (const lease of reverseLeases) {
    const serial = String(lease.details?.serial || '').trim();
    const hostPort = parsePositiveInteger(lease.details?.host_port, 0);
    const devicePort = parsePositiveInteger(lease.details?.device_port, DEFAULT_DEVICE_PORT);
    if (serial && hostPort) {
      runRequiredNodeScript(
        runNodeScript,
        path.join('scripts', 'ops', 'android-emulator-capacity.js'),
        ['reverse-remove', '--owner', plan.owner, '--serial', serial, '--host-port', String(hostPort), '--device-port', String(devicePort), '--json'],
        commandOptions,
        `reverse_remove_${lease.id}`,
        commandResults,
      );
    }
    releaseRuntimeLeaseCommand(
      runNodeScript,
      plan,
      'adb-reverse',
      ['--serial', serial, '--host-port', String(hostPort), '--device-port', String(devicePort)],
      commandOptions,
      `release_reverse_${lease.id}`,
      commandResults,
    );
  }

  const preserved = [];
  if (plan.keep_host_emulator) {
    for (const lease of emulatorLeases) {
      preserved.push({
        lease_id: lease.id,
        serial: lease.details?.serial || '',
        reason: 'keep_host_emulator_requested',
      });
      if (lease.details?.serial) {
        runRequiredNodeScript(
          runNodeScript,
          path.join('scripts', 'ops', 'android-emulator-capacity.js'),
          ['heartbeat', '--owner', plan.owner, '--serial', String(lease.details.serial), '--json'],
          commandOptions,
          `preserve_emulator_heartbeat_${lease.id}`,
          commandResults,
        );
      }
    }
  } else {
    for (const lease of emulatorLeases) {
      const serial = String(lease.details?.serial || '').trim();
      if (serial) {
        const releaseArgs = ['release', '--owner', plan.owner, '--serial', serial];
        releaseArgs.push('--stop');
        releaseArgs.push('--json');
        runRequiredNodeScript(
          runNodeScript,
          path.join('scripts', 'ops', 'android-emulator-capacity.js'),
          releaseArgs,
          commandOptions,
          `release_emulator_capacity_${lease.id}`,
          commandResults,
        );
        waitForAndroidSerialDetached(
          runNodeScript,
          plan,
          serial,
          commandOptions,
          `wait_emulator_detached_${lease.id}`,
          commandResults,
          {
            timeoutMs: options.hostAndroidStopWaitMs,
            intervalMs: options.hostAndroidStopPollMs,
          },
        );
      }
      releaseRuntimeLeaseCommand(
        runNodeScript,
        plan,
        'android-emulator',
        ['--serial', serial],
        commandOptions,
        `release_emulator_runtime_${lease.id}`,
        commandResults,
      );
    }
  }

  const failed = Object.values(commandResults).filter((result) => result && result.ok === false);
  return {
    requested: true,
    status: failed.length ? 'blocked' : 'stopped',
    reason: failed.length ? 'host_android_emulator_cleanup_failed' : '',
    proof_leases: proofLeases.length,
    adb_reverse_leases: reverseLeases.length,
    android_emulator_leases: emulatorLeases.length,
    preserved,
    keep_host_emulator: Boolean(plan.keep_host_emulator),
    command_results: commandResults,
    default_parallel_lane_proof_unchanged: true,
    routine_matrix_requires_emulator: false,
  };
}

module.exports = {
  DEFAULT_DEVICE_PORT,
  allProofGatesSatisfied,
  allProofEvidenceSatisfied,
  buildHostAndroidCommands,
  buildHostAndroidPlan,
  buildHostAndroidProofGates,
  configureHostAndroidEmulator,
  findOwnedFieldOpsMetroLease,
  hostAndroidStatePath,
  rollbackHostAndroidSetup,
  stopHostAndroidEmulator,
  validateHostAndroidPlan,
};
