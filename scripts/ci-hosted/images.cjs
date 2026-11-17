'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { retry } = require('./process.cjs');
const { sanitize } = require('./diagnostics.cjs');

const directory = 'ci-images';
const alias = pin => `public.ecr.aws/${pin.image}:${pin.cli_tag}`;
const inventory = pins => pins.map(pin => ({ image: pin.image, digest: pin.digest, image_id: pin.image_id, alias: alias(pin) }));
function validPacket(packet, pins, env) {
  return /^\d+$/.test(env.GITHUB_RUN_ID || '') && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    && packet.run === env.GITHUB_RUN_ID && packet.sha === env.GITHUB_SHA
    && JSON.stringify(packet.images) === JSON.stringify(inventory(pins));
}
async function prepareImages(pins, { env, checked, timed, summary, shard, wait, checkDisk = () => {} }) {
  const inspect = async (reference, pin) => {
    const id = (await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], env, 30000, { quiet: true })).trim();
    if (id !== pin.image_id) throw new Error(`Reviewed image ID mismatch: ${pin.image}`);
    return id;
  };
  let loaded = false;
  summary.images = [];
  if (shard) {
    try {
      const packet = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      if (!validPacket(packet, pins, env)) throw new Error('Image artifact is not bound to this run, candidate and reviewed pins');
      const archive = path.join(directory, 'images.tar');
      if (fs.statSync(archive).size !== packet.bytes) throw new Error('Image artifact size mismatch');
      checkDisk();
      await timed('image-load', () => checked('docker', ['load', '--input', archive], env, 3 * 60000));
      summary.imageArchiveBytes = packet.bytes;
      loaded = true;
    } catch (error) { console.error(`Image artifact unavailable; pulling reviewed digests: ${sanitize(error.message)}`); }
  }
  for (const pin of pins) {
    checkDisk();
    let served;
    if (loaded) {
      try { pin.runtimeId = await inspect(alias(pin), pin); served = 'same-run artifact'; }
      catch (error) { console.error(`Image artifact verification failed; pulling: ${sanitize(error.message)}`); }
    }
    if (!served) {
      for (const registry of [pin.mirror, 'public.ecr.aws']) {
        const reference = `${registry}/${pin.image}@${pin.digest}`;
        try {
          await timed(`image-pull:${pin.role}:${registry}`, () => retry(`image-pull:${pin.role}:${registry}`,
            () => checked('docker', ['pull', '--platform', 'linux/amd64', reference], env, 3 * 60000), wait));
          pin.runtimeId = await inspect(reference, pin);
          served = registry;
          break;
        } catch (error) { if (registry === 'public.ecr.aws') throw error; console.error(`Mirror failed; trying public.ecr.aws: ${sanitize(error.message)}`); }
      }
    }
    await checked('docker', ['tag', pin.runtimeId, alias(pin)], env, 30000);
    console.log(`Reviewed image ${pin.image}@${pin.digest} served by ${served}; verified ${pin.runtimeId}`);
    summary.images.push({ image: pin.image, digest: pin.digest, id: pin.runtimeId, served });
  }
  if (!shard) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      checkDisk();
      await timed('image-save', () => checked('docker', ['save', '--output', path.join(directory, 'images.tar'), ...pins.map(alias)], env, 3 * 60000));
      const bytes = fs.statSync(path.join(directory, 'images.tar')).size;
      const packet = { run: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, images: inventory(pins), bytes };
      if (!validPacket(packet, pins, env)) throw new Error('Missing image artifact run identity');
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(packet));
      summary.imageArchiveBytes = bytes;
      console.log(`Image archive: ${bytes} bytes`);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      console.error(`Image sharing unavailable; shards will pull reviewed digests: ${sanitize(error.message)}`);
    }
  }
}
function transfer(action, name) {
  if (!['upload', 'download'].includes(name) || !['start', 'end'].includes(action)) throw new Error('Invalid image transfer stage');
  fs.mkdirSync('ci-reports', { recursive: true });
  const file = `ci-reports/image-${name}.json`;
  if (action === 'start') fs.writeFileSync(file, JSON.stringify({ name: `image-${name}`, startedAt: new Date().toISOString() }));
  else {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.endedAt = new Date().toISOString(); entry.durationMs = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
    fs.writeFileSync(file, JSON.stringify(entry));
    const text = `${entry.name}: ${entry.startedAt} -> ${entry.endedAt}; ${(entry.durationMs / 1000).toFixed(3)}s`;
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${text}\n`);
  }
}
if (require.main === module) transfer(process.argv[2], process.argv[3]);
module.exports = { inventory, validPacket, prepareImages };
