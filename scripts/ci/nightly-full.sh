#!/usr/bin/env bash
set -euo pipefail
umask 077

cd -- "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
job=$(mktemp -d "$PWD/.nightly-XXXXXXXX")
mkdir -p "$job/home" "$job/tmp" "$job/cache" "$job/config" "$job/data" "$job/npm/bin"
uid=$(id -u)
exec env -i PATH="$job/npm/bin:$PATH" LANG="${LANG:-C.UTF-8}" TZ=UTC HOME="$job/home" \
  TMPDIR="$job/tmp" XDG_CACHE_HOME="$job/cache" XDG_CONFIG_HOME="$job/config" XDG_DATA_HOME="$job/data" \
  NPM_CONFIG_CACHE="$job/cache/npm" NPM_CONFIG_PREFIX="$job/npm" PLAYWRIGHT_BROWSERS_PATH="$job/cache/playwright" \
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  DOCKER_HOST="unix:///run/user/$uid/docker.sock" NIGHTLY_JOB="$job" \
  bash --noprofile --norc scripts/ci/nightly-suites.sh
