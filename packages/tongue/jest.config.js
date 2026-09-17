// The public surface here is pure TypeScript -- argument validation, the shape a
// detection arrives in, and the config plugin's project edits -- so it is
// unit-testable without a device. The native half is covered by the example app,
// which is the only place the bundled weights are actually parsed.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
