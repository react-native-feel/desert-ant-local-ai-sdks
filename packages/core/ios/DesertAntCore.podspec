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
DESERT_ANT_PRODUCTS = ['Clear', 'Voz', 'Clips', 'Uhm'].freeze

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
  s.source         = { git: 'https://github.com/Desert-Ant-Labs/desert-ant-react-native.git' }
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
