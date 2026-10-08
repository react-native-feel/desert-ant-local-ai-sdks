require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The one place `desert-ant-core` is pulled into an app, and the one place its
# version is named.
#
# **Why this pod exists at all.** Every model here is a thin Expo module over a
# product of the same Swift package, and that package's shared targets --
# `DesertAnt`, `ModelStore`, `Usage`, `Inference`, `AudioIO`, `FFIBuffer`,
# `ModelCatalog`, `PlatformSupport`, `Regex`, `JSON`, `TextNormalization`,
# `JSHost`, `HostBridge` -- come along with each of them. Xcode links a package
# product's static library *into* the linking pod's own archive, so when two model
# pods each declared their own `spm_dependency`, `libDesertAntClear.a` and
# `libDesertAntVoz.a` both contained a full copy of those thirteen objects and an
# app with both failed to link:
#
#     ld: 1071 duplicate symbols
#     duplicate symbol 'type metadata for ModelStore.StoredModel' in:
#         libDesertAntClear.a[15](ModelStore.o)
#         libDesertAntVoz.a[14](ModelStore.o)
#
# Measured, not predicted -- Clear alone linked fine for months because one copy
# is not a duplicate. `use_frameworks! :linkage => :dynamic`, which React
# Native's own SPM helper suggests in its static-linking warning, does not fix it:
# both podspecs set `static_framework = true`, so they stay static frameworks and
# keep their embedded copies.
#
# So the bridge is declared exactly once, here, and the model pods depend on this
# one. Their Swift still says `import Clear` / `import Voz`; only the *linking*
# moved. The app gets one copy of the shared core instead of one per model, which
# is also the smaller binary.
DESERT_ANT_CORE_VERSION = '3.1.0'

# Every model product this SDK family can bind. Listed here rather than
# discovered, because a podspec is evaluated before CocoaPods knows which pods
# are in the target and guessing from directory layout differs between a
# monorepo checkout and node_modules.
#
# The cost is honest and bounded: an app that installs only one model package
# still links the other's Swift. No weights are involved -- every model in this
# catalog downloads its artifacts at runtime and the package bundles none -- so
# this is code size, not hundreds of megabytes. Adding a model to the family
# means adding it here.
#
# `Gist`, `Redact` and `Shapes` are the cases that prove the rule Tongue's
# absence states: each is a member of the `models` array in
# desert-ant-core's Package.swift, so each reaches the manifest through
# `modelProducts` -- which is literally `models.flatMap { ... }` -- and
# `products: products + modelProducts + alignProducts + vozProducts` does include
# that. Checked against those two lines before any of the three pods was written,
# because the failure mode is the build rather than the import.
#
# `Align`, added eleventh, is the one product in this list that does NOT reach the
# manifest through `modelProducts`, and it is worth saying so because the check to
# run on it is a different line. Align is Apple-only (Core ML, Speech,
# AVFoundation) and so lives outside desert-ant-core's `models` array entirely --
# Package.swift says as much above it: "it gets no Android/Node/Web products and
# no NativeBindings" -- in its own `alignProducts`, alongside `vozProducts`. What
# makes it safe to name here is that `products:` reads
# `products + modelProducts + alignProducts + vozProducts`, and `alignProducts` is
# in that sum. Read at Package.swift line 546 before the pod was written, because
# the failure mode is the build rather than the import.
#
# `Title`, added last, is the twelfth and completes the catalog. It reaches the
# manifest a third way again -- neither `modelProducts`' usual route nor Align's
# and Voz's bespoke arrays. It is Apple-only like those two, but unlike them it
# stays INSIDE the `models` array with `appleOnly: true`, and `modelProducts`
# branches on that flag: an `appleOnly` model maps to
# `[.library(name: model.name, targets: [model.name])]` alone -- one library, no
# `TitleAndroid`, no `TitleNode`, no `TitleWeb`. So `Title` resolves through the
# same `products + modelProducts + ...` sum as Clear and Emo, and naming it here
# is safe for the same reason. Read off Package.swift before the pod was written.
#
# Naming it also brings in a `Title` module whose generating half was COMPILED
# OUT, and that is worth stating here because this file is where the linking is
# decided. Title is MLX-backed, and MLX is behind desert-ant-core's `MLX` package
# TRAIT. `spm_dependency` below takes `url:`, `requirement:` and `products:` and
# nothing else -- react-native 0.86.3's scripts/cocoapods/spm.rb declares exactly
# `def dependency(pod_spec, url:, requirement:, products:)` -- so there is no
# argument to pass a trait through. Nor is there anywhere to put one afterwards:
# xcodeproj 1.27.0 has no trait attribute on any package-reference class (the
# string does not occur in the gem at all), and Xcode 26.4.1 mentions
# `enabledTraits` only inside PackageDescription's own `.swiftinterface`, with no
# `xcodebuild` flag for it. Traits are enabled by a consuming `Package.swift` or
# by `swift build --traits`, and a CocoaPods app is neither.
#
# The consequence is bounded and is NOT a link failure: the `Title` product
# resolves and links fine, `Card` and the `TitleModel` catalog entry are there,
# and `Titles` simply has no public initializer. `packages/title/ios` is written
# against that reality and its generating half is guarded by
# `#if canImport(MLXLMCommon)`, so if the trait ever becomes reachable it lights
# up with no change here.
#
# Enabling it via a vendored local wrapper package was considered and rejected:
# a trait is a property of the PACKAGE, so switching `MLX` on for this one pod
# switches it on for all twelve models, and an app installing only Shapes would
# clone mlx-swift, swift-transformers and swift-syntax and build host macro
# plugins. That is exactly the cost upstream's manifest says the trait exists to
# avoid.
#
# `Tongue` is deliberately NOT in this list, and it is the one model in the
# family that is missing from it. desert-ant-core v3.1.0 declares the product --
# `tongueProducts` in its Package.swift -- and then never adds it to the
# `products:` array the manifest is built from, which reads
# `products + modelProducts + alignProducts + vozProducts` with no
# `+ tongueProducts`. `swift package dump-package` on the pinned tag reports 45
# products, every other model among them and no `Tongue`; the only thing in the
# whole package that depends on the target is the `ModelCatalogTests` test
# target, which is why it has gone unnoticed.
#
# Naming it here does not fail at `import` time. It fails the build outright,
# before a line is compiled:
#
#     Missing package product 'Tongue' (in target 'DesertAntCore' from project 'Pods')
#
# When upstream adds those two words, adding `'Tongue'` here is the whole change
# on this side: `packages/tongue/ios` is already written against the module and
# guarded by `#if canImport(Tongue)`, so it lights up on its own.
DESERT_ANT_PRODUCTS = ['Clear', 'Voz', 'Clips', 'Uhm', 'Emo', 'Ear', 'Gist', 'Redact', 'Shapes', 'Align', 'Title'].freeze

