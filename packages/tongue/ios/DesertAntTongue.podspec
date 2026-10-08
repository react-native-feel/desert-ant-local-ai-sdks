require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DesertAntTongue'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/tongue/'

  # iOS 17 is the desert-ant-core package floor (`platforms:` in its
  # Package.swift), and for Tongue it is the *only* floor in play. There is no
  # artifact floor to argue with: Tongue has no Core ML program and no LiteRT
  # graph -- the whole model is an int8 table and thirty lines of arithmetic, so
  # nothing here would refuse to load on an older OS. SwiftPM simply will not
  # resolve the package into a consumer below 17.
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
  # `libDesertAntTongue.a` its own copy of the shared desert-ant-core objects the
  # other model pods already have, and an app using two models would fail to link
  # with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # Tongue is the first product in that list to ship **resources** -- 2 MB of
  # int8 weights and a metadata JSON, declared as `.copy` in the package
  # manifest. Those travel with the package product, not with this pod, which is
  # why `TongueModel.swift` resolves them by searching the loaded bundles rather
  # than assuming a layout.
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
