import { withAbiFilters as clearAbiFilters } from '../../../../clear/plugin/src/index';
import { withAbiFilters as earAbiFilters } from '../../../../ear/plugin/src/index';
import { withAbiFilters as emoAbiFilters } from '../../../../emo/plugin/src/index';
import withTongue, { raiseDeploymentTarget } from '../index';

const GRADLE = `android {
  namespace 'com.example.app'
  defaultConfig {
    applicationId 'com.example.app'
    minSdkVersion rootProject.ext.minSdkVersion
  }
}`;

/**
 * The half of this plugin that does not exist, asserted as a property rather
 * than left as an absence.
 *
 * Clear, Emo and Ear each narrow `abiFilters` to `arm64-v8a` and `x86_64`
 * because each binds LiteRT, which ships those two `.so`s and no others. Tongue
 * binds no native library at all -- `ai.desertant:tongue` is a pure Kotlin jar --
 * so it has nothing to narrow, and narrowing anyway would take ABIs away from an
 * app that installed only this package and could have run on all of them.
 *
 * That makes the composition question different from the one the other three
 * answer among themselves. They have to agree on *one* block; this one has to
 * leave whatever they agreed on exactly as it found it, and write nothing when
 * it is alone.
 */
describe('the Android half of the plugin, which is deliberately empty', () => {
  it('exports no withAbiFilters, because there is no ABI to filter', () => {
    const plugin = require('../index');
    expect(plugin.withAbiFilters).toBeUndefined();
  });

  it('leaves a build.gradle with no Desert Ant block untouched', () => {
    // A `withAppBuildGradle` mod is the only way this plugin could reach the
    // file, and it does not register one. Running the plugin over a config with
    // no Android mods at all is the assertion that it wants nothing from them.
    const config = { name: 'app', slug: 'app', modResults: {}, mods: {} } as never;
    const result = withTongue(config, undefined as never) as { mods?: Record<string, unknown> };
    expect(Object.keys(result.mods ?? {})).not.toContain('android');
  });

  it('leaves the block the other three agreed on exactly as it found it', () => {
    // Every order of the three that *do* write, with this plugin's contribution
    // -- nothing -- inserted at every position. The invariant is the same one
    // their own tests assert, and it must survive a fourth Desert Ant plugin
    // being installed alongside them.
    const writers = [clearAbiFilters, emoAbiFilters, earAbiFilters];
    const passthrough = (contents: string) => contents;
    for (const order of permutations(writers)) {
      for (let slot = 0; slot <= order.length; slot += 1) {
        const withTongueSlotted = [
          ...order.slice(0, slot),
          passthrough,
          ...order.slice(slot),
        ];
        const result = withTongueSlotted.reduce((contents, plugin) => plugin(contents), GRADLE);
        expect(result.match(/abiFilters/g)).toHaveLength(1);
        expect(result).toContain("abiFilters 'arm64-v8a', 'x86_64'");
      }
    }
  });

  it('an app with Tongue alone gets no abiFilters block at all', () => {
    // The point of not writing one: LiteRT's two ABIs are not Tongue's
    // constraint, and inheriting them would be a restriction this model does not
    // have.
    expect(GRADLE).not.toContain('abiFilters');
  });
});

// The deployment-target half, which is the whole of this plugin. Both halves of
// *that* are needed: the Podfile picks its platform from the properties file, but
// React Native then aligns pod targets to the app project, so an untouched
// .xcodeproj drags the pods back down to Expo's 16.4 default.
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
    // Tongue's floor is tied for the lowest in the family -- it has no artifact
    // at all, so nothing but the package manifest imposes anything -- which makes
    // this the case that matters in practice: in an app that also installs Clear
    // (18.0) this plugin must leave the project alone whichever order the two run
    // in.
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
