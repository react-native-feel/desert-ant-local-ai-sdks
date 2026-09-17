// The public surface here is pure TypeScript -- locale and option validation, URI
// handling, the shift arithmetic over a word list, and the config plugin's
// deployment-target edit -- so it is unit-testable without a device. The native
// half is covered by the example app, which is the only place Apple's
// SpeechAnalyzer and a Core ML session exist.
module.exports = {
  ...require('expo-module-scripts/jest-preset-plugin'),
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
