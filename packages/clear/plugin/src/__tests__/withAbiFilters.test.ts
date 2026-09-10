import { withAbiFilters } from '../index';

const GRADLE = `android {
  namespace 'com.example.app'
  defaultConfig {
    applicationId 'com.example.app'
    minSdkVersion rootProject.ext.minSdkVersion
  }
}`;

describe('withAbiFilters', () => {
  it('inserts abiFilters into defaultConfig', () => {
    const result = withAbiFilters(GRADLE);
    expect(result).toContain("abiFilters 'arm64-v8a', 'x86_64'");
    expect(result.indexOf('abiFilters')).toBeGreaterThan(result.indexOf('defaultConfig {'));
    expect(result.indexOf('abiFilters')).toBeLessThan(result.indexOf('applicationId'));
  });

  it('is idempotent across repeated prebuilds', () => {
    expect(withAbiFilters(withAbiFilters(GRADLE))).toBe(withAbiFilters(GRADLE));
  });

  it('leaves a file it cannot anchor to untouched', () => {
    const unrecognized = 'apply plugin: "com.android.application"';
    expect(withAbiFilters(unrecognized)).toBe(unrecognized);
  });
});
