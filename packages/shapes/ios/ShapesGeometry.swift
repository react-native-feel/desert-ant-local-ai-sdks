// Two typealiases, in a file with exactly one import, and both halves of that are
// the point.
//
// This is the same technique `packages/redact/ios/RedactLabel.swift` uses, for
// the same reason and against a worse collision. Any file here that imports
// `ExpoModulesCore` gets SwiftUI transitively -- its `ExpoSwiftUI` sources bring
// it in -- and SwiftUI declares `Shape`. Upstream's fitted-geometry enum is also
// called `Shape`, so the bare name is ambiguous and the pod does not compile:
//
//     error: 'Shape' is ambiguous for type lookup in this context
//     note: found this candidate (Sources/Shapes/Shape.swift)
//     note: found this candidate (SwiftUI.Shape)
//
// `Shapes.Shape` is not the fix, and for a reason worth writing down because it
// is not obvious: the module is named `Shapes` and so is the recognizer class
// inside it, so a module-qualified spelling resolves to the class first and then
// fails to find a member type on it. A file that imports only `Shapes` has no
// SwiftUI in scope, so the names are unambiguous here and everything else in this
// pod refers to the aliases instead.
//
// `Point` is aliased alongside it as a matter of policy rather than of a
// diagnostic. Nothing in the current toolchain's transitive SwiftUI shadows it,
// but `Point` is a name a framework may reasonably take at any time, this model
// is the one package here that puts geometry across the bridge, and one extra
// line now is cheaper than the same investigation twice.
//
// Keep this file's import list at one line.

import Shapes

/// `Shapes.Shape`: the recognized, fitted geometry -- a line, rectangle,
/// triangle, ellipse or star.
///
/// Named for what it is rather than for the module it comes from, because the
/// module is already spoken for.
typealias FittedShape = Shape

/// `Shapes.Point`: a 2D point in the caller's own canvas coordinates, both on
/// the way in (the stroke) and on the way out (the fitted geometry).
typealias CanvasPoint = Point
