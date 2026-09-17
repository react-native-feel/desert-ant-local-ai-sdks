require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DesertAntShapes'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/shapes/'

  # iOS 17 is the desert-ant-core package floor (`platforms:` in its
  # Package.swift), not Shapes' own: `Sources/Shapes` carries no `@available` and
  # its catalog entry declares no `osFloor`, so it inherits
  # `OSFloor.packageFloor` (iOS 16) and `shapes.mlmodelc` would load lower --
  # SwiftPM simply will not resolve the package into a consumer below 17. Like
  # Ear, Gist and Redact and unlike Clips there is nothing to check at runtime:
  # the artifact is an ordinary Core ML program, not a multifunction one, so the
  # declared floor and the artifact's real floor agree.
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
  # `libDesertAntShapes.a` its own copy of the thirteen shared desert-ant-core
  # objects the other model pods already have, and an app using two models would
  # fail to link with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # `import Shapes` below still works: DesertAntCore names `Shapes` among its
  # products, and the search path added here finds the swiftmodule it built.
  #
  # Unlike Tongue, this product genuinely exists. `Shapes` is a member of the
  # `models` array in desert-ant-core's Package.swift (the `.init(name: "Shapes",
  # ...)` entry), so `modelProducts` -- which is `models.flatMap { ... }` --
  # carries it into `products: products + modelProducts + alignProducts +
  # vozProducts`, and that is the exact line `tongueProducts` is missing from.
  # Both lines were read before any of this was written, because the alternative
  # fails the build rather than the import.
  s.dependency 'DesertAntCore'

  s.source_files = '**/*.{h,m,mm,swift}'

  # Shapes is the third product in this family with a *transitive C module*,
  # after Gist and Redact, and it needs the same line for the same reason. This
  # is now a rule rather than an incident: if `Package.swift` gives the target
  # `.product(name: "RealModule", package: "swift-numerics")`, the pod needs this
  # include path.
  #
  # Shapes' reason for depending on swift-numerics is the most explicit of the
  # three -- `Package.swift` carries a comment above its entry saying it: "The
  # geometric fitters and snapping replace `simd` (Apple-only) with a portable
  # V2, so their transcendental math comes from swift-numerics." `Sources/Shapes`
  # then imports `RealModule` in `Geometry.swift`, `Shape.swift`, `Fitter.swift`
  # and `Snapping.swift` for `Double.cos`, `Double.sin` and `Double.atan2`.
  #
  # `RealModule` in turn depends on `_NumericsShims`, a **clang** target whose
  # module map is a file in the package checkout rather than something Xcode
  # regenerates into `GeneratedModuleMaps-<platform>/`. So `import Shapes` fails
  # to build this pod with, and only with:
  #
  #     <unknown>:0: error: missing required module '_NumericsShims'
  #
  # The swiftmodules themselves are found: React Native's SPM helper adds
  # `${SYMROOT}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}` and Shapes',
  # RealModule's and DesertAnt's are all there. What is missing is the module
  # *map* for the C half, which lives only in the checkout.
  #
  # `SWIFT_INCLUDE_PATHS` is the right lever rather than `HEADER_SEARCH_PATHS`
  # because Swift forwards `-I` to the clang importer as well, and clang finds a
  # `module.modulemap` by scanning its include paths. `${SYMROOT}` is
  # `<DerivedData>/<project>/Build/Products`, so two levels up is where SwiftPM
  # puts its checkouts.
  #
  # This names another package's source layout, which is the part to dislike. It
  # is the narrowest fix available from a podspec -- CocoaPods evaluates this
  # before the SPM package is even resolved, so there is nothing to ask -- and a
  # path that stops existing costs nothing: an include path that is not there is
  # ignored, and the failure it would cause is the same build error with the same
  # message.
  source_packages = '${SYMROOT}/../../SourcePackages/checkouts'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # Where React Native's SPM helper leaves the package's built swiftmodules.
    # DesertAntCore links them; this pod only needs to see them to compile.
    'SWIFT_INCLUDE_PATHS' => '$(inherited) ${PODS_CONFIGURATION_BUILD_DIR} ' \
                             '${SYMROOT}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME} ' \
                             "#{source_packages}/swift-numerics/Sources/_NumericsShims/include"
  }
end
