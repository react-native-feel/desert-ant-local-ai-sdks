require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The version of desert-ant-core this SDK binds against. Bump both this and the
# Android coordinate in android/build.gradle together -- the two native SDKs
# share an FFI payload schema, so a mixed pair is a silent wire mismatch, not a
# build error.
DESERT_ANT_CORE_VERSION = '3.1.0'

Pod::Spec.new do |s|
  s.name           = 'DesertAntClear'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/clear/'

  # iOS 18 is the Core ML artifact's floor, not ours: clear-studio.mlmodelc is
  # built for that deployment target and an older OS refuses to load it. This is
  # above Expo's own 16.4 default, so a consuming app has to raise
  # `ios.deploymentTarget` -- which is exactly what the bundled config plugin
  # (app.plugin.js) does.
  s.platforms      = { :ios => '18.0' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/Desert-Ant-Labs/desert-ant-react-native.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # desert-ant-core ships as a Swift package only -- no podspec, no XCFramework
  # -- so it comes in through React Native's SPM bridge (RN 0.75+,
  # scripts/react_native_pods.rb). `Clear` pulls DesertAnt, AudioIO and AudioDSP
  # transitively; naming only the product we use keeps the other models' Core ML
  # graphs out of the binary.
  if respond_to?(:spm_dependency)
    spm_dependency(s,
      url: 'https://github.com/Desert-Ant-Labs/desert-ant-core.git',
      requirement: { kind: 'upToNextMajorVersion', minimumVersion: DESERT_ANT_CORE_VERSION },
      products: ['Clear']
    )
  else
    raise <<~MSG
      DesertAntClear needs the `spm_dependency` helper from React Native's
      CocoaPods scripts (React Native 0.75+ / Expo SDK 54+). It was not in scope
      when this podspec was evaluated, which usually means the app's Podfile does
      not require react_native_pods.rb, or React Native is too old.
    MSG
  end

  s.source_files = '**/*.{h,m,mm,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
