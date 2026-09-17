import {
  createRunOncePlugin,
  withPodfileProperties,
  withXcodeProject,
  type ConfigPlugin,
} from '@expo/config-plugins';

const pkg = require('../../package.json');

/**
 * The `desert-ant-core` package floor -- `platforms:` in its Package.swift -- and
 * deliberately **not** Align's own iOS 26.
 *
 * Align needs iOS 26 to do anything: the only public way to hand
 * `SpeechTimestampRefiner` a transcript is `refine(_ result:
 * SpeechTranscriber.Result)`, and `SpeechAnalyzer` is iOS 26. But that is an
 * availability constraint on two functions inside the pod, not a deployment
 * target for the app -- `packages/align/ios` names every Speech type inside an
 * `@available(iOS 26, *)` scope, so the pod builds at 17 and `Align.isSupported`
 * reports false below 26.
 *
 * Raising the app to 26 here would be the one change in this plugin family that
 * takes devices away rather than adding a floor: an app that installs Align
 * alongside Shapes or Emo would lose every device below iOS 26 for *those*
 * models too, which run fine on 17. The rule the other ten plugins follow --
 * raise to what this model needs to build, and answer what it needs to run at
 * runtime -- gives the honest result here as well.
 *
 * Above Expo's 16.4 default either way, which is why this is a plugin rather than
 * a line in a README: getting it wrong fails the build, and the fix is in a file
 * `expo prebuild` regenerates.
 */
const IOS_DEPLOYMENT_TARGET = '17.0';

/**
 * One thing an Align app needs that its own config would not otherwise say.
 *
 * There is no Android half here, and that is not an omission: upstream's manifest
 * records Align's Kotlin and JS SDKs as `none`, and `Package.swift` puts the
 * target outside the `models` array with a comment saying why -- "Align is
 * Apple-only (Core ML, Speech, AVFoundation), so it lives outside the `models`
 * list: it gets no Android/Node/Web products and no NativeBindings." So this
 * package declares `"platforms": ["apple"]`, ships no `android/` directory, and
 * touches no `build.gradle`. An Android build links nothing and
 * `Align.isSupported` reports false at runtime.
 *
 * Nothing else is added either. Align reads an audio file the app already has and
 * runs Apple's on-device recognizer over it; there is no microphone permission to
 * declare here (an app that records its own audio declares that for the
 * recorder), no `NSSpeechRecognitionUsageDescription` -- that string is for
 * `SFSpeechRecognizer`, whose server path sends audio to Apple, and
 * `SpeechAnalyzer` is on-device and does not require it -- and no background
 * mode.
 */
const withAlign: ConfigPlugin<void> = (config) => {
  // Both halves are required, and neither is sufficient. The Podfile reads the
  // properties file to pick its `platform :ios`, but React Native's post-install
  // then aligns every pod target to the *app project's* deployment target -- so
  // leaving the .xcodeproj at Expo's 16.4 default makes the pods 16.4 too, and
  // the build fails with "module 'DesertAntAlign' has a minimum deployment target
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

export default createRunOncePlugin(withAlign, pkg.name, pkg.version);
