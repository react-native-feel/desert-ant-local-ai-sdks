import {
  createRunOncePlugin,
  withPodfileProperties,
  withXcodeProject,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/**
 * The `desert-ant-core` package floor -- `platforms:` in its Package.swift -- not
 * Voz's own. `Sources/Voz` carries no `@available` and its catalog entry inherits
 * the default `OSFloor.packageFloor` (iOS 16), so the artifact itself would load
 * lower; SwiftPM simply refuses to resolve the package into a consumer below 17.
 *
 * Above Expo's 16.4 default either way, which is why this is a plugin rather than
 * a line in a README: getting it wrong fails the build, and the fix is in a file
 * `expo prebuild` regenerates.
 */
const IOS_DEPLOYMENT_TARGET = '17.0';

/**
 * One thing a Voz app needs that its own config would not otherwise say.
 *
 * There is no Android half here, and that is not an omission: Voz is Core ML
 * only, so `desert-ant-core` publishes no Android artifact and this package
 * declares `"platforms": ["apple"]`. An Android build links nothing and
 * `Voz.isSupported` reports false at runtime.
 */
const withVoz: ConfigPlugin<void> = (config) => {
  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntVoz' has a minimum deployment target
  // of iOS 17.0".
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
 * Only ever raises. An app that also uses `@desert-ant-labs/react-native-clear`
 * runs both plugins over the same project, and Clear's floor is higher (iOS 18,
 * its Core ML artifact's); whichever order they run in, the project ends up at
 * the higher of the two rather than at whichever ran last.
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

export default createRunOncePlugin(withVoz, pkg.name, pkg.version);