Pod::Spec.new do |s|
  s.name           = 'DesertAntCore'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author'] || 'Desert Ant Labs'
  s.homepage       = package['homepage'] || 'https://desertant.com/'

  # The desert-ant-core package's own floor (`platforms:` in its Package.swift),
  # which is what *compiling* every product it bridges requires.
  #
  # Deliberately NOT the highest floor among those products. Clear's pod says
  # iOS 18, but that is its Core ML artifact's runtime floor -- `clear-studio.mlmodelc`
  # is built for that deployment target and an older OS refuses to load it -- not
  # a constraint on building the Swift. Taking 18 here would have made this pod
  # unbuildable in an app that installs only Voz, whose config plugin raises the
  # app to 17: the pod would out-rank the app and fail with "module
  # 'DesertAntCore' has a minimum deployment target of iOS 18.0".
  #
  # So: the shared pod compiles at the package floor, each model pod keeps its own
  # floor, and each model's config plugin raises the app to what that model needs.
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/react-native-feel/desert-ant-local-ai-sdks.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # desert-ant-core ships as a Swift package only -- no podspec, no XCFramework --
  # so it comes in through React Native's SPM bridge (RN 0.75+,
  # scripts/react_native_pods.rb).
  # `respond_to?` needs the private flag: `spm_dependency` is a top-level `def` in
  # react_native_pods.rb, which Ruby makes a *private* instance method on Object,
  # so the public-only check reports false even when the helper is right there.
  if respond_to?(:spm_dependency, true)
    spm_dependency(s,
      url: 'https://github.com/Desert-Ant-Labs/desert-ant-core.git',
      requirement: { kind: 'upToNextMajorVersion', minimumVersion: DESERT_ANT_CORE_VERSION },
      products: DESERT_ANT_PRODUCTS
    )
  else
    raise <<~MSG
      DesertAntCore needs the `spm_dependency` helper from React Native's
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
