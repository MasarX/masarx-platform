const { spawnSync } = require("child_process");
const path = require("path");

describe("FieldOps Metro config", () => {
  test("loads with workspace-hoisted Expo Metro dependencies", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const script = [
      "const path = require('path');",
      "const fs = require('fs');",
      "const config = require(path.resolve('apps/fieldops/metro.config.js'));",
      "const projectRoot = path.resolve('apps/fieldops');",
      "const workspaceRoot = path.resolve(projectRoot, '../..');",
      "if (!config || !Array.isArray(config.watchFolders)) throw new Error('missing watchFolders');",
      "if (config.watchFolders.includes(workspaceRoot)) throw new Error('whole workspace watch folder should be excluded');",
      "const packageRoots = ['api', 'auth', 'config', 'mobile-core', 'ui'].map((name) => path.resolve(workspaceRoot, 'packages', name)).filter((packagePath) => fs.existsSync(packagePath));",
      "for (const packageRoot of packageRoots) { if (!config.watchFolders.includes(packageRoot)) throw new Error(`missing package watch folder ${packageRoot}`); }",
      "const nodeModulesPaths = config.resolver && config.resolver.nodeModulesPaths || [];",
      "if (!nodeModulesPaths.includes(path.resolve(projectRoot, 'node_modules'))) throw new Error('missing app node_modules');",
      "if (!nodeModulesPaths.includes(path.resolve(workspaceRoot, 'node_modules'))) throw new Error('missing workspace node_modules');",
      "if (!config.resolver.extraNodeModules.react || !fs.existsSync(config.resolver.extraNodeModules.react)) throw new Error('react runtime not resolved');",
      "if (config.resolver.extraNodeModules.react === path.resolve(workspaceRoot, 'node_modules', 'react') && fs.existsSync(path.resolve(projectRoot, 'node_modules', 'react'))) throw new Error('react should prefer app runtime when materialized');",
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
