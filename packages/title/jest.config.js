// The public surface here is pure TypeScript -- argument validation, the
// two-step "do the work, then take the result" shape, and the card-shape
// arithmetic -- so it is unit-testable without a device. The native half is
// covered by the example app, and the *generating* half of it is not covered
// anywhere, because the MLX package trait it lives behind cannot be enabled
// from a CocoaPods build. See the README.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
