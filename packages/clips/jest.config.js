// The public surface here is pure TypeScript -- sentence normalization, option
// resolution, and the config plugin's deployment-target edit -- so it is
// unit-testable without a device. The native half is covered by the example app,
// which is the only place a Core ML session actually exists.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
