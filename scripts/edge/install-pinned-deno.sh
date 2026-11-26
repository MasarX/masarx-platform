#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$RUNNER_TEMP/edge-tools"
archive="$RUNNER_TEMP/deno.zip"
curl --fail --silent --show-error --location https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip --output "$archive"
printf '394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2  %s\n' "$archive" | sha256sum --check
unzip -q "$archive" deno -d "$RUNNER_TEMP/edge-tools"
printf '%s\n' "$RUNNER_TEMP/edge-tools" >> "$GITHUB_PATH"
