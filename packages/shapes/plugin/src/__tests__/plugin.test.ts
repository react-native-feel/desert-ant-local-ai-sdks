import { withAbiFilters as clearAbiFilters } from '../../../../clear/plugin/src/index';
import { withAbiFilters as earAbiFilters } from '../../../../ear/plugin/src/index';
import { withAbiFilters as emoAbiFilters } from '../../../../emo/plugin/src/index';
import { withAbiFilters as gistAbiFilters } from '../../../../gist/plugin/src/index';
import { withAbiFilters as redactAbiFilters } from '../../../../redact/plugin/src/index';
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

  // Shapes is the model in this family most likely to be mistaken for one that
  // needs no ABI block: its fitters and its snapping are pure portable arithmetic
  // -- upstream replaced `simd` with its own `V2` precisely so they would be --
  // which makes a pure-Kotlin AAR like Tongue's sound plausible. It is not one.
  // Stage one is a neural classifier, the catalog ships `shapes.tflite` for
  // `.android`, and `ShapesNative.ensureLoaded()` loads `libShapesAndroid.so`.
  it('writes the block Tongue deliberately does not, because this AAR has a .so', () => {
    expect(withAbiFilters(GRADLE)).toContain('LiteRT ships');
    expect(withAbiFilters(GRADLE)).toContain('@desert-ant-labs/react-native-shapes');
  });

  it('is idempotent across repeated prebuilds', () => {
    expect(withAbiFilters(withAbiFilters(GRADLE))).toBe(withAbiFilters(GRADLE));
  });

  it('leaves a file it cannot anchor to untouched', () => {
    const unrecognized = 'apply plugin: "com.android.application"';
    expect(withAbiFilters(unrecognized)).toBe(unrecognized);
  });

  // Shapes is the sixth LiteRT model in this repo, so the shared-marker rule now
  // has to hold across six plugins rather than five. Matching only this package's
  // own marker would put a sixth `ndk { abiFilters }` inside one `defaultConfig`
  // -- a duplicate Gradle accepts and that says nothing the first did not.
  describe('composing with the other Desert Ant plugins', () => {
    const others: [string, (contents: string) => string][] = [
      ['Clear', clearAbiFilters],
      ['Emo', emoAbiFilters],
      ['Ear', earAbiFilters],
      ['Gist', gistAbiFilters],
      ['Redact', redactAbiFilters],
    ];

    it.each(others)('defers to a block %s already wrote', (_name, plugin) => {
      const after = plugin(GRADLE);
      expect(withAbiFilters(after)).toBe(after);
      expect(after.match(/abiFilters/g)).toHaveLength(1);
    });

    it('and all five defer to one this plugin wrote, so the order does not matter', () => {
      const afterShapes = withAbiFilters(GRADLE);
      for (const [, plugin] of others) {
        expect(plugin(afterShapes)).toBe(afterShapes);
      }
      expect(afterShapes.match(/abiFilters/g)).toHaveLength(1);
    });

    // The case an app with the whole family actually hits, in all 720 orders.
    it('writes exactly one block however the six are ordered', () => {
      const plugins = [...others.map(([, plugin]) => plugin), withAbiFilters];
      const orders = permutations(plugins);
      expect(orders).toHaveLength(720);
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
    // Shapes' floor is tied for the lowest in the family, so in an app that also
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
