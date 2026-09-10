import { raiseDeploymentTarget, withAbiFilters } from '../index';

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

// The deployment-target half of the plugin. Both halves are needed: the Podfile
// picks its platform from the properties file, but React Native then aligns pod
// targets to the app project, so an untouched .xcodeproj drags the pods back
// down to Expo's 16.4 default.
describe('raiseDeploymentTarget', () => {
  const projectWith = (settings: Record<string, Record<string, unknown>>) => ({
    pbxXCBuildConfigurationSection: () =>
      Object.fromEntries(
        Object.entries(settings).map(([key, buildSettings]) => [key, { buildSettings }])
      ),
  });

  it('raises a target below 18.0', () => {
    const project = projectWith({ A: { IPHONEOS_DEPLOYMENT_TARGET: '16.4' } });
    const section = project.pbxXCBuildConfigurationSection();
    raiseDeploymentTarget({ pbxXCBuildConfigurationSection: () => section });
    expect(section.A!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('18.0');
  });

  it('leaves a higher target alone', () => {
    const section = projectWith({ A: { IPHONEOS_DEPLOYMENT_TARGET: '26.0' } })
      .pbxXCBuildConfigurationSection();
    raiseDeploymentTarget({ pbxXCBuildConfigurationSection: () => section });
    expect(section.A!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('26.0');
  });

  it('does not give an inheriting configuration a hardcoded target', () => {
    const section = projectWith({ A: { SDKROOT: 'iphoneos' } }).pbxXCBuildConfigurationSection();
    raiseDeploymentTarget({ pbxXCBuildConfigurationSection: () => section });
    expect(section.A!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBeUndefined();
  });
});
