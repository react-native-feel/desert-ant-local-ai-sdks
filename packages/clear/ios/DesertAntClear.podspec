require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

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
  s.source         = { git: 'https://github.com/react-native-feel/desert-ant-local-ai-sdks.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The Swift package itself is bridged in exactly once, by DesertAntCore, and
  # this pod links against that rather than declaring its own `spm_dependency`.
  #
  # That is not tidiness. Xcode links a package product's static library *into*
  # the linking pod's archive, so a second `spm_dependency` here would give
  # `libDesertAntClear.a` its own copy of the thirteen shared desert-ant-core
  # objects that `libDesertAntVoz.a` already has, and an app using both models
  # would fail to link with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # `import Clear` below still works: DesertAntCore names `Clear` among its
  # products, and the search path added here finds the swiftmodule it built.
  s.dependency 'DesertAntCore'

  s.source_files = '**/*.{h,m,mm,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # Where React Native's SPM helper leaves the package's built swiftmodules.
    # DesertAntCore links them; this pod only needs to see them to compile.
    'SWIFT_INCLUDE_PATHS' => '$(inherited) ${PODS_CONFIGURATION_BUILD_DIR} ' \
                             '${SYMROOT}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}'
  }
end
