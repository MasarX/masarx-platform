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
  summary.images = [];
  for (const pin of pins) {
    checkDisk();
    let served;
    for (const registry of [pin.mirror, 'public.ecr.aws']) {
      const reference = `${registry}/${pin.image}@${pin.digest}`;
      const label = `image-pull:${pin.role}:${registry}`;
      try {
        await timed(label, () => retry(label,
          () => checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, 3 * 60000), wait));
        pin.runtimeId = await inspect(reference, pin);
        served = registry;
        break;
      } catch (error) {
        if (registry === 'public.ecr.aws') throw error;
        console.error(`Mirror failed; trying public.ecr.aws: ${sanitize(error.message)}`);
      }
    }
    await checked('docker', ['tag', pin.runtimeId, alias(pin)], env, 30000);
    console.log(`Reviewed image ${pin.image}@${pin.digest} served by ${served}; verified ${pin.runtimeId}`);
    summary.images.push({ image: pin.image, digest: pin.digest, id: pin.runtimeId, served });
  }
}
module.exports = { prepareImages };
