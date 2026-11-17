const {
  assertCommandDidNotTimeOut,
  runBoundedSyncCommand,
} = require('../bounded-sync-command');

function runGit(cwd, args = [], options = {}) {
  const result = runBoundedSyncCommand('git', args, {
    cwd,
    spawnSyncImpl: options.spawnSyncImpl,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  assertCommandDidNotTimeOut(result, `[workspace/docker-runtime] git ${args[0] || 'metadata'} probe`);
  if (!result.ok) return { ok: false, value: '', failure_kind: result.failure_kind };
  return { ok: true, value: String(result.stdout || '').trim() };
}

function resolveGitMetadata(cwd = process.cwd(), options = {}) {
  const head = runGit(cwd, ['rev-parse', 'HEAD'], options);
  const tree = runGit(cwd, ['rev-parse', 'HEAD^{tree}'], options);
  const branch = runGit(cwd, ['branch', '--show-current'], options);
  const worktree = runGit(cwd, ['rev-parse', '--show-toplevel'], options);
  const status = runGit(cwd, ['status', '--porcelain'], options);
  const dirtyFiles = status.ok
    ? status.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length
    : null;
  return {
    git_head: head.ok ? head.value : '',
    git_tree: tree.ok ? tree.value : '',
    git_branch: branch.ok ? branch.value : '',
    git_worktree: worktree.ok ? worktree.value : '',
    git_status_clean: status.ok ? dirtyFiles === 0 : null,
    git_dirty_files_count: status.ok ? dirtyFiles : null,
  };
}

function gitMetadataFromEnv(env = process.env) {
  const dirtyCount = Number.parseInt(String(env.MASARX_GIT_DIRTY_FILES_COUNT || ''), 10);
  const cleanRaw = String(env.MASARX_GIT_STATUS_CLEAN || '').trim().toLowerCase();
  return {
    git_head: String(env.MASARX_GIT_HEAD || ''),
    git_tree: String(env.MASARX_GIT_TREE || ''),
    git_branch: String(env.MASARX_GIT_BRANCH || ''),
    git_worktree: String(env.MASARX_GIT_WORKTREE || ''),
    git_status_clean: cleanRaw ? cleanRaw === 'true' : null,
    git_dirty_files_count: Number.isFinite(dirtyCount) ? dirtyCount : null,
  };
}

function gitMetadataEnv(metadata = {}) {
  return {
    MASARX_GIT_HEAD: metadata.git_head || '',
    MASARX_GIT_TREE: metadata.git_tree || '',
    MASARX_GIT_BRANCH: metadata.git_branch || '',
    MASARX_GIT_WORKTREE: metadata.git_worktree || '',
    MASARX_GIT_STATUS_CLEAN: metadata.git_status_clean == null ? '' : String(metadata.git_status_clean),
    MASARX_GIT_DIRTY_FILES_COUNT: metadata.git_dirty_files_count == null ? '' : String(metadata.git_dirty_files_count),
  };
}

module.exports = {
  gitMetadataEnv,
  gitMetadataFromEnv,
  runGit,
  resolveGitMetadata,
};
