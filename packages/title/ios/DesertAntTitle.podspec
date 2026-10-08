require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DesertAntTitle'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/models/title/'

  # iOS 17, and for once every floor in play agrees on it.
  #
  # It is the desert-ant-core package floor (`platforms:` in its Package.swift),
  # and it is also Title's own artifact floor -- `Sources/Title/Catalog.swift`
  # declares `osFloor = OSFloor.mlx`, which is iOS 17 / macOS 14. Those two are
  # normally independent (Clear's pod says 18 for its Core ML artifact while the
  # shared pod says 17; Align's pod says 17 for an API that needs 26), and here
  # they coincide for a reason worth writing down rather than a coincidence:
  # MLX's floor is a DEPENDENCY floor, not an artifact one, so it could not be
  # expressed with `@available` the way Clips' iOS 18 is. Package.swift says so
  # directly -- "SwiftPM refuses to resolve `MLXLLM` (macOS 14) into a macOS 13
  # package" -- and so the whole package had to rise to meet it. That is why
  # every other model in this family lost iOS 16, and Title is the reason.
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
  # `libDesertAntTitle.a` its own copy of the thirteen shared desert-ant-core
  # objects the other model pods already have, and an app using two models would
  # fail to link with ~1,071 duplicate symbols. Measured; see the note in
  # packages/core/ios/DesertAntCore.podspec.
  #
  # `Title` reaches desert-ant-core's manifest through `modelProducts`, which is
  # worth checking rather than assuming because it is Apple-only and the other
  # Apple-only models do not. `Package.swift` appends
  # `ModelPackage(name: "Title", dependencies: [.byName(name: "Transcript")] +
  # mlxProducts, appleOnly: true)` to the `models` array, and `modelProducts` maps
  # an `appleOnly` model to `[.library(name: model.name, targets: [model.name])]`
  # -- one library product, no Android/Node/Web ones. `products:` sums
  # `modelProducts` in, so `Title` resolves. Align and Voz get there the other
  # way, through their own `alignProducts` and `vozProducts`; `Tongue` does not
  # get there at all, which is why that one word is missing from
  # DESERT_ANT_PRODUCTS and this one is in it.
  s.dependency 'DesertAntCore'

  s.source_files = '**/*.{h,m,mm,swift}'

  # THE ONE THING THIS POD CANNOT DO, recorded where a reader of the build
  # configuration will find it.
  #
  # Title is MLX-backed, and MLX is behind a SwiftPM package TRAIT -- `MLX`, in
  # desert-ant-core's `Package.swift`. A trait is enabled by a consuming
  # `Package.swift` (`.package(url: ..., traits: ["MLX"])`) or by
  # `swift build --traits MLX`, and by nothing else that exists today:
  #
  #   * react-native 0.86.3's `spm_dependency` is
  #     `def dependency(pod_spec, url:, requirement:, products:)` -- no traits
  #     parameter, and `add_spm_to_target` sets only `repositoryURL`,
  #     `requirement` and `product_name`.
  #   * xcodeproj 1.27.0, the gem that writes Pods.xcodeproj, contains the string
  #     "trait" nowhere in its source, so a `post_install` hook has no attribute
  #     to set on `XCRemoteSwiftPackageReference` or
  #     `XCSwiftPackageProductDependency`.
  #   * Xcode 26.4.1 mentions `enabledTraits` in exactly two files, both of them
  #     PackageDescription's `.swiftinterface`. No IDE framework and no
  #     `xcodebuild` flag knows about traits at all.
  #
  # So this pod links a `Title` module that compiled without its `#if MLX` half:
  # `Card` and the catalog are there, `Titles` has no public initializer, and
  # generation is absent. The code that would use it is written and guarded by
  # `#if canImport(MLXLMCommon)` in ios/TitleModelObject.swift, and the day the
  # trait can be turned on it compiles itself in. Nothing in this file changes
  # then -- there is deliberately no half-measure here, no `OTHER_SWIFT_FLAGS`
  # with `-DMLX` in it, because defining the condition without the dependency in
  # the graph would fail at `import MLXLMCommon` inside someone else's module.
  #
  # No `_NumericsShims` include path, unlike Gist's, Redact's and Shapes'. That
  # line is needed for any desert-ant-core product whose Package.swift entry names
  # `.product(name: "RealModule", package: "swift-numerics")`, because `RealModule`
  # pulls a clang target whose module map lives only in the SwiftPM checkout.
  # Title's dependencies are `Transcript` plus `mlxProducts`, and `mlxProducts` is
  # pruned without the trait, so there is no C module to find. Checked against the
  # manifest before this pod was written, because the failure mode is the build.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # Where React Native's SPM helper leaves the package's built swiftmodules.
    # DesertAntCore links them; this pod only needs to see them to compile.
    'SWIFT_INCLUDE_PATHS' => '$(inherited) ${PODS_CONFIGURATION_BUILD_DIR} ' \
                             '${SYMROOT}/${CONFIGURATION}${EFFECTIVE_PLATFORM_NAME}'
  }
end
