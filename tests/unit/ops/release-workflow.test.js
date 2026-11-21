const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const body = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/release.yml'), 'utf8');
const workflow = yaml.parse(body);
const { verify, build } = workflow.jobs;

describe('release workflow contract', () => {
  test('runs on version tags and requires the same tag ref on manual runs', () => {
    expect(workflow.on).toEqual({
      push: { tags: ['v*'] },
      workflow_dispatch: {
        inputs: { tag: { description: expect.any(String), type: 'string', required: true } },
      },
    });
    expect(workflow.concurrency).toEqual({
      group: 'release-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    const gate = verify.steps.find(step => step.id === 'verify');
    expect(gate.env.REQUESTED_TAG).toBe('${{ inputs.tag }}');
    expect(gate.run).toContain('"$GITHUB_REF" != refs/tags/v*');
    expect(gate.run).toContain('"$REQUESTED_TAG" != "$GITHUB_REF_NAME"');
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

  test('requires a successful ci-gate from public CI on the exact main commit', () => {
    const gate = verify.steps.find(step => step.id === 'verify');
    expect(gate.run).toContain('git rev-parse --verify "$GITHUB_REF^{commit}"');
    expect(gate.run).toContain('"$sha" != "$(git rev-parse HEAD)"');
    expect(gate.run).toContain('git merge-base --is-ancestor "$sha" refs/remotes/origin/main');
    expect(gate.run).toContain('actions/workflows/public-ci.yml/runs?head_sha=$sha');
    expect(gate.run).toContain('commits/$sha/check-runs?check_name=ci-gate');
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

  test('avoids deployment, environment bindings and repository secrets', () => {
    expect(body).not.toMatch(/\b(?:deploy(?:ment)?|vercel|wrangler|secrets)\b|^\s*environment:/im);
    const tokenBindings = [verify, build].flatMap(job => job.steps.map(step => step.env?.GH_TOKEN).filter(Boolean));
    expect(tokenBindings).toEqual(['${{ github.token }}', '${{ github.token }}']);
  });
});
