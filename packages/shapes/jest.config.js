// The public surface here is pure TypeScript -- argument validation, the
// flattening of a stroke onto the wire, the narrowing of a flat native record
// back into a discriminated union, the outline a renderer draws, and the config
// plugin's project edits -- so it is unit-testable without a device. The native
// half is covered by the example app, which is the only place a real inference
// session exists.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
