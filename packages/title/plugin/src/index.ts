import {
  createRunOncePlugin,
  withPodfileProperties,
  withXcodeProject,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/**
 * iOS 17, which for Title is three floors that happen to be the same number.
 *
 * It is the `desert-ant-core` package floor (`platforms:` in its Package.swift).
 * It is also Title's own artifact floor -- `Sources/Title/Catalog.swift` declares
 * `osFloor = OSFloor.mlx`, iOS 17 / macOS 14. And it is the floor this pod
 * compiles at.
 *
 * Those three normally disagree, and the other plugins in this family exist
 * because they do: Clear's and Clips' raise to 18 for a Core ML artifact the
 * package floor would happily build below, and Align's deliberately declines to
 * raise to the 26 its own API needs. Title's coincide because MLX's requirement
 * is a *dependency* floor rather than an artifact one -- SwiftPM will not resolve
 * `MLXLLM` into a package declaring less, and no `@available` annotation can
 * satisfy a manifest-level constraint -- so desert-ant-core's whole package floor
 * had to rise to meet it. Package.swift is blunt about the cost: "That costs iOS
 * 16 / macOS 13 for Apple consumers that never enable MLX -- accepted
 * deliberately." Every model in this repo pays Title's floor whether or not it
 * installs Title.
 *
 * Above Expo's 16.4 default either way, which is why this is a plugin rather than
 * a line in a README: getting it wrong fails the build, and the fix is in a file
 * `expo prebuild` regenerates.
 */
const IOS_DEPLOYMENT_TARGET = '17.0';

/**
 * The one thing a Title app needs that its own config would not otherwise say.
 *
 * There is no Android half, and that is not an omission: upstream's manifest
 * records Title's Kotlin and JavaScript SDKs as `none`, and `Package.swift` marks
 * the model `appleOnly: true` with a comment saying why -- "`Title` is MLX, which
 * has no other platform, and a product promising an artifact that cannot load is
 * worse than its absence." So this package declares `"platforms": ["apple"]`,
 * ships no `android/` directory, and touches no `build.gradle`.
 *
 * It does not narrow Android ABIs either, and that absence is the point. Clear's,
 * Emo's, Ear's, Gist's, Redact's and Shapes' plugins narrow `abiFilters` because
 * each binds LiteRT and LiteRT ships two ABIs. Title binds nothing on Android at
 * all, so narrowing an app's ABIs on its behalf would take away devices for
 * models that can serve them -- the same reasoning Tongue's plugin wrote down for
 * the opposite reason.
 *
 * Nothing else is added. Title reads a string the app already has and writes two
 * shorter ones; there is no permission, no usage description, no background mode
 * and no entitlement. The ~280 MB model folder is an ordinary HTTPS download into
 * the app's cache, which needs no declaration on iOS.
 */
const withTitle: ConfigPlugin<void> = (config) => {
  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntTitle' has a minimum deployment target
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

export default createRunOncePlugin(withTitle, pkg.name, pkg.version);
