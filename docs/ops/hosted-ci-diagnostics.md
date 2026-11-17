# Hosted CI diagnostics

The database job retains `backend-diagnostic.json` on failure. It records the reached stage, process exit or signal and timeout, the digest policy decision, and the last 80 sanitised output lines (at most 16,384 characters). The diagnostic is written before teardown; raw process output and generated credentials are never uploaded. Image-policy records contain static reasons and operation classes, never Docker request bodies or credentials.

Credential masking happens before output truncation. The shared sanitizer covers known credential environment values, credential assignments, connection strings, JWTs, common token formats and opaque credential-shaped values. Diagnostics do not relax digest enforcement, command timeouts, migration integrity or test verdicts.
