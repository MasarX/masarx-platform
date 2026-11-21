const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const body = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/provenance-on-tag.yml'), 'utf8');
const workflow = yaml.parse(body);
const { verify, build } = workflow.jobs;

describe('release workflow contract', () => {
  test('runs only on version tag pushes', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } });
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.concurrency).toEqual({
      group: 'release-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    const gate = verify.steps.find(step => step.id === 'verify');
    expect(gate.run).toContain('"$GITHUB_REF" != refs/tags/v*');
  });

  test('gives the two bounded jobs only the permissions they use', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['verify', 'build']);
    expect(verify.permissions).toEqual({ contents: 'read', checks: 'read', actions: 'read' });
    expect(build.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
    for (const job of [verify, build]) {
      expect(job.strategy).toBeUndefined();
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
  });

  test('requires trusted public CI on the exact first-parent main commit', () => {
    const gate = verify.steps.find(step => step.id === 'verify');
    expect(gate.run).toContain('git rev-parse --verify "$GITHUB_REF^{commit}"');
    expect(gate.run).toContain('"$sha" != "$(git rev-parse HEAD)"');
    const firstParent = 'git rev-list --first-parent refs/remotes/origin/main | grep -Fx "$sha"';
    expect(gate.run).toContain(firstParent);
    expect(gate.run).toContain('actions/workflows/public-ci.yml/runs?head_sha=$sha');
    const eventFilter = 'select(.event == "merge_group" or (.event == "push" and .head_branch == "main"))';
    expect(gate.run).toContain(eventFilter);
    expect(gate.run.indexOf(firstParent)).toBeLessThan(gate.run.indexOf('gh api'));
    expect(gate.run).toContain('max_by(.id)');
    expect(gate.run.indexOf(eventFilter)).toBeLessThan(gate.run.indexOf('max_by(.id)'));
    expect(gate.run).toContain('commits/$sha/check-runs?check_name=ci-gate&filter=all');
    expect(gate.run).toContain('.app.slug == "github-actions"');
    expect(gate.run).toContain('.head_sha == $sha');
    expect(gate.run).toContain('.status == "completed" and .conclusion == "success"');
    expect(build.needs).toBe('verify');
    expect(build.steps[0].with.ref).toBe('${{ needs.verify.outputs.sha }}');
  });

  test('pins GitHub-owned actions and attests the artifact before publishing', () => {
    const actions = [verify, build].flatMap(job => job.steps.filter(step => step.uses));
    for (const { uses } of actions) {
      expect(uses).toMatch(/^(actions|github)\/[\w/-]+@[a-f0-9]{40}$/);
      expect(body.split('\n').find(line => line.includes(uses))).toMatch(/ # v\d/);
    }
    const attest = build.steps.find(step => step.uses?.startsWith('actions/attest-build-provenance@'));
    expect(attest?.with['subject-checksums']).toBe('release/SHA256SUMS');
    const publish = build.steps.at(-1);
    expect(build.steps.indexOf(attest)).toBeLessThan(build.steps.indexOf(publish));
    expect(publish.run).toContain('"$current_sha" != "$RELEASE_SHA"');
    expect(publish.run).toContain('gh release create "$RELEASE_TAG" release/landing.tar.gz release/SHA256SUMS');
    expect(publish.run).toContain('--verify-tag');
  });

  test('normalizes archive order, ownership and timestamps before checksumming', () => {
    const pack = build.steps.find(step => step.run?.includes('sha256sum landing.tar.gz'));
    expect(pack.run).toContain('git show -s --format=%ct HEAD');
    expect(pack.run).toContain('tar --sort=name --mtime="@$commit_time" --owner=0 --group=0 --numeric-owner');
    expect(pack.run).toContain('gzip -n > release/landing.tar.gz');
    expect(pack.run).toContain('sha256sum landing.tar.gz > SHA256SUMS');
  });

  test('avoids deployment, environment bindings and repository secrets', () => {
    expect(body).not.toMatch(/\b(?:deploy(?:ment)?|npm\s+publish|gh-pages|pages\s+deploy|vercel|cloudflare|wrangler|secrets)\b|^\s*environment:/im);
    const tokenBindings = [verify, build].flatMap(job => job.steps.map(step => step.env?.GH_TOKEN).filter(Boolean));
    expect(tokenBindings).toEqual(['${{ github.token }}', '${{ github.token }}']);
  });
});
