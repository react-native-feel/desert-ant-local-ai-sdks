import {
  createRunOncePlugin,
  withPodfileProperties,
  withXcodeProject,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/**
 * The `desert-ant-core` package floor -- `platforms:` in its Package.swift -- and
 * the only floor in play for Tongue.
 *
 * Lower than any artifact floor in this family because there is no artifact:
 * Clear and Clips need iOS 18 for their Core ML programs, and Tongue's "model"
 * is a table of int8 bytes plus arithmetic, which would run anywhere. SwiftPM
 * simply refuses to resolve the package into a consumer below 17 -- and that is
 * still above Expo's 16.4 default, which is why this is a plugin rather than a
 * line in a README: getting it wrong fails the build, and the fix is in a file
 * `npx expo prebuild` regenerates.
 */
const IOS_DEPLOYMENT_TARGET = '17.0';

/**
 * One thing a Tongue app needs that its own config would not otherwise say --
 * and, unusually for this family, exactly one.
 *
 * Clear, Emo and Ear each have a second half to this plugin: they bind LiteRT,
 * which ships `arm64-v8a` and `x86_64` only, so each narrows the app's
 * `abiFilters` to keep a build from producing an APK whose AAR has no matching
 * `.so`. Tongue binds no native library at all -- `ai.desertant:tongue` is a pure
 * Kotlin jar -- so there is no ABI to narrow, and narrowing anyway would impose a
 * restriction this model does not have on an app that installed only this
 * package.
 *
 * That makes this plugin a *no-op* on `build.gradle`, which is a composition
 * property worth stating rather than an omission: an app that installs Tongue
 * alongside Clear, Emo or Ear ends up with whatever block those three agreed on,
 * untouched, and an app that installs Tongue alone ends up with none. See the
 * tests.
 */
const withTongue: ConfigPlugin<void> = (config) => {
  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntTongue' has a minimum deployment
  // target of iOS 17.0".
  config = withPodfileProperties(config, (podfileConfig) => {
    const current = podfileConfig.modResults['ios.deploymentTarget'];
    if (!current || parseFloat(current) < parseFloat(IOS_DEPLOYMENT_TARGET)) {
      podfileConfig.modResults['ios.deploymentTarget'] = IOS_DEPLOYMENT_TARGET;
    }
    return podfileConfig;
  });

  config = withXcodeProject(config, (xcodeConfig) => {
    raiseDeploymentTarget(xcodeConfig.modResults);
    return xcodeConfig;
  });

  return config;
};

/**
 * Raise every build configuration that already names a deployment target, and
 * leave alone any that does not -- a configuration inheriting the project-level
 * value should keep inheriting it rather than acquire a hardcoded one.
 *
 * Only ever raises, so this composes with the other Desert Ant plugins over the
 * same project whichever order they run in: the project ends up at the highest
 * floor any installed model needs, not at whichever plugin ran last. Tongue's
 * floor is tied for the lowest in the family, so in a multi-model app this
 * usually changes nothing.
 */
export function raiseDeploymentTarget(project: {
  pbxXCBuildConfigurationSection(): Record<string, { buildSettings?: Record<string, unknown> }>;
}): void {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    const current = settings?.IPHONEOS_DEPLOYMENT_TARGET;
    if (typeof current === 'string' && parseFloat(current) < parseFloat(IOS_DEPLOYMENT_TARGET)) {
      settings!.IPHONEOS_DEPLOYMENT_TARGET = IOS_DEPLOYMENT_TARGET;
    }
  }
}

export default createRunOncePlugin(withTongue, pkg.name, pkg.version);
