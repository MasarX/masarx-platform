import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fchmodSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const message = Symbol('safe error message');

function requireOutput(condition, reason) {
  if (!condition) throw { [message]: reason };
}

function inRepo(root, location) {
  const path = relative(root, location);
  return !isAbsolute(path) && path.split(sep)[0] !== '..';
}

function restrictWindowsAcl(path) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $env:SWEEP_OUTPUT_PATH -AclObject $acl
  `], {
    env: { ...process.env, SWEEP_OUTPUT_PATH: path }, windowsHide: true, stdio: 'ignore', timeout: 15_000,
  });
  requireOutput(result.status === 0, 'Could not restrict the output file ACL.');
}

function saveCredentials(path, plaintext) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    try {
      if (process.platform === 'win32') restrictWindowsAcl(path);
      else fchmodSync(fd, 0o600);
      writeFileSync(fd, plaintext);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  } finally {
    plaintext.fill(0);
  }
}

function main() {
  const { values: { run, key, out } } = parseArgs({
    options: { run: { type: 'string' }, key: { type: 'string' }, out: { type: 'string' } },
  });
  requireOutput(/^\d+$/.test(run ?? '') && key && out, 'Use --run <id> --key <path> --out <path>.');

  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const path = resolve(out);
  requireOutput(!inRepo(root, path), 'Choose an output path outside the repository.');
  const parent = realpathSync(dirname(path));
  requireOutput(!inRepo(root, parent), 'Choose an output path outside the repository.');
  for (let directory = parent; ; directory = dirname(directory)) {
    requireOutput(!existsSync(join(directory, '.git')), 'Choose an output path outside Git worktrees.');
    if (directory === dirname(directory)) break;
  }
  const output = join(parent, basename(path));
  requireOutput(!existsSync(output), 'Choose a new output file.');

  const directory = mkdtempSync(join(tmpdir(), 'masarx-sweep-'));
  try {
    const download = spawnSync(process.env.GH_CLI || 'gh', [
      'run', 'download', run, '--repo', 'MasarX/masarx-platform', '--name', 'dev-sweep-credentials', '--dir', directory,
    ], { windowsHide: true, stdio: 'ignore', timeout: 60_000 });
    requireOutput(download.status === 0, 'Could not download the encrypted sweep artifact.');

    const decrypted = spawnSync('openssl', [
      'cms', '-decrypt', '-binary', '-inform', 'DER', '-in', join(directory, 'dev-sweep-credentials.cms'),
      '-inkey', resolve(key), '-recip', fileURLToPath(new URL('../../config/dev/sweep-recipient.crt', import.meta.url)),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    requireOutput(decrypted.status === 0 && decrypted.stdout?.length > 0, 'Could not decrypt the sweep artifact.');
    saveCredentials(output, decrypted.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error?.[message] ?? 'Could not fetch or save sweep credentials.');
  process.exitCode = 1;
}
