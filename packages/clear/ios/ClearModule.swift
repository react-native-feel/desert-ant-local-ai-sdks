// The module itself is almost empty: everything stateful is a shared object, so
// an app can hold several models (different variants, different weight
// directories) at once instead of talking to one global.
//
// Written against the Expo Modules 2.0 macros (`@ExpoModule`, `@JS`,
// `@SharedObject`, `@Record`, `@Event`), which ship in expo-modules-core 57 for
// Apple platforms. The Android half of this SDK is the classic Kotlin DSL,
// because 2.0 has no Kotlin implementation yet -- the two produce the same
// JavaScript surface, which is the point.

import ExpoModulesCore

@ExpoModule("DesertAntClear", classes: [ClearModelObject.self, ClearAudioObject.self])
public final class ClearModule: Module {
  /// Whether this build can run Clear at all. Always true on Apple: the podspec's
  /// iOS 18 floor is what would otherwise be checked here, and it is enforced at
  /// install time. Android answers this for real (32-bit ABIs cannot load the
  /// native core).
  @JS
  var isSupported: Bool { true }

  /// The desert-ant-core version this binary links against. Worth surfacing: the
  /// Apple and Android halves share an FFI payload schema, and a bug report that
  /// names both versions is a bug report that can be triaged.
  @JS
  var nativeCoreVersion: String { "3.1.0" }
}
