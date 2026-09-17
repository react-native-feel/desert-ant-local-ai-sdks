// One small file of typealiases, written before the first compile rather than
// after it.
//
// This repo has lost time three times to a model whose vocabulary collides with
// a framework's. Redact hit `SwiftUI.Label` and had to disambiguate after the
// error; Shapes pre-empted `SwiftUI.Shape` and `Point`; Align had to watch
// `Transcript`, which is both a desert-ant-core module and a word Apple's Speech
// framework uses freely. Title arrives with two of the most generic nouns in the
// catalog -- `Card` and `Title` -- so both are pinned here and nothing below
// names either bare.
//
// `Card` is the live risk. It is a two-field value type in a module called
// `Title`, and "Card" is a word every UI framework is one release away from
// taking: SwiftUI has no `Card` today, and a file in this pod that said `Card`
// unqualified would start failing the day it does. `UpstreamCard` says which one
// is meant and keeps saying it.
//
// `Title` is the module, not a type -- the actor is `Titles` and the catalog
// entry is `TitleModel` -- so there is nothing to alias, and the rule is simply
// that no Swift type in this pod may be called `Title`. The JavaScript class is,
// and that is a different namespace. `TitleModelObject` is the Swift name of the
// shared object whose JS name is `TitleModel`, exactly as `AlignModelObject` is
// the Swift name behind Align's `AlignModel`; upstream's `TitleModel` enum keeps
// the bare name, which is what every reference to the catalog below reads.

import Title

/// Upstream's `Title.Card`: a title and a description, and nothing else.
///
/// Available with or without the `MLX` trait -- `Card` is outside the `#if MLX`
/// in `Sources/Title/Title.swift`, along with the prompt and the parser. Being
/// *outside* the gate and being *reachable* are not the same thing, and only the
/// first is true of the other two; see `TitleModule.swift`.
typealias UpstreamCard = Title.Card
