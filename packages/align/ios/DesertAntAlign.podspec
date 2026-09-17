require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DesertAntAlign'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/align/'

  # iOS 17 is the desert-ant-core package floor (`platforms:` in its
  # Package.swift), and it is deliberately **not** Align's own 26.
  #
  # Align's product page says iOS 26, and it is right: the only public way to give
  # `SpeechTimestampRefiner` a transcript is `refine(_ result:
  # SpeechTranscriber.Result)`, which lives under `@available(iOS 26, ...)`
  # because `SpeechAnalyzer` does. But that is an availability constraint on two
  # functions, not on this pod's deployment target -- every Speech reference in
  # `ios/` is inside an `@available(iOS 26, *)` scope, so the pod compiles at 17
  # and refuses at runtime through `Align.isSupported`.
  #
  # Taking 26 here instead would have been the worse trade by some distance.
  # CocoaPods gives an app one deployment target, so an Align pod at 26 raises the
  # whole app to 26 -- including Shapes, Emo, Uhm and the rest, whose artifacts
  # load happily on 17 and whose users would lose eight major versions of devices
  # for a model they may not have installed. The same reasoning is already written
  # down in `packages/core/ios/DesertAntCore.podspec` for the mirror-image case:
  # the shared pod compiles at the package floor, each model pod keeps its own,
  # and the OS question each model actually has is answered at runtime.
  #
  # Unlike Clips, whose 18 is a real *artifact* floor -- `clips.mlmodelc` is a
  # Core ML multifunction package and an older OS refuses to load it -- Align's
  # artifacts are ordinary Core ML programs. `Sources/Align/Catalog.swift`
  # declares no `osFloor`, so it inherits `OSFloor.packageFloor` (iOS 16) and the
  # two stages really would load there. It is the API around them that does not
  # exist.
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/Desert-Ant-Labs/desert-ant-react-native.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The Swift package itself is bridged in exactly once, by DesertAntCore, and
  # this pod links against that rather than declaring its own `spm_dependency`.
  #
  # That is not tidiness. Xcode links a package product's static library *into*
  # the linking pod's archive, so a second `spm_dependency` here would give
  # `libDesertAntAlign.a` its own copy of the thirteen shared desert-ant-core
  # objects the other model pods already have, and an app using two models would
  # fail to link with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # `import Align` below still works: DesertAntCore names `Align` among its
  # products, and the search path added here finds the swiftmodule it built.
  #
  # `Align` is the one product in that list that does NOT reach the manifest
  # through `modelProducts`. It is Apple-only (Core ML, Speech, AVFoundation) and
  # so lives outside desert-ant-core's `models` array entirely, in its own
  # `alignProducts`. What matters is that `alignProducts` is summed into the
  # `products:` array -- `products + modelProducts + alignProducts +
  # vozProducts`, Package.swift line 546 -- which is the exact line
  # `tongueProducts` is missing from and why naming `Tongue` fails the build.
  # Checked on the pinned tag before this pod was written.
  s.dependency 'DesertAntCore'

  s.source_files = '**/*.{h,m,mm,swift}'

  # No `_NumericsShims` include path here, unlike Gist's, Redact's and Shapes'.
  # That line is needed for any desert-ant-core product whose `Package.swift`
  # entry names `.product(name: "RealModule", package: "swift-numerics")`, because
  # `RealModule` pulls a **clang** target whose module map lives only in the
  # SwiftPM checkout. Align's target declaration is
  # `.target(name: "Align", dependencies: [.byName(name: "DesertAnt")])` and
  # nothing else: its transcendental math is `Foundation.exp` and `log` inside
  # `StageModel`, so there is no C module to find and the rule does not apply.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # Where React Native's SPM helper leaves the package's built swiftmodules.
    # DesertAntCore links them; this pod only needs to see them to compile.
    'SWIFT_INCLUDE_PATHS' => '$(inherited) ${PODS_CONFIGURATION_BUILD_DIR} ' \
                             '${SYMROOT}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}'
  }
end
