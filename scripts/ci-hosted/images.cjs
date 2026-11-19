'use strict';
const { retry } = require('./process.cjs');
const { TRANSIENT_PULL_ERROR, FINAL_PULL_ERROR } = require('../ops/ci/cloud-pool-db-local.js');

const alias = pin => `public.ecr.aws/${pin.image}:${pin.cli_tag}`;
async function prepareImages(pins, { env, checked, timed, summary, wait, checkDisk = () => {} }) {
  const inspect = async (reference, pin) => {
    const id = (await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], env, 30000, { quiet: true })).trim();
    if (id !== pin.image_id) throw new Error(`Reviewed image ID mismatch: ${pin.image}`);
    return id;
  };
  const results = await Promise.allSettled(pins.map(async pin => {
    checkDisk();
    const served = pin.mirror;
    const reference = `${served}/${pin.image}@${pin.digest}`;
    const label = `image-pull:${pin.role}:${served}`;
    await timed(label, () => retry(label,
      () => checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, 3 * 60000, { logPrefix: `[${label}] ` }), wait, {
        attempts: 2,
        retryable(error) {
          const output = `${error.message}\n${error.failure?.output || ''}`;
          return !FINAL_PULL_ERROR.test(output) && (error.failure?.timeout || TRANSIENT_PULL_ERROR.test(output));
        },
      }));
    pin.runtimeId = await inspect(reference, pin);
    await checked('docker', ['tag', pin.runtimeId, alias(pin)], env, 30000);
    console.log(`Reviewed image ${pin.image}@${pin.digest} served by ${served}; verified ${pin.runtimeId}`);
    return { image: pin.image, digest: pin.digest, id: pin.runtimeId, served };
  }));
  summary.images = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
module.exports = { prepareImages };
