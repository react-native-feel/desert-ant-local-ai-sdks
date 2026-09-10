import {
  createRunOncePlugin,
  withAppBuildGradle,
  withPodfileProperties,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/** The Core ML artifact's floor, not the code's: `clear-studio.mlmodelc` is
 *  built for this deployment target and an older OS refuses to load it. */
const IOS_DEPLOYMENT_TARGET = '18.0';

/** LiteRT ships these two. A build that also targets armeabi-v7a produces an APK
 *  whose Clear AAR has no matching `.so`, and the failure surfaces at model load
 *  rather than at build time -- so narrow it here. */
const ANDROID_ABIS = ['arm64-v8a', 'x86_64'];

const GRADLE_MARKER = '// @desert-ant-labs/react-native-clear';

export interface ClearPluginProps {
  /**
   * Set false to leave the app's `abiFilters` alone -- for a project that
   * already manages its ABIs, or one deliberately shipping a 32-bit variant
   * without Clear on it.
   */
  restrictAbis?: boolean;
}

/**
 * Two things a Clear app needs that its own config would not otherwise say.
 *
 * Both are consequences of the native SDKs rather than choices this package is
 * making, which is why they are a plugin and not documentation: getting either
 * wrong produces a runtime failure on a real device and nothing at build time.
 */
const withClear: ConfigPlugin<ClearPluginProps | void> = (config, props) => {
  const restrictAbis = props?.restrictAbis ?? true;

  config = withPodfileProperties(config, (podfileConfig) => {
    const current = podfileConfig.modResults['ios.deploymentTarget'];
    if (!current || parseFloat(current) < parseFloat(IOS_DEPLOYMENT_TARGET)) {
      podfileConfig.modResults['ios.deploymentTarget'] = IOS_DEPLOYMENT_TARGET;
    }
    return podfileConfig;
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
 * Insert an `ndk { abiFilters ... }` into the app's `defaultConfig`, once.
 *
 * Anchored on `defaultConfig {` rather than appended to the file: a top-level
 * `android { }` block added at the end would be merged by Gradle but would also
 * be invisible to anyone reading the generated project, and `npx expo prebuild`
 * regenerates this file from scratch anyway.
 */
export function withAbiFilters(contents: string): string {
  if (contents.includes(GRADLE_MARKER)) {
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

export default createRunOncePlugin(withClear, pkg.name, pkg.version);
