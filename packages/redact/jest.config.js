// The public surface here is pure TypeScript -- argument validation, the two
// halves of a redaction, the restoration that puts the originals back, and the
// config plugin's project edits -- so it is unit-testable without a device. The
// native half is covered by the example app, which is the only place a real
// inference session exists.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
