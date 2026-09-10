// A block of PCM that lives in Swift and is filled or drained from JavaScript
// one channel at a time.
//
// Why this exists instead of passing arrays through the call itself: the model's
// output is float samples, and expo-modules-core (57) can hand JavaScript a
// `Float32Array` only by re-using one JavaScript already owns -- `ArrayBuffer`
// and `NativeArrayBuffer` are not `JavaScriptCodable`, so a Swift-allocated
// buffer has no return path through the `@JS` macro. A shared object that the
// caller drains into its own `Float32Array` is the honest shape of that
// constraint, costs one memcpy per channel, and keeps every typed-array touch on
// the JS thread where it is safe. It also matches Android, whose typed arrays
// have the same rule.
//
// A minute of 48 kHz mono is ~11 MB, which is why `enhanceFile` -- not this --
// is the primary API.

import ExpoModulesCore
import Clear

@SharedObject("ClearAudio")
final class ClearAudioObject: SharedObject {
  /// One entry per channel, all the same length.
  ///
  /// There is deliberately no `release()` here: `SharedObject` already declares
  /// one, whose whole job is to detach the JS object from this native one so it
  /// deallocates -- which frees these arrays. Adding a second `release` would
  /// shadow the built-in on the prototype and leave the native object alive.
  private(set) var channels: [[Float]]

  /// Set on a buffer that came out of `enhance`; zeroed on one JavaScript built.
  var enhancedMetrics = ClearMetrics()

  /// Allocate a silent buffer for JavaScript to fill with `write`.
  @JS
  init(channelCount: Int, frameCount: Int, sampleRate: Double) throws {
    guard channelCount > 0, frameCount >= 0, sampleRate > 0 else {
      throw InvalidBufferShapeException((channelCount, frameCount))
    }
    self.channels = Array(repeating: [Float](repeating: 0, count: frameCount), count: channelCount)
    self.rate = sampleRate
    super.init()
  }

  /// Wrap what the model produced.
  init(result: Clear.Result) {
    self.channels = result.channels
    self.rate = result.sampleRate
    self.enhancedMetrics = clearMetrics(from: result)
    super.init()
  }

  private let rate: Double

  @JS
  var channelCount: Int { channels.count }

  @JS
  var frameCount: Int { channels.first?.count ?? 0 }

  @JS
  var sampleRate: Double { rate }

  /// Zeroed unless this buffer came out of an `enhance` call.
  @JS
  var metrics: ClearMetrics { enhancedMetrics }

  /// Copy `data` into `channel`. `data.length` must equal `frameCount`.
  @JS
  func write(_ channel: Int, _ data: Float32Array) throws {
    let count = try checked(channel, data.length)
    guard count > 0 else { return }
    let source = data.rawPointer.assumingMemoryBound(to: Float.self)
    channels[channel].withUnsafeMutableBufferPointer { destination in
      destination.baseAddress?.update(from: source, count: count)
    }
  }

  /// Copy `channel` out into `into`. `into.length` must equal `frameCount`.
  @JS
  func read(_ channel: Int, _ into: Float32Array) throws {
    let count = try checked(channel, into.length)
    guard count > 0 else { return }
    let destination = into.rawPointer.assumingMemoryBound(to: Float.self)
    channels[channel].withUnsafeBufferPointer { source in
      if let base = source.baseAddress {
        destination.update(from: base, count: count)
      }
    }
  }

  private func checked(_ channel: Int, _ length: Int) throws -> Int {
    guard channel >= 0, channel < channels.count else {
      throw ChannelOutOfRangeException((channel, channels.count))
    }
    let expected = channels[channel].count
    guard length == expected else {
      throw FrameCountMismatchException((length, expected))
    }
    return expected
  }
}

internal final class InvalidBufferShapeException: GenericException<(Int, Int)> {
  override var code: String { "ERR_INVALID_ARGUMENT" }
  override var reason: String {
    "A ClearAudio needs at least one channel and a non-negative frame count; got \(param.0) x \(param.1)."
  }
}
