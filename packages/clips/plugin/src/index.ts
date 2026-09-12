import {
  createRunOncePlugin,
  withPodfileProperties,
  withXcodeProject,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/**
 * The Core ML artifact's floor, not the code's: `clips.mlmodelc` is a
 * MULTIFUNCTION package — two graphs over one stored copy of a shared trunk —
 * and multifunction is an iOS 18 feature. `Sources/Clips` carries no
 * `@available` and would compile lower, which is why the native module also
 * checks the floor at runtime; this is what keeps the build honest.
 */
const IOS_DEPLOYMENT_TARGET = '18.0';

/**
 * One thing a Clips app needs that its own config would not otherwise say.
 *
 * There is no Android half here. Upstream declares LiteRT files for Android, but
 * publishes no artifact to bind to yet, so this package is `"platforms":
 * ["apple"]` and `Clips.isSupported` reports false there at runtime.
 */
const withClips: ConfigPlugin<void> = (config) => {
  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntClips' has a minimum deployment
  // target of iOS 18.0".
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
 * floor any installed model needs, not at whichever plugin ran last.
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

export default createRunOncePlugin(withClips, pkg.name, pkg.version);
