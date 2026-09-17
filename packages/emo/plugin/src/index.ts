import {
  createRunOncePlugin,
  withAppBuildGradle,
  withPodfileProperties,
  withXcodeProject,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/**
 * The `desert-ant-core` package floor -- `platforms:` in its Package.swift -- and
 * the only floor in play for Emo. Package.swift names Emo among the models that
 * "run on iOS 16 and keep it", `Sources/Emo` carries no `@available`, and its
 * catalog entry declares no `osFloor`, so `emo.mlmodelc` would load lower;
 * SwiftPM simply refuses to resolve the package into a consumer below 17.
 *
 * The lowest of any model in this family -- Clear and Clips need 18 for their
 * Core ML artifacts -- and still above Expo's 16.4 default, which is why this is
 * a plugin rather than a line in a README: getting it wrong fails the build, and
 * the fix is in a file `expo prebuild` regenerates.
 */
const IOS_DEPLOYMENT_TARGET = '17.0';

/** LiteRT ships these two. A build that also targets armeabi-v7a produces an APK
 *  whose Emo AAR has no matching `.so`, and the failure surfaces at model load
 *  rather than at build time -- so narrow it here. */
const ANDROID_ABIS = ['arm64-v8a', 'x86_64'];

const GRADLE_MARKER = '// @desert-ant-labs/react-native-emo';

/**
 * Any Desert Ant package's ABI block, not just this one's.
 *
 * Clear narrows the same two ABIs for the same LiteRT reason, and an app with
 * both installed runs both plugins over the same `build.gradle`. Matching only
 * this package's own marker would put a second `ndk { abiFilters ... }` inside
 * `defaultConfig` -- a duplicate that Gradle accepts and that says nothing new.
 * So each plugin defers to a block any of them already wrote, and the app ends up
 * with one.
 */
const ANY_DESERT_ANT_ABI_MARKER = /\/\/ @desert-ant-labs\/react-native-[a-z-]+: LiteRT ships/;

export interface EmoPluginProps {
  /**
   * Set false to leave the app's `abiFilters` alone -- for a project that already
   * manages its ABIs, or one deliberately shipping a 32-bit variant without Emo
   * on it.
   */
  restrictAbis?: boolean;
}

/**
 * Two things an Emo app needs that its own config would not otherwise say.
 *
 * Both are consequences of the native SDKs rather than choices this package is
 * making, which is why they are a plugin and not documentation: the iOS one fails
 * the build, and the Android one produces a runtime failure on a real device with
 * nothing said at build time.
 */
const withEmo: ConfigPlugin<EmoPluginProps | void> = (config, props) => {
  const restrictAbis = props?.restrictAbis ?? true;

  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntEmo' has a minimum deployment target
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

  if (restrictAbis) {
    config = withAppBuildGradle(config, (gradleConfig) => {
      gradleConfig.modResults.contents = withAbiFilters(gradleConfig.modResults.contents);
      return gradleConfig;
    });
  }

  return config;
};

/**
 * Raise every build configuration that already names a deployment target, and
 * leave alone any that does not -- a configuration inheriting the project-level
 * value should keep inheriting it rather than acquire a hardcoded one.
 *
 * Only ever raises, so this composes with the other Desert Ant plugins over the
 * same project whichever order they run in: the project ends up at the highest
 * floor any installed model needs, not at whichever plugin ran last. Emo's floor
 * is the lowest of the family, so in a multi-model app this usually changes
 * nothing.
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

/**
 * Insert an `ndk { abiFilters ... }` into the app's `defaultConfig`, once -- and
 * once across every Desert Ant plugin, not once per package.
 *
 * Anchored on `defaultConfig {` rather than appended to the file: a top-level
 * `android { }` block added at the end would be merged by Gradle but would also
 * be invisible to anyone reading the generated project, and `npx expo prebuild`
 * regenerates this file from scratch anyway.
 */
export function withAbiFilters(contents: string): string {
  if (ANY_DESERT_ANT_ABI_MARKER.test(contents)) {
    return contents;
  }
  const anchor = 'defaultConfig {';
  const index = contents.indexOf(anchor);
  if (index === -1) {
    // Nothing to anchor to. Leaving the file untouched is right: a build with
    // the wrong ABIs fails loudly at model load, while a mangled build.gradle
    // fails at every build for everyone.
    return contents;
  }
  const insertAt = index + anchor.length;
  const block = [
    '',
    `    ${GRADLE_MARKER}: LiteRT ships ${ANDROID_ABIS.join(' and ')} only.`,
    '    ndk {',
    `      abiFilters ${ANDROID_ABIS.map((abi) => `'${abi}'`).join(', ')}`,
    '    }',
  ].join('\n');
  return contents.slice(0, insertAt) + block + contents.slice(insertAt);
}

export default createRunOncePlugin(withEmo, pkg.name, pkg.version);
