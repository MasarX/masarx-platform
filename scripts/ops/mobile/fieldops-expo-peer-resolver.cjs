const fs = require('fs');
const Module = require('module');
const path = require('path');

function resolveProjectRoot(env = process.env, cwd = process.cwd()) {
  const explicit = String(env.FIELDOPS_EXPO_PROJECT_ROOT || '').trim();
  if (explicit) return path.resolve(explicit);
  const cwdIsFieldopsApp = path.basename(path.resolve(cwd)) === 'fieldops';
  const candidates = [
    cwdIsFieldopsApp ? cwd : '',
    path.resolve(cwd, 'apps', 'fieldops'),
    path.resolve(__dirname, '..', '..', '..', 'apps', 'fieldops'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const packagePath = path.resolve(candidate, 'package.json');
    if (fs.existsSync(packagePath)) {
      return path.resolve(candidate);
    }
  }

  const dependencyCandidates = [
    cwd,
  ];
  for (const candidate of dependencyCandidates) {
    const packagePath = path.resolve(candidate, 'node_modules', 'expo', 'package.json');
    if (fs.existsSync(packagePath)) {
      return path.resolve(candidate);
    }
  }

  return explicit ? path.resolve(explicit) : path.resolve(cwd);
}

function installFieldopsExpoPeerResolver({
  projectRoot = resolveProjectRoot(),
  marker = '__fieldopsExpoPeerResolverInstalled',
} = {}) {
  const expoPackageJsonPath = path.join(projectRoot, 'node_modules', 'expo', 'package.json');
  if (!fs.existsSync(expoPackageJsonPath) || globalThis[marker]) {
    return false;
  }

  const projectRequire = Module.createRequire(path.join(projectRoot, 'package.json'));
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveFieldopsExpoPeer(request, parent, isMain, options) {
    try {
      return originalResolveFilename.call(this, request, parent, isMain, options);
    } catch (error) {
      const parentFile = String(parent?.filename || '').replace(/\\/g, '/');
      const isMapLibrePluginCaller = parentFile.includes(
        '/node_modules/@maplibre/maplibre-react-native/lib/commonjs/plugin/',
      );
      if (error?.code === 'MODULE_NOT_FOUND' && request === 'expo/config-plugins' && isMapLibrePluginCaller) {
        return projectRequire.resolve(request);
      }
      const isExpoMetroConfigCaller = parentFile.includes('/@expo/metro-config/');
      if (request === 'expo/package.json' && isExpoMetroConfigCaller) {
        return expoPackageJsonPath;
      }
      throw error;
    }
  };
  globalThis[marker] = true;
  return true;
}

installFieldopsExpoPeerResolver();

module.exports = {
  installFieldopsExpoPeerResolver,
  resolveProjectRoot,
};
