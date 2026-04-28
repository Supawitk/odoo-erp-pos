const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration.
 * https://reactnative.dev/docs/metro
 *
 * pnpm-compatibility: tell Metro to follow symlinks and to look in both the
 * package-local `node_modules` and the workspace root's `node_modules/.pnpm/`
 * store. Without this, pnpm's `.pnpm/` virtual store confuses Metro's
 * hierarchical resolver.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    disableHierarchicalLookup: false,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
