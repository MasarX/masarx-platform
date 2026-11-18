# Hosted CI diagnostics

The database job retains `backend-diagnostic.json` on failure. It records the reached stage, process exit or signal and timeout, the digest policy decision, and the last 80 sanitised output lines (at most 16,384 characters). The diagnostic is written before teardown; raw process output and generated credentials are never uploaded. Image-policy records contain static reasons and operation classes, never Docker request bodies or credentials.

Credential masking happens before output truncation. The shared sanitizer covers known credential environment values, credential assignments, connection strings, JWTs, common token formats and opaque credential-shaped values. Diagnostics do not relax digest enforcement, command timeouts, migration integrity or test verdicts.

Each Jest shard retains `jest-results.<lane>.<shard>.json`, including relative file names, assertion identities and full names, sanitised assertion and suite-load errors, process exit/signal/timeout, snapshot counts and keys, duplicate identities, verdict reasons, and the counts that drive the gate. Infrastructure or configuration failure still writes a report. Raw temporary results are removed only after sanitised artifacts are written.

The authoritative PR Jest gate continues to execute the target branch helper and target baseline. A PR that changes the result-capture helper also executes its proposed helper for diagnostic validation; those files have a `.proposed` suffix and do not overwrite the authoritative reports. Ordinary PRs and main runs do not repeat the suite for this check. After merge, the target-owned helper includes the reviewed capture changes and its sanitizer dependency. Proposed diagnostics do not approve failures or replace the trusted gate.
