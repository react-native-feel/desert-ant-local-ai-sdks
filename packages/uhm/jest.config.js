// The public surface here is pure TypeScript -- URI handling, option validation,
// and the config plugin's deployment-target edit -- so it is unit-testable
// without a device. The native half is covered by the example app, which is the
// only place a Core ML session and real audio exist.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
