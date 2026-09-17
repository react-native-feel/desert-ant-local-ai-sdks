import { withAbiFilters as clearAbiFilters } from '../../../../clear/plugin/src/index';
import { withAbiFilters as earAbiFilters } from '../../../../ear/plugin/src/index';
import { withAbiFilters as emoAbiFilters } from '../../../../emo/plugin/src/index';
import { withAbiFilters as gistAbiFilters } from '../../../../gist/plugin/src/index';
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

  // Redact is the fifth LiteRT model in this repo, so the shared-marker rule now
  // has to hold across five plugins rather than four. Matching only this
  // package's own marker would put a fifth `ndk { abiFilters }` inside one
  // `defaultConfig` -- a duplicate Gradle accepts and that says nothing the first
  // did not.
  describe('composing with the other Desert Ant plugins', () => {
    it('defers to a block Clear already wrote', () => {
      const afterClear = clearAbiFilters(GRADLE);
      expect(withAbiFilters(afterClear)).toBe(afterClear);
      expect(afterClear.match(/abiFilters/g)).toHaveLength(1);
    });

    it('defers to a block Emo already wrote', () => {
      const afterEmo = emoAbiFilters(GRADLE);
      expect(withAbiFilters(afterEmo)).toBe(afterEmo);
      expect(afterEmo.match(/abiFilters/g)).toHaveLength(1);
    });

    it('defers to a block Ear already wrote', () => {
      const afterEar = earAbiFilters(GRADLE);
      expect(withAbiFilters(afterEar)).toBe(afterEar);
      expect(afterEar.match(/abiFilters/g)).toHaveLength(1);
    });

    it('defers to a block Gist already wrote', () => {
      const afterGist = gistAbiFilters(GRADLE);
      expect(withAbiFilters(afterGist)).toBe(afterGist);
      expect(afterGist.match(/abiFilters/g)).toHaveLength(1);
    });

    it('and all four defer to one this plugin wrote, so the order does not matter', () => {
      const afterRedact = withAbiFilters(GRADLE);
      expect(clearAbiFilters(afterRedact)).toBe(afterRedact);
      expect(emoAbiFilters(afterRedact)).toBe(afterRedact);
      expect(earAbiFilters(afterRedact)).toBe(afterRedact);
      expect(gistAbiFilters(afterRedact)).toBe(afterRedact);
      expect(afterRedact.match(/abiFilters/g)).toHaveLength(1);
    });

    // The case an app with the whole family actually hits, in all 120 orders.
    it('writes exactly one block however the five are ordered', () => {
      const plugins = [
        clearAbiFilters,
        emoAbiFilters,
        earAbiFilters,
        gistAbiFilters,
        withAbiFilters,
      ];
      const orders = permutations(plugins);
      expect(orders).toHaveLength(120);
      for (const order of orders) {
        const result = order.reduce((contents, plugin) => plugin(contents), GRADLE);
        expect(result.match(/abiFilters/g)).toHaveLength(1);
        expect(result).toContain("abiFilters 'arm64-v8a', 'x86_64'");
      }
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
    // Redact's floor is tied for the lowest in the family, so in an app that also
    // installs Clear (18.0) this plugin must leave the project alone whichever
    // order the two run in.
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

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ])
  );
}
