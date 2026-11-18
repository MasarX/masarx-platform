#!/usr/bin/env node
async function main() {
  const strictVerifier = await import('./verify-mobile-fieldops-strict.cjs');
  return strictVerifier.main();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  main,
};
