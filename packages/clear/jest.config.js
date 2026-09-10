// The public surface here is pure TypeScript -- URI handling, option resolution,
// and the config plugin's Gradle edit -- so it is unit-testable without a device.
// The native halves are covered by the example app, which is the only place a
// Core ML or LiteRT session actually exists.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
