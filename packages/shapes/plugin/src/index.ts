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
 * the only floor in play for Shapes. `Sources/Shapes` carries no `@available` and
 * its catalog entry declares no `osFloor`, so `shapes.mlmodelc` would load lower;
 * SwiftPM simply refuses to resolve the package into a consumer below 17.
 *
 * Tied with Emo, Uhm, Ear, Tongue, Gist and Redact for the lowest in this family
 * -- Clear and Clips need 18 for their Core ML artifacts -- and still above
 * Expo's 16.4 default, which is why this is a plugin rather than a line in a
 * README: getting it wrong fails the build, and the fix is in a file
 * `expo prebuild` regenerates.
 */
const IOS_DEPLOYMENT_TARGET = '17.0';

/** LiteRT ships these two. A build that also targets armeabi-v7a produces an APK
 *  whose Shapes AAR has no matching `.so`, and the failure surfaces at model load
 *  rather than at build time -- so narrow it here.
 *
 *  Shapes needs this half, and the reason is worth stating because the model
 *  makes the wrong guess tempting. Its fitters and its snapping are pure portable
 *  arithmetic -- that is the whole point of upstream replacing `simd` with its own
 *  `V2` -- so it would be easy to assume a pure-Kotlin AAR like Tongue's, which
 *  writes nothing here. It is not one: stage one is a neural classifier, the
 *  catalog ships `shapes.tflite` for `.android`, and
 *  `ShapesNative.ensureLoaded()` in `ai.desertant:shapes` calls
 *  `NativeLibraries.loadModel("ShapesAndroid")` -- a JNI `.so`. What settles the
 *  question is whether the Kotlin SDK has a `NativeModelApi` under it, and this
 *  one does. */
const ANDROID_ABIS = ['arm64-v8a', 'x86_64'];

const GRADLE_MARKER = '// @desert-ant-labs/react-native-shapes';

/**
 * Any Desert Ant package's ABI block, not just this one's.
 *
 * Clear, Emo, Ear, Gist and Redact narrow the same two ABIs for the same LiteRT
 * reason, and an app with more than one of them installed runs every one of those
 * plugins over the same `build.gradle`. Matching only this package's own marker
 * would put a sixth `ndk { abiFilters ... }` inside `defaultConfig` -- a duplicate
 * that Gradle accepts and that says nothing new. So each plugin defers to a block
 * any of them already wrote, and the app ends up with one.
 */
const ANY_DESERT_ANT_ABI_MARKER = /\/\/ @desert-ant-labs\/react-native-[a-z-]+: LiteRT ships/;

export interface ShapesPluginProps {
  /**
   * Set false to leave the app's `abiFilters` alone -- for a project that already
   * manages its ABIs, or one deliberately shipping a 32-bit variant without
   * Shapes on it.
   */
  restrictAbis?: boolean;
}

/**
 * Two things a Shapes app needs that its own config would not otherwise say.
 *
 * Both are consequences of the native SDKs rather than choices this package is
 * making, which is why they are a plugin and not documentation: the iOS one fails
 * the build, and the Android one produces a runtime failure on a real device with
 * nothing said at build time.
 *
 * Notably absent: anything about permissions. This is the first model in the
 * family whose input comes from the screen rather than from the microphone or a
 * file, so there is nothing to ask the user for beyond the INTERNET the weights
 * download needs -- which the Android manifest in this package declares itself.
 */
const withShapes: ConfigPlugin<ShapesPluginProps | void> = (config, props) => {
  const restrictAbis = props?.restrictAbis ?? true;

  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntShapes' has a minimum deployment
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
 * floor any installed model needs, not at whichever plugin ran last. Shapes'
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

export default createRunOncePlugin(withShapes, pkg.name, pkg.version);
