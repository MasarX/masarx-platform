# Local development

Use the Node.js version specified in the root `.nvmrc` and install the locked npm dependencies from the root. Use a disposable database and generated test data for work that writes application state. Keep environment files and credentials out of version control.

Run the application you are changing from the repository root.

| Application | Command |
| --- | --- |
| Console V2 | `npm run dev:console:v2` |
| Console | `npm run dev:console` |
| Portal | `npm run dev:portal` |
| FieldOps | `npm run dev:fieldops` |
| Landing site | `npm run dev:landing` |

Use separate backend configuration for each isolated checkout. Verify the configured database and API target before seeding data, applying migrations, or running integration tests. The [testing guide](TESTING_GUIDE.md) identifies which suites require a backend.

## Local deploy workflow tests

The outbound wake suite runs `jq` inside Bash. Install a checksum-verified `jq` binary and put it on the PATH inherited by the test command. Run the preflight and focused suite from the repository root.

On Windows, use the same Git for Windows Bash that the suite starts.

```powershell
$gitBash = Join-Path $env:ProgramFiles 'Git/bin/bash.exe'
& $gitBash --noprofile --norc -c 'jq --version'
if ($LASTEXITCODE -ne 0) {
    throw 'Install jq and make it available on the Git Bash PATH.'
}
npm run test:unit -- --runInBand --runTestsByPath tests/unit/ops/outbound-wake-deploy.test.js
```

On other platforms, check `jq` through the Bash executable on PATH.

```bash
bash --noprofile --norc -c 'jq --version' &&
  npm run test:unit -- --runInBand --runTestsByPath tests/unit/ops/outbound-wake-deploy.test.js
```

## Local label rendering over HTTP

Set `EDGE_ENVIRONMENT=local` and `LABEL_RENDERER_INVOKE_URL` in the local Edge runtime. In the isolated database, have a database superuser set `app.local_label_renderer_url` to the same exact URL with `ALTER DATABASE <local_database> SET app.local_label_renderer_url = '<local_invoke_url>'`. Use that URL in the global `label_provider` settings and configure the signing key and gateway JWT for the local project. The URL must end in `/functions/v1/label-renderer`. Set this database parameter before running `0zz_label_renderer_url_policy_v1.sql` locally.
