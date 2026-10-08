require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DesertAntEmo'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/emo/'

  # iOS 17 is the desert-ant-core package floor (`platforms:` in its
  # Package.swift), and it is the only floor in play here: Package.swift names
  # Emo among the models that "run on iOS 16 and keep it", `Sources/Emo` carries
  # no `@available`, and its catalog entry declares no `osFloor`, so
  # `emo.mlmodelc` would load lower. SwiftPM simply will not resolve the package
  # into a consumer below 17.
  #
  # So this is the lowest floor of any model pod in the family -- Clear and Clips
  # are at 18 because their Core ML artifacts are -- and an app installing Emo
  # alone is raised only this far.
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/react-native-feel/desert-ant-local-ai-sdks.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The Swift package itself is bridged in exactly once, by DesertAntCore, and
  # this pod links against that rather than declaring its own `spm_dependency`.
  #
  # That is not tidiness. Xcode links a package product's static library *into*
  # the linking pod's archive, so a second `spm_dependency` here would give
  # `libDesertAntEmo.a` its own copy of the thirteen shared desert-ant-core
  # objects the other model pods already have, and an app using two models would
  # fail to link with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # `import Emo` below still works: DesertAntCore names `Emo` among its products,
  # and the search path added here finds the swiftmodule it built.
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
