#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "${1:?Frozen Edge workdir is required}"
[[ -f SHA256SUMS && ! -L SHA256SUMS ]]
actual=$(find . ! -type d ! -path './SHA256SUMS' -printf '%y %P\n' | sort)
expected=$(awk '{print "f " $2}' SHA256SUMS | sort)
diff -q \
  <(printf '%s\n' "$actual") \
  <(printf '%s\n' "$expected")
sha256sum --strict --check SHA256SUMS
# Deno cache can omit the dynamic import graph even when npm resolution is disabled.
node "$script_dir/check-frozen-bundle-imports.cjs" supabase/functions/*/index.ts
