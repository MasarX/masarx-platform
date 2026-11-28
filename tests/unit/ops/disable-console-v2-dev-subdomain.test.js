const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/disable-console-v2-dev-subdomain.yml'), 'utf8'));
const job = workflow.jobs['disable-subdomain'];
const run = job.steps.find(step => step.run).run;

const stubs = String.raw`
curl() {
  local calls replies method status body exit_code config
  mapfile -t calls < "$TEST_TRACE"
  mapfile -t replies <<< "$TEST_REPLIES"
  IFS=$'\t' read -r status body exit_code <<< "${'$'}{replies[${'$'}{#calls[@]}]}"
  while [[ "$1" != --request ]]; do shift; done
  method=$2
  printf '%s\n' "$method" >> "$TEST_TRACE"
  config=$(cat)
  [[ "$*" != *"$CLOUDFLARE_ACCOUNT_ID"* && "$*" != *"$CLOUDFLARE_API_TOKEN"* ]] || return 1
  [[ "$config" == *"/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$CLOUDFLARE_WORKER_CONSOLE_V2/subdomain"* &&
     "$config" == *"Authorization: Bearer $CLOUDFLARE_API_TOKEN"* ]] || return 1
  if [[ "$method" == POST ]]; then
    [[ "$*" == *'--json {"enabled":false,"previews_enabled":false}'* ]] || return 1
  else
    [[ "$method" == GET && "$*" != *--json* ]] || return 1
  fi
  printf '%s\n%s' "$body" "$status"
  return "$exit_code"
}
sleep() { printf '%s\n' "$1" >> "$TEST_BACKOFF"; }
export -f curl sleep
`;

const ok = { success: true, result: { enabled: false, previews_enabled: false } };

function execute(replies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-subdomain-'));
  const trace = path.join(dir, 'requests');
  const backoff = path.join(dir, 'backoff');
  const summary = path.join(dir, 'summary');
  try {
    for (const file of [trace, backoff, summary]) fs.writeFileSync(file, '');
    const replyLines = replies.map(([status, body, exitCode = 0]) =>
      [status, typeof body === 'string' ? body : JSON.stringify(body), exitCode].join('\t'));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `${stubs}\n${run}`], {
      cwd: root,
      env: {
        ...process.env,
        BASH_ENV: '',
        CLOUDFLARE_ACCOUNT_ID: randomBytes(16).toString('hex'),
        CLOUDFLARE_API_TOKEN: randomBytes(24).toString('base64url'),
        CLOUDFLARE_WORKER_CONSOLE_V2: 'test-worker',
        GITHUB_STEP_SUMMARY: summary,
        TEST_TRACE: trace,
        TEST_BACKOFF: backoff,
        TEST_REPLIES: replyLines.join('\n'),
      },
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      trace: fs.readFileSync(trace, 'utf8').trim(),
      backoff: fs.readFileSync(backoff, 'utf8').trim(),
      summary: fs.readFileSync(summary, 'utf8').trim(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('admits only manual runs on main and verifies both flags with an independent GET', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch).toBeNull();
  expect(job.if).toBe("github.ref == 'refs/heads/main'");
  expect(job.environment).toBe('dev');
  expect(execute([[200, { success: true }], [200, ok]])).toEqual({
    status: 0,
    stdout: '',
    stderr: '',
    trace: 'POST\nGET',
    backoff: '',
    summary: 'enabled=false previews_enabled=false',
  });
});

test.each([
  ['forbidden', 403, { success: false, errors: [{ code: 10000, message: 'provider detail' }, { code: 'untrusted text' }] }, 0, '10000'],
  ['API failure on 200', 200, { success: false, errors: [{ code: 1010 }] }, 0, '1010'],
  ['rate limit', 429, { success: false }, 0, 'none'],
  ['invalid JSON', 200, 'provider detail', 0, 'none'],
  ['failed transfer', 200, ok, 28, 'none'],
])('stops on %s without exposing the response or reading back', (_label, status, body, exitCode, codes) => {
  expect(execute([[status, body, exitCode]])).toEqual({
    status: 1,
    stdout: '',
    stderr: `::error::HTTP ${status} API error codes ${codes}\n`,
    trace: 'POST',
    backoff: '',
    summary: '',
  });
});

test.each([
  { enabled: true, previews_enabled: false },
  { enabled: false, previews_enabled: true },
  { enabled: false },
  { enabled: 'false', previews_enabled: false },
])('rejects readback unless both flags are boolean false (%j)', result => {
  expect(execute([[200, ok], [200, { success: true, result }]])).toMatchObject({
    status: 1,
    stderr: '::error::HTTP 200 API error codes none\n',
    trace: 'POST\nGET',
    backoff: '',
    summary: '',
  });
});

test('backs off on 5xx for both requests and stops after three attempts', () => {
  expect(execute([[503, 'unavailable'], [200, ok], [502, 'unavailable'], [503, 'unavailable'], [500, 'unavailable']])).toEqual({
    status: 1,
    stdout: '',
    stderr: '::error::HTTP 500 API error codes none\n',
    trace: 'POST\nPOST\nGET\nGET\nGET',
    backoff: '1\n1\n2',
    summary: '',
  });
});
