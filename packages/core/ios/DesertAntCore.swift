// This pod is mostly a linking artifact -- see the long note in
// DesertAntCore.podspec -- but it is not empty, because the version its podspec
// pins is worth being able to read from Swift as well as from Ruby.
//
// There is no Expo module here and no `@JS` anything: nothing in this pod is
// reachable from JavaScript. The model packages' modules are.

import Foundation

/// The `desert-ant-core` Swift package version this app's model pods link
/// against. Kept in step with `DESERT_ANT_CORE_VERSION` in DesertAntCore.podspec
/// and with `NATIVE_CORE_VERSION` in each model module.
public enum DesertAntCoreVersion {
  public static let current = "3.1.0"
}
