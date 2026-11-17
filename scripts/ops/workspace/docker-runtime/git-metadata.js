const { spawnSync } = require('child_process');

function runGit(cwd, args = []) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return { ok: false, value: '' };
  return { ok: true, value: String(result.stdout || '').trim() };
}

function resolveGitMetadata(cwd = process.cwd()) {
  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  const branch = runGit(cwd, ['branch', '--show-current']);
  const worktree = runGit(cwd, ['rev-parse', '--show-toplevel']);
  const status = runGit(cwd, ['status', '--porcelain']);
  const dirtyFiles = status.ok
    ? status.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length
    : null;
  return {
    git_head: head.ok ? head.value : '',
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
    git_branch: String(env.MASARX_GIT_BRANCH || ''),
    git_worktree: String(env.MASARX_GIT_WORKTREE || ''),
    git_status_clean: cleanRaw ? cleanRaw === 'true' : null,
    git_dirty_files_count: Number.isFinite(dirtyCount) ? dirtyCount : null,
  };
}

function gitMetadataEnv(metadata = {}) {
  return {
    MASARX_GIT_HEAD: metadata.git_head || '',
    MASARX_GIT_BRANCH: metadata.git_branch || '',
    MASARX_GIT_WORKTREE: metadata.git_worktree || '',
    MASARX_GIT_STATUS_CLEAN: metadata.git_status_clean == null ? '' : String(metadata.git_status_clean),
    MASARX_GIT_DIRTY_FILES_COUNT: metadata.git_dirty_files_count == null ? '' : String(metadata.git_dirty_files_count),
  };
}

module.exports = {
  gitMetadataEnv,
  gitMetadataFromEnv,
  resolveGitMetadata,
};
