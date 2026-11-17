'use strict';
const { retry } = require('./process.cjs');
const { sanitize } = require('./diagnostics.cjs');

const alias = pin => `public.ecr.aws/${pin.image}:${pin.cli_tag}`;
async function prepareImages(pins, { env, checked, timed, summary, wait, checkDisk = () => {} }) {
  const inspect = async (reference, pin) => {
    const id = (await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], env, 30000, { quiet: true })).trim();
    if (id !== pin.image_id) throw new Error(`Reviewed image ID mismatch: ${pin.image}`);
    return id;
  };
  const results = await Promise.allSettled(pins.map(async pin => {
    checkDisk();
    let served;
    for (const registry of [pin.mirror, 'public.ecr.aws']) {
      const reference = `${registry}/${pin.image}@${pin.digest}`;
      const label = `image-pull:${pin.role}:${registry}`;
      try {
        await timed(label, () => retry(label,
          () => checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, 3 * 60000, { logPrefix: `[${label}] ` }), wait));
        pin.runtimeId = await inspect(reference, pin);
        served = registry;
        break;
      } catch (error) {
        if (registry === 'public.ecr.aws') throw error;
        console.error(`${label}: mirror failed; trying public.ecr.aws: ${sanitize(error.message)}`);
      }
    }
    await checked('docker', ['tag', pin.runtimeId, alias(pin)], env, 30000);
    console.log(`Reviewed image ${pin.image}@${pin.digest} served by ${served}; verified ${pin.runtimeId}`);
    return { image: pin.image, digest: pin.digest, id: pin.runtimeId, served };
  }));
  summary.images = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
module.exports = { prepareImages };
