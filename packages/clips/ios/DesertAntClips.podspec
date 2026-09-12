require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DesertAntClips'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/clips/'

  # iOS 18 is the Core ML artifact's floor, not the code's: `clips.mlmodelc` is a
  # MULTIFUNCTION package -- two graphs over one stored copy of a shared trunk --
  # and multifunction is an iOS 18 feature; the compiled artifact declares
  # specificationVersion 9. `Sources/Clips` carries no `@available` and would
  # compile lower, which is exactly why the module checks
  # `ClipModel.osFloor.isSatisfiedHere` at runtime: nothing upstream enforces the
  # floor it declares.
  s.platforms      = { :ios => '18.0' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/Desert-Ant-Labs/desert-ant-react-native.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The Swift package itself is bridged in exactly once, by DesertAntCore, and
  # this pod links against that rather than declaring its own `spm_dependency`.
  #
  # That is not tidiness. Xcode links a package product's static library *into*
  # the linking pod's archive, so a second `spm_dependency` here would give
  # `libDesertAntClips.a` its own copy of the thirteen shared desert-ant-core
  # objects the other model pods already have, and an app using two models would
  # fail to link with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # `import Clips` below still works: DesertAntCore names `Clips` among its
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
