// One typealias, in a file with exactly one import, and both halves of that are
// the point.
//
// Redact's category enum is spelled `Label`, and so is SwiftUI's view. Any file
// here that imports `ExpoModulesCore` gets SwiftUI transitively -- its
// `ExpoSwiftUI` sources bring it in -- so the bare name is ambiguous and the pod
// does not compile:
//
//     error: 'Label' is ambiguous for type lookup in this context
//     note: found this candidate (Sources/Redact/Label.swift:5:13)
//     note: found this candidate (SwiftUI.Label:2:15)
//
// `Redact.Label` is not the fix: the module is named `Redact` and so is the class
// inside it, so a module-qualified spelling resolves to the class first and then
// fails to find a member type on it. A file that imports only `Redact` has no
// SwiftUI in scope, so the name is unambiguous here and everything else in this
// pod refers to `PIILabel` instead.
//
// Keep this file's import list at one line.

import Redact

/// `Redact.Label`: a category of personal information, e.g. `.email`.
///
/// Named for what it labels rather than for the module it comes from, because
/// the module is already spoken for.
typealias PIILabel = Label
