const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const asset = require('../../packages/ui/map-worker-asset.json');

// Keep the installed worker's relative imports beside it, outside hashed bundler assets.
function prepareMapWorker(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  const directory = path.join(root, 'public');
  const files = [asset.filename, ...asset.companions];
  const sources = files.map((filename) => {
    if (!/^[-a-z0-9]+\.mjs$/.test(filename)) throw new Error('Invalid map worker asset filename');
    return { filename, bytes: fs.readFileSync(require.resolve('maplibre-gl/dist/' + filename, { paths: [root] })) };
  });
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error('Map public asset directory must not be a symlink');
  }
  // Validate the whole pair before writing either member.
  const missing = [];
  for (const { filename, bytes } of sources) {
    const target = path.join(directory, filename);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(target).equals(bytes)) {
        throw new Error('Generated map worker asset differs; preserve and reconcile before launch');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push({ filename, bytes });
    }
  }
  // Identical installed assets are reusable even when the public directory is read-only.
  for (const { filename, bytes } of missing) {
    const target = path.join(directory, filename);
    const temporary = path.join(directory, '.maplibre-worker-' + randomUUID() + '.tmp');
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    try {
      try { fs.linkSync(temporary, target); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()
            || !fs.readFileSync(target).equals(bytes)) {
          throw new Error('Generated map worker asset differs; preserve and reconcile before launch');
        }
      }
    } finally { fs.unlinkSync(temporary); }
  }
  return path.join(directory, asset.filename);
}
module.exports = { prepareMapWorker };
