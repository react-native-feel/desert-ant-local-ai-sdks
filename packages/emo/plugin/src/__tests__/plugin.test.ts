import { withAbiFilters as clearAbiFilters } from '../../../../clear/plugin/src/index';
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

  // The reason both plugins match a shared marker rather than their own. An app
  // with Clear and Emo installed runs both over the same generated file, and two
  // `ndk { abiFilters }` blocks inside one `defaultConfig` is a duplicate that
  // says nothing new.
  describe('composing with the other Desert Ant plugins', () => {
    it('defers to a block Clear already wrote', () => {
      const afterClear = clearAbiFilters(GRADLE);
      expect(withAbiFilters(afterClear)).toBe(afterClear);
      expect(afterClear.match(/abiFilters/g)).toHaveLength(1);
    });

    it('and Clear defers to one this plugin wrote, so the order does not matter', () => {
      const afterEmo = withAbiFilters(GRADLE);
      expect(clearAbiFilters(afterEmo)).toBe(afterEmo);
      expect(afterEmo.match(/abiFilters/g)).toHaveLength(1);
    });
  });
});

// The deployment-target half of the plugin. Both halves are needed: the Podfile
// picks its platform from the properties file, but React Native then aligns pod
// targets to the app project, so an untouched .xcodeproj drags the pods back
// down to Expo's 16.4 default.
describe('raiseDeploymentTarget', () => {
  const projectWith = (settings: Record<string, Record<string, unknown>>) => {
    const section = Object.fromEntries(
      Object.entries(settings).map(([key, buildSettings]) => [key, { buildSettings }])
    );
    return { section, pbxXCBuildConfigurationSection: () => section };
  };

  it('raises a configuration below the desert-ant-core package floor', () => {
    const project = projectWith({ Debug: { IPHONEOS_DEPLOYMENT_TARGET: '16.4' } });
    raiseDeploymentTarget(project);
    expect(project.section.Debug!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('17.0');
  });

  it('never lowers one that is already higher', () => {
    // The case that matters in practice, and more here than for any other model:
    // Emo's floor is the lowest in the family, so in an app that also installs
    // Clear (18.0) this plugin must leave the project alone whichever order the
    // two run in.
    const project = projectWith({ Release: { IPHONEOS_DEPLOYMENT_TARGET: '18.0' } });
    raiseDeploymentTarget(project);
    expect(project.section.Release!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('18.0');
  });

  it('leaves a configuration that inherits the project value inheriting it', () => {
    const project = projectWith({ Debug: { SDKROOT: 'iphoneos' } });
    raiseDeploymentTarget(project);
    expect(project.section.Debug!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBeUndefined();
  });

  it('is idempotent, as a re-run of prebuild would be', () => {
    const project = projectWith({ Debug: { IPHONEOS_DEPLOYMENT_TARGET: '16.4' } });
    raiseDeploymentTarget(project);
    raiseDeploymentTarget(project);
    expect(project.section.Debug!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('17.0');
  });
});
