// The public surface here is pure TypeScript -- argument validation, the two
// shapes of a result, the roll-up's conversion from a map to the wire's array,
// and the config plugin's project edits -- so it is unit-testable without a
// device. The native half is covered by the example app, which is the only place
// a real inference session exists.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
