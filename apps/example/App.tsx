import {
  Align,
  timestampShift,
  type AlignedTranscript,
} from '@desert-ant-labs/react-native-align';
import {
  Clear,
  DesertAntError,
  type ClearMetrics,
  type ProgressEvent,
} from '@desert-ant-labs/react-native-clear';
import { Clips, type Clip } from '@desert-ant-labs/react-native-clips';
import { Ear, type Detection } from '@desert-ant-labs/react-native-ear';
import { Emo, type EmojiSkinTone, type EmoSuggestion } from '@desert-ant-labs/react-native-emo';
import {
  Gist,
  channelTopics,
  type ChannelTopic,
  type Tagging,
} from '@desert-ant-labs/react-native-gist';
import {
  Redact,
  restore,
  type Redaction,
} from '@desert-ant-labs/react-native-redact';
import {
  Shapes,
  isClosed,
  outline,
  type Point as CanvasPoint,
  type Recognition as ShapeRecognition,
  type Shape as FittedShape,
} from '@desert-ant-labs/react-native-shapes';
import { Tongue, type Detection as TextDetection } from '@desert-ant-labs/react-native-tongue';
import { Uhm, type UhmResult } from '@desert-ant-labs/react-native-uhm';
import { Voz, type Transcript } from '@desert-ant-labs/react-native-voz';
import { File, Paths } from 'expo-file-system';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

/**
 * One recording, five models, in the order they compose: record, enhance it on
 * device with Clear, ask Ear what language it is in, transcribe the enhanced
 * audio with Voz, hand that transcript to Clips to find the moments worth
 * cutting, and run Uhm over the same audio to find every "um" in it.
 *
 * Ear's place in that order is the point of it. Voz does not detect what it is
 * hearing -- audio outside its 25 languages comes back as confident nonsense
 * rather than an error -- and its own documentation says to establish the
 * language some other way first. Ear is that other way, and this app does the
 * comparison out loud: it identifies the recording, checks the answer against
 * `Voz.supportedLanguages`, and says so when the two disagree.
 *
 * Then two that are not in that chain at all, both reading text rather than
 * audio. Emo has its own field at the bottom: type a phrase and the emoji that
 * fit it come back. Tongue has another: type a phrase and it names the language
 * it is in.
 *
 * Tongue is the one worth watching next to Ear, because the two answer the same
 * question from different evidence -- Ear from the waveform, Tongue from the
 * words. So this app asks both about the same recording whenever it has a
 * transcript for one: Ear identifies the audio, Voz reads it, and Tongue reads
 * what Voz wrote. Two independent models agreeing is worth more than either
 * alone, and where they disagree, the disagreement is the interesting output.
 *
 * And one that is in neither medium. Shapes reads a *stroke* -- a list of x, y
 * points off the screen -- so its section at the bottom is a canvas rather than a
 * field: draw with a finger and the wobbly loop comes back an exact circle. It is
 * the only model here with no text and no audio anywhere near it, and the only
 * one whose whole output is geometry, so it is also the only section that draws
 * rather than prints. The canvas is the real demo; the row of buttons beside it
 * feeds the same recognizer synthetic strokes generated in code, which is what
 * makes the self-test reproducible and what a simulator can tap.
 *
 * The whole point of the file APIs is visible here: the recording never becomes
 * a JavaScript array. `recorder.uri` goes into Clear, an enhanced `uri` comes
 * out, that same `uri` goes into Voz, and text comes back. Only then does
 * anything cross as data -- words to sentences to ranked clips, which are small.
 *
 * The four are deliberately loaded on different terms. Clear's weights are ~9 MB
 * and Uhm's ~45 MB, so both load on mount. Voz's are ~490 MB and Clips' ~288 MB,
 * so they do not: the app checks whether each is already on disk and otherwise
 * waits for an explicit tap. That asymmetry is the honest one to demonstrate --
 * an SDK that silently pulled three quarters of a gigabyte on first launch would
 * be a bug in the app, not a feature of the models.
 *
 * Uhm is also the one that needs no transcript: it reads the waveform, so it runs
 * on the same file Voz does but does not wait for it. What it needs Voz *for* is
 * `Uhm.reconcileWords`, which trims the transcript's word spans around the
 * fillers so a cut lands on silence rather than through a word.
 */
export default function App() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  const clear = useRef<Clear | null>(null);
  const voz = useRef<Voz | null>(null);
  const clips = useRef<Clips | null>(null);
  const uhm = useRef<Uhm | null>(null);
  const emo = useRef<Emo | null>(null);
  const ear = useRef<Ear | null>(null);
  const tongue = useRef<Tongue | null>(null);
  const gist = useRef<Gist | null>(null);
  const redact = useRef<Redact | null>(null);
  const shapes = useRef<Shapes | null>(null);
  const align = useRef<Align | null>(null);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [originalUri, setOriginalUri] = useState<string | null>(null);
  const [enhancedUri, setEnhancedUri] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ClearMetrics | null>(null);

  const [vozState, setVozState] = useState<ModelState>(
    Voz.isSupported ? 'absent' : 'unsupported'
  );
  const [transcript, setTranscript] = useState<Transcript | null>(null);

  const [clipsState, setClipsState] = useState<ModelState>(
    Clips.isSupported ? 'absent' : 'unsupported'
  );
  const [highlights, setHighlights] = useState<Clip[] | null>(null);

  // `loading`, not `absent`, because this app prepares Uhm on mount unconditionally
  // -- so the weights are either already here or arriving, and "not on this device
  // yet" would be wrong in both cases. `absent` is reached only by a failed
  // prepare, where that copy and its retry button are exactly right.
  const [uhmState, setUhmState] = useState<ModelState>(
    Uhm.isSupported ? 'loading' : 'unsupported'
  );
  const [disfluency, setDisfluency] = useState<UhmResult | null>(null);
  // How many word spans survived reconciliation, against how many went in. The
  // difference is the words Voz placed over an "um" -- dropped or trimmed.
  const [reconciled, setReconciled] = useState<{ before: number; after: number } | null>(null);

  // Emo loads on mount like Clear and Uhm -- a few megabytes -- so `loading` is
  // the honest starting state rather than `absent`.
  const [emoState, setEmoState] = useState<ModelState>(
    Emo.isSupported ? 'loading' : 'unsupported'
  );
  const [phrase, setPhrase] = useState('');
  // The tone is per call, not per model, so changing it re-asks the same loaded
  // model. Nothing about the ranking moves -- the vocabulary is toneless and the
  // modifier is appended afterwards -- which is the point worth seeing.
  const [tone, setTone] = useState<EmojiSkinTone>('default');
  const [emoji, setEmoji] = useState<EmoSuggestion[] | null>(null);
  // Measured around the call, not reported by the model: Emo returns suggestions
  // and nothing else, and the claim worth checking on a real device is that this
  // number is small enough to run per keystroke.
  const [emoMs, setEmoMs] = useState<number | null>(null);

  // Ear is ~9 MB, so like Clear, Uhm and Emo it loads on mount rather than
  // behind a tap -- `loading` is the honest starting state.
  const [earState, setEarState] = useState<ModelState>(
    Ear.isSupported ? 'loading' : 'unsupported'
  );
  const [heard, setHeard] = useState<Detection | null>(null);
  // Measured in JavaScript as well as reported natively, because the two answer
  // different questions: `heard.processingSec` is what the model cost, and this
  // is what the caller waited for. The gap is the bridge hop.
  const [earMs, setEarMs] = useState<number | null>(null);

  // Tongue is 2 MB and bundled in the binary, so there is nothing to download
  // and `loading` lasts about as long as one file read. It is still a state
  // rather than an assumption: the read happens off the JavaScript thread, and a
  // `detect` before it lands refuses rather than blocking.
  const [tongueState, setTongueState] = useState<ModelState>(
    Tongue.isSupported ? 'loading' : 'unsupported'
  );
  const [typed, setTyped] = useState('');
  const [read, setRead] = useState<TextDetection | null>(null);
  // Microseconds, not milliseconds, and measured around the *synchronous* call
  // so it is the model rather than a promise. This is the number the whole
  // design of this package rests on -- if it were milliseconds, `detectSync`
  // would not be worth having.
  const [readUs, setReadUs] = useState<number | null>(null);
  // What Ear said about the audio and what Tongue said about the transcript of
  // the same audio. The join this app exists to show.
  const [agreement, setAgreement] = useState<{
    ear: string | null;
    earReliable: boolean;
    tongue: string | null;
    tongueReliability: string;
    words: number;
  } | null>(null);

  // Gist is ~74 MB for the default multilingual build, which puts it above Uhm's
  // 45 and below Clips' 288 -- so it follows Voz and Clips rather than Emo and
  // Ear: the app asks whether the weights are already here and otherwise waits
  // for a tap. `absent` is therefore the honest starting state, not `loading`.
  const [gistState, setGistState] = useState<ModelState>(
    Gist.isSupported ? 'absent' : 'unsupported'
  );
  // Which build the next prepare loads. Two on iOS, one on Android, and the list
  // is read off the native binary rather than off `Platform.OS` -- the Kotlin
  // SDK's constructor takes no variant, so it reports one.
  const [gistVariant, setGistVariant] = useState(Gist.defaultVariant);
  const [topic, setTopic] = useState('');
  const [tagged, setTagged] = useState<Tagging | null>(null);
  // Measured around the call as well as reported natively, for the same reason
  // Ear's is: `tagged.processingSec` is what the model cost and this is what the
  // caller waited for.
  const [gistMs, setGistMs] = useState<number | null>(null);
  // What the whole sample transcript is about, rolled up from every line's
  // distribution. The join with Clips: same twelve lines, one model ranking the
  // moments and another naming the subject.
  const [about, setAbout] = useState<ChannelTopic[] | null>(null);

  // Redact is ~12 MB for the Core ML export, which puts it between Emo's 5 and
  // Uhm's 45 -- so it loads on mount like Clear, Emo and Ear rather than behind a
  // tap, and `loading` is the honest starting state.
  const [redactState, setRedactState] = useState<ModelState>(
    Redact.isSupported ? 'loading' : 'unsupported'
  );
  const [secret, setSecret] = useState('');
  const [redacted, setRedacted] = useState<Redaction | null>(null);
  // Measured around the call as well as reported natively, for the same reason
  // Ear's and Gist's are: `redacted.processingSec` is what the model cost and
  // this is what the caller waited for.
  const [redactMs, setRedactMs] = useState<number | null>(null);
  // The round trip, proved rather than asserted: the redacted text put back
  // through `restore` should be the input again, character for character. Null
  // until a redaction has been asked for.
  const [roundTrip, setRoundTrip] = useState<boolean | null>(null);

  // Shapes is 0.2 MB for the Core ML export, which is the smallest download in
  // this whole family by a factor of twenty-five -- a twenty-fifth of Emo, a
  // two-hundredth of Uhm. There is less to justify here than anywhere else, so it
  // loads on mount and `loading` is the honest starting state.
  const [shapesState, setShapesState] = useState<ModelState>(
    Shapes.isSupported ? 'loading' : 'unsupported'
  );
  // The stroke being drawn, in canvas coordinates. Kept in state rather than a
  // ref because the ink is the feedback: a canvas that shows nothing until the
  // finger lifts feels broken whatever the model does afterwards.
  const [stroke, setStroke] = useState<CanvasPoint[]>([]);
  const [recognized, setRecognized] = useState<ShapeRecognition | null>(null);
  // Which stroke produced the result on screen: 'drawn', or the name of the
  // synthetic sample. Worth showing, because the two are the same call and it
  // should not be possible to tell them apart from the answer.
  const [strokeSource, setStrokeSource] = useState<string | null>(null);
  // Measured around the call as well as reported natively, for the same reason
  // Ear's, Gist's and Redact's are: `recognized.processingSec` is what the model
  // cost and this is what the caller waited for. For this model the gap between
  // them is the interesting number -- upstream advertises the pass at under ten
  // milliseconds, which is small enough that the bridge hop is visible next to it.
  const [shapeMs, setShapeMs] = useState<number | null>(null);

  // Align is 0.7 MB of Core ML, so its own weights load on mount like Shapes'.
  // Apple's speech model for a locale is the *other* download and is much
  // larger, so that one waits for a tap -- which is the asymmetry this model has
  // and none of the others do, and the reason `alignState` and `localeState` are
  // two states rather than one.
  const [alignState, setAlignState] = useState<ModelState>(
    Align.isSupported ? 'loading' : 'unsupported'
  );
  const [alignLocaleState, setAlignLocaleState] = useState<ModelState>('absent');
  const [aligned, setAligned] = useState<AlignedTranscript | null>(null);
  // Which file produced it, for the label on screen: the recording, the enhanced
  // copy, or the speech sample dropped into the cache.
  const [alignSource, setAlignSource] = useState<string | null>(null);
  // Measured around the call as well as reported natively, for the same reason
  // Ear's, Gist's, Redact's and Shapes' are -- and here the gap is larger than
  // anywhere else, because `processingSec` includes Apple's recognition and
  // `refineSec` is the only part of it Align is responsible for.
  const [alignMs, setAlignMs] = useState<number | null>(null);

  // Logged before anything else touches either model: reading these proves both
  // native modules resolved and their `@JS` properties are bound, which is the
  // failure most likely to be silent.
  useEffect(() => {
    console.log(
      `[clear] isSupported=${Clear.isSupported} nativeCore=${Clear.nativeCoreVersion}`
    );
    console.log(
      `[voz] isSupported=${Voz.isSupported} nativeCore=${Voz.nativeCoreVersion} ` +
        `revision=${Voz.modelRevision} languages=${Voz.supportedLanguages.length}`
    );
    console.log(
      `[clips] isSupported=${Clips.isSupported} nativeCore=${Clips.nativeCoreVersion} ` +
        `revision=${Clips.modelRevision} defaultLimit=${Clips.defaultLimit}` +
        `${Clips.unsupportedReason ? ` reason=${Clips.unsupportedReason}` : ''}`
    );
    console.log(
      `[uhm] isSupported=${Uhm.isSupported} nativeCore=${Uhm.nativeCoreVersion} ` +
        `revision=${Uhm.modelRevision?.slice(0, 7)} ` +
        `bias=${JSON.stringify(Uhm.biasThresholds)} types=${Uhm.fillerTypes.join('/')}`
    );
    console.log(
      `[ear] isSupported=${Ear.isSupported} nativeCore=${Ear.nativeCoreVersion} ` +
        `revision=${Ear.modelRevision} repo=${Ear.modelRepo} ` +
        `windows=${Ear.defaultWindows} margin=${Ear.reliableMargin} ` +
        `confusable=${Ear.confusableLanguages.join('/')}` +
        `${Ear.unsupportedReason ? ` reason=${Ear.unsupportedReason}` : ''}`
    );
    console.log(
      `[tongue] isSupported=${Tongue.isSupported} nativeCore=${Tongue.nativeCoreVersion} ` +
        `revision=${Tongue.modelRevision} repo=${Tongue.modelRepo} ` +
        `topK=${Tongue.defaultTopK} tieMargin=${Tongue.tieMargin} ` +
        `maxChars=${Tongue.maxCharacters}` +
        `${Tongue.unsupportedReason ? ` reason=${Tongue.unsupportedReason}` : ''}`
    );
    console.log(
      `[emo] isSupported=${Emo.isSupported} nativeCore=${Emo.nativeCoreVersion} ` +
        `revision=${Emo.modelRevision} repo=${Emo.modelRepo} ` +
        `limit=${Emo.defaultLimit} tones=${Emo.skinTones.join('/')}` +
        `${Emo.unsupportedReason ? ` reason=${Emo.unsupportedReason}` : ''}`
    );
    console.log(
      `[gist] isSupported=${Gist.isSupported} nativeCore=${Gist.nativeCoreVersion} ` +
        `revision=${Gist.modelRevision} repo=${Gist.modelRepo} ` +
        `topK=${Gist.defaultTopK} variants=${Gist.variants.join('/')} ` +
        `default=${Gist.defaultVariant} rollup=${JSON.stringify(Gist.defaultRollupOptions)}` +
        `${Gist.unsupportedReason ? ` reason=${Gist.unsupportedReason}` : ''}`
    );
    console.log(
      `[redact] isSupported=${Redact.isSupported} nativeCore=${Redact.nativeCoreVersion} ` +
        `revision=${Redact.modelRevision} repo=${Redact.modelRepo} ` +
        `minConfidence=${Redact.defaultMinimumConfidence} ` +
        `labels=${Redact.labels.length} default=${Redact.defaultLabels.length} ` +
        `displayNames=${Object.keys(Redact.labelDisplayNames).length}` +
        `${Redact.unsupportedReason ? ` reason=${Redact.unsupportedReason}` : ''}`
    );
    console.log(
      `[shapes] isSupported=${Shapes.isSupported} nativeCore=${Shapes.nativeCoreVersion} ` +
        `revision=${Shapes.modelRevision} repo=${Shapes.modelRepo} ` +
        `minConfidence=${Shapes.defaultMinimumConfidence} kinds=${Shapes.kinds.join('/')}` +
        `${Shapes.unsupportedReason ? ` reason=${Shapes.unsupportedReason}` : ''}`
    );
    // `pinned=false` is the one line in this block that is a warning rather than
    // a reading. Every other model here resolves a `v`-prefixed tag; Align
    // resolves the branch `main`, so what a user downloads can change without any
    // version number moving. Printed on every launch so it cannot be forgotten.
    console.log(
      `[align] isSupported=${Align.isSupported} nativeCore=${Align.nativeCoreVersion} ` +
        `revision=${Align.modelRevision} pinned=${Align.revisionIsPinned} ` +
        `repo=${Align.modelRepo} appleSpeech=${Align.isAppleSpeechAvailable} ` +
        `maxBuffered=${Align.defaultMaxBufferedSeconds}` +
        `${Align.unsupportedReason ? ` reason=${Align.unsupportedReason}` : ''}`
    );
  }, []);

  // Created once with no source, then pointed at each new file with `replace`.
  // Passing a changing `uri` to `useAudioPlayer` does not reload the player -- it
  // keeps whatever it was constructed with, so every recording after the first
  // plays the previous one.
  const originalPlayer = useAudioPlayer();
  const enhancedPlayer = useAudioPlayer();

  useEffect(() => {
    if (originalUri) originalPlayer.replace(originalUri);
  }, [originalUri, originalPlayer]);

  useEffect(() => {
    if (enhancedUri) enhancedPlayer.replace(enhancedUri);
  }, [enhancedUri, enhancedPlayer]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone permission denied.');
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });

      if (!Clear.isSupported) {
        setError('This device cannot run Clear (unsupported ABI).');
        return;
      }

      // The first-ever load downloads ~9 MB and, on Apple, compiles the Core ML
      // program for the Neural Engine. Do it now so the first enhance is fast.
      setBusy('Loading Clear');
      try {
        const model = await Clear.load({ onProgress: (event) => !cancelled && setProgress(event) });
        if (cancelled) {
          model.release();
          return;
        }
        clear.current = model;
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(describe(e));
      } finally {
        if (!cancelled) {
          setBusy(null);
          setProgress(null);
        }
      }

      // Each model below is skipped on its own rather than with a bare `return`,
      // which the earlier shape used and which turned out to be a bug: `Tongue`
      // is unsupported on iOS today (its upstream product is not exported), so a
      // `return` there took the Voz, Clips and Gist probes down with it and none
      // of the three ever logged whether its weights were on the device.
      // `cancelled` still ends the whole sequence, because that means the screen
      // is gone.
      if (cancelled) return;

      // Uhm is ~45 MB, so it loads on mount like Clear rather than behind a tap.
      // It is the fourth model and the only one that needs nothing from the other
      // three: give it audio and it answers.
      if (Uhm.isSupported) void prepareUhm(false);

      // Emo is ~5 MB, the smallest model here by an order of magnitude, so it
      // loads on mount with less to justify than any of the others.
      if (Emo.isSupported) void prepareEmo();

      // Ear is ~9 MB. It loads on mount for the same reason Clear does, and for
      // one more: it is the step that runs *before* the transcriber, so a
      // recording that finishes before it is ready has nothing to route on.
      if (Ear.isSupported) void prepareEar();

      // Tongue is 2 MB, and unlike every other model here those 2 MB are already
      // on the device -- they are inside the app binary. "Preparing" it is a file
      // read, so there is nothing to justify and nothing to ask permission for.
      if (Tongue.isSupported) void prepareTongue();

      // Redact is ~12 MB on Apple. It loads on mount for the same reason Emo and
      // Ear do -- small enough not to ask about -- and for one more: the way this
      // model is meant to be used is on text as it is typed, so a field that has
      // to wait for a tap before it will mask anything is the wrong demo of it.
      if (Redact.isSupported) void prepareRedact();

      // Shapes is 0.2 MB. That is not a typo and it is not a stub: the classifier
      // is tiny because the geometry is done by a fitter rather than by the
      // network. Nothing in this app is cheaper to have ready, and a canvas that
      // needed a tap before it would recognize anything would be the wrong demo
      // of a model whose whole point is that it answers while you draw.
      if (Shapes.isSupported) void prepareShapes();

      // Align is 0.7 MB, so its own half loads on mount too. What does NOT load
      // on mount is Apple's speech model for a locale -- that is the larger of
      // Align's two downloads, it is managed by `AssetInventory` rather than by
      // desert-ant-core, and pulling it unasked on first launch would be the same
      // mistake as pulling Voz's 490 MB. The section below asks.
      if (Align.isSupported) void prepareAlign();

      // Voz only loads itself if its weights are already here. `create()` touches
      // no network, so asking is free.
      if (cancelled || !Voz.isSupported) return;
      const probe = Voz.create();
      const downloaded = probe.isDownloaded();
      probe.release();
      console.log(`[voz] isDownloaded=${downloaded}`);
      if (downloaded && !cancelled) {
        void prepareVoz(false);
      }

      if (cancelled || !Clips.isSupported) return;
      const clipsProbe = Clips.create();
      const clipsDownloaded = clipsProbe.isDownloaded();
      clipsProbe.release();
      console.log(`[clips] isDownloaded=${clipsDownloaded}`);
      if (clipsDownloaded && !cancelled) {
        void prepareClips(false);
      }

      // Gist is ~74 MB for the default build, so it follows Voz and Clips rather
      // than Emo, Ear and Tongue: ask whether it is already here, and otherwise
      // leave it for an explicit tap. `create()` touches no network, so asking
      // costs nothing -- and the answer is per variant, because each one caches
      // its own slice of the repo.
      if (cancelled || !Gist.isSupported) return;
      const gistProbe = Gist.create({ variant: gistVariant });
      const gistDownloaded = gistProbe.isDownloaded();
      gistProbe.release();
      console.log(`[gist] isDownloaded=${gistDownloaded} variant=${gistVariant}`);
      if (gistDownloaded && !cancelled) {
        void prepareGist(false);
      }
    })();

    return () => {
      cancelled = true;
      clear.current?.release();
      clear.current = null;
      voz.current?.release();
      voz.current = null;
      clips.current?.release();
      clips.current = null;
      uhm.current?.release();
      uhm.current = null;
      emo.current?.release();
      emo.current = null;
      ear.current?.release();
      ear.current = null;
      tongue.current?.release();
      tongue.current = null;
      gist.current?.release();
      gist.current = null;
      redact.current?.release();
      redact.current = null;
      shapes.current?.release();
      shapes.current = null;
      align.current?.release();
      align.current = null;
    };
  }, []);

  /**
   * Get Voz ready. `download` is the ~490 MB; `warm` is that plus the one-time
   * ~20 s Neural Engine specialization that follows it. `load()` does both, so
   * this is the only call the app needs either way -- `announce` just decides
   * whether the user is told it is happening.
   */
  const prepareVoz = useCallback(async (announce = true) => {
    if (voz.current) return;
    setError(null);
    setVozState('loading');
    if (announce) setBusy('Preparing Voz');
    try {
      const t0 = Date.now();
      const model = await Voz.load({
        onProgress: (event) => {
          setProgress(event);
          if (event.fraction >= 1) console.log(`[voz] ${event.phase} complete`);
        },
      });
      voz.current = model;
      setVozState('ready');
      console.log(`[voz] ready in ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`[voz] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setVozState('absent');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /**
   * Get Clips ready: ~288 MB, then roughly 41 s of Neural Engine specialization
   * on the first load. One call does both -- upstream's `download` also builds
   * the session, so this SDK's `warm` and `download` are the same operation.
   */
  const prepareClips = useCallback(async (announce = true) => {
    if (clips.current) return;
    setError(null);
    setClipsState('loading');
    if (announce) setBusy('Preparing Clips');
    try {
      const t0 = Date.now();
      const model = await Clips.load({ onProgress: setProgress });
      clips.current = model;
      setClipsState('ready');
      console.log(`[clips] ready in ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`[clips] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setClipsState('absent');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /**
   * Get Uhm ready: ~45 MB and a session build measured in seconds, so this runs
   * on mount rather than behind a button. `warm` and `download` are the same call
   * here -- upstream's loader downloads and builds in one pass.
   */
  const prepareUhm = useCallback(async (announce = true) => {
    if (uhm.current) return;
    setUhmState('loading');
    if (announce) setBusy('Preparing Uhm');
    try {
      const t0 = Date.now();
      const model = await Uhm.load({ onProgress: (event) => announce && setProgress(event) });
      uhm.current = model;
      setUhmState('ready');
      console.log(`[uhm] ready in ${Date.now() - t0}ms downloaded=${model.isDownloaded()}`);
    } catch (e) {
      console.log(`[uhm] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setUhmState('absent');
    } finally {
      if (announce) {
        setBusy(null);
        setProgress(null);
      }
    }
  }, []);

  /**
   * Get Emo ready: ~5 MB and a session build in milliseconds. It never announces
   * itself through `busy` -- it is small enough that a global "preparing" banner
   * would be on screen for less time than it takes to read.
   */
  const prepareEmo = useCallback(async () => {
    if (emo.current) return;
    setEmoState('loading');
    try {
      const t0 = Date.now();
      const model = await Emo.load();
      emo.current = model;
      setEmoState('ready');
      console.log(`[emo] ready in ${Date.now() - t0}ms downloaded=${model.isDownloaded()}`);
    } catch (e) {
      console.log(`[emo] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setEmoState('absent');
    }
  }, []);

  /**
   * Get Ear ready: ~9 MB and a session build in a second or two. Like Emo it
   * never announces itself through `busy` -- it is small enough that a global
   * banner would be gone before it was read.
   */
  const prepareEar = useCallback(async () => {
    if (ear.current) return;
    setEarState('loading');
    try {
      const t0 = Date.now();
      const model = await Ear.load();
      ear.current = model;
      setEarState('ready');
      console.log(`[ear] ready in ${Date.now() - t0}ms downloaded=${model.isDownloaded()}`);
      // Asked once, after loading, because the list is a sidecar that comes down
      // with the weights rather than a constant -- and because it is the one
      // call in this SDK that iOS can answer and Android cannot.
      try {
        const languages = await model.supportedLanguages();
        console.log(`[ear] ${languages.length} languages, e.g. ${languages.slice(0, 12).join(' ')}`);
        const missing = Voz.supportedLanguages.filter((l) => !languages.includes(l));
        console.log(
          `[ear] Voz covers ${Voz.supportedLanguages.length}, Ear names ${languages.length}; ` +
            `Voz languages Ear cannot name: ${missing.length === 0 ? 'none' : missing.join(' ')}`
        );
      } catch (e) {
        // Expected on Android: `ai.desertant:ear` exposes no reader for the list.
        console.log(`[ear] supportedLanguages unavailable: ${describe(e)}`);
      }
    } catch (e) {
      console.log(`[ear] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setEarState('absent');
    }
  }, []);

  /**
   * Get Tongue ready: 2 MB, already on the device, read off the app binary.
   *
   * The only model here with nothing to download and no progress to report, so
   * this is the shortest prepare in the app -- and the only one where `absent`
   * cannot mean "not on this device yet". A failure here means the package's
   * resources did not survive the build, which is a different problem and worth
   * saying so.
   */
  const prepareTongue = useCallback(async () => {
    if (tongue.current) return;
    setTongueState('loading');
    try {
      const t0 = Date.now();
      const model = await Tongue.load();
      tongue.current = model;
      setTongueState('ready');
      console.log(`[tongue] ready in ${Date.now() - t0}ms loaded=${model.isLoaded()}`);
      // iOS only: Swift exposes `Script` as a public enum, the Kotlin jar keeps
      // its router internal. Asked once so the refusal is exercised on the
      // platform that refuses.
      try {
        const scripts = Tongue.supportedScripts();
        console.log(`[tongue] ${scripts.length} scripts: ${scripts.join(' ')}`);
      } catch (e) {
        console.log(`[tongue] supportedScripts unavailable: ${describe(e)}`);
      }
    } catch (e) {
      console.log(`[tongue] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setTongueState('absent');
    }
  }, []);

  /**
   * Get Gist ready: ~74 MB for the multilingual build, ~15 MB for the English
   * one, then a session build in a second or two.
   *
   * The only model here whose *download* is the expensive part and whose
   * inference is not -- it is a static embedding table plus one MLP head, so the
   * bytes are the cost and the forward pass is milliseconds. That is why this
   * follows Voz and Clips behind a tap rather than Emo and Ear on mount, and why
   * the button names the size.
   */
  const prepareGist = useCallback(async (announce = true, variant = gistVariant) => {
    if (gist.current) return;
    setError(null);
    setGistState('loading');
    if (announce) setBusy('Preparing Gist');
    try {
      const t0 = Date.now();
      const model = await Gist.load({
        variant,
        onProgress: (event) => {
          if (announce) setProgress(event);
          if (event.fraction >= 1) console.log(`[gist] ${event.phase} complete`);
        },
      });
      gist.current = model;
      setGistState('ready');
      console.log(
        `[gist] ready in ${Date.now() - t0}ms variant=${model.variant} ` +
          `downloaded=${model.isDownloaded()}`
      );
    } catch (e) {
      console.log(`[gist] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setGistState('absent');
    } finally {
      if (announce) {
        setBusy(null);
        setProgress(null);
      }
    }
  }, [gistVariant]);

  /**
   * Tag whatever is in the Gist field.
   *
   * Debounced at 150 ms like Emo's rather than called per keystroke like
   * Tongue's. Tongue is synchronous and tens of microseconds; this is a promise
   * over a forward pass, so the timer is worth its own latency -- and the number
   * printed beside the result is the evidence either way.
   *
   * Blank input is an answer rather than an error and never reaches the weights,
   * which is why this does not guard on it: `classify('')` comes back with no
   * topics without loading anything.
   */
  const runTag = useCallback(async (text: string) => {
    const model = gist.current;
    if (!model) return;
    if (text.trim().length === 0) {
      setTagged(null);
      setGistMs(null);
      return;
    }
    try {
      const t0 = Date.now();
      const result = await model.classify(text, { topK: 5 });
      setGistMs(Date.now() - t0);
      setTagged(result);
    } catch (e) {
      console.log(`[gist] classify FAILED: ${describe(e)}`);
      setError(describe(e));
      // The same Fast Refresh hazard Emo and Tongue hit, for the same reason:
      // this is the third model called from a timer rather than from a tap, so
      // it is the third that can outlive its native half during development.
      gist.current?.release();
      gist.current = null;
      void prepareGist(false);
    }
  }, [prepareGist]);

  // Debounce the field into `runTag`. The cleanup cancels the pending timer on
  // every keystroke, so only the last one in a burst reaches the model.
  useEffect(() => {
    if (gistState !== 'ready') return;
    const timer = setTimeout(() => void runTag(topic), 150);
    return () => clearTimeout(timer);
  }, [topic, gistState, runTag]);

  /**
   * What the whole sample transcript is about.
   *
   * The join with Clips, on the same twelve lines: Clips ranks which moments are
   * worth cutting, Gist says what the thing is *about*. One line at a time
   * through `scores` -- the full distribution rather than the top three, because
   * the roll-up wants every topic's mass -- and then one call to `channelTopics`,
   * which runs no model at all.
   *
   * `channelTopics` is the only call in this app that needs neither weights nor a
   * handle: it is pure arithmetic, bound from upstream rather than ported, and it
   * would answer on a device that had never downloaded anything.
   */
  const runAbout = useCallback(async () => {
    const model = gist.current;
    if (!model) return;
    setError(null);
    setBusy('Reading the transcript');
    try {
      const t0 = Date.now();
      const posts = [];
      for (const line of SAMPLE_TRANSCRIPT) {
        posts.push({ topics: (await model.scores(line)).scores });
      }
      const rolled = channelTopics(posts);
      setAbout(rolled);
      console.log(
        `[gist] ${posts.length} lines scored in ${Date.now() - t0}ms -> ` +
          rolled.map((t) => `${t.slug} ${(t.share * 100).toFixed(0)}% x${t.postCount}`).join(', ')
      );
    } catch (e) {
      console.log(`[gist] channelTopics FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * Get Redact ready: ~12 MB for the Core ML export and a session build in a
   * second or two.
   *
   * Like Emo and Ear it never announces itself through `busy` -- it is small
   * enough that a global "preparing" banner would be gone before it was read.
   */
  const prepareRedact = useCallback(async () => {
    if (redact.current) return;
    setRedactState('loading');
    try {
      const t0 = Date.now();
      const model = await Redact.load();
      redact.current = model;
      setRedactState('ready');
      console.log(`[redact] ready in ${Date.now() - t0}ms downloaded=${model.isDownloaded()}`);
      // Asked once, after loading, because it is the one thing this SDK can
      // answer on iOS and cannot on Android: `Label.displayName` is a Swift
      // computed property with no Kotlin equivalent, so the refusal is exercised
      // here on whichever platform refuses.
      try {
        console.log(
          `[redact] displayName(IP_ADDRESS)="${Redact.displayName('IP_ADDRESS')}" ` +
            `displayName(ORG)="${Redact.displayName('ORG')}"`
        );
      } catch (e) {
        console.log(`[redact] display names unavailable: ${describe(e)}`);
      }
    } catch (e) {
      console.log(`[redact] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setRedactState('absent');
    }
  }, []);

  /**
   * Mask whatever is in the Redact field, and check the round trip.
   *
   * Debounced at 150 ms like Emo's and Gist's rather than called per keystroke
   * like Tongue's -- it is a promise over a windowed transformer pass, so the
   * timer is worth its own latency, and the number printed beside the result is
   * the evidence either way.
   *
   * `restore` runs on every result, not just in the self-test, because the round
   * trip is the product rather than a property of it: what this model is *for* is
   * handing the masked text to something else and putting the originals back into
   * what comes out. Restoring the redacted text into itself should give back
   * exactly what was typed, and the UI says whether it did.
   */
  const runRedact = useCallback(async (text: string) => {
    const model = redact.current;
    if (!model) return;
    if (text.trim().length === 0) {
      setRedacted(null);
      setRedactMs(null);
      setRoundTrip(null);
      return;
    }
    try {
      const t0 = Date.now();
      const result = await model.redaction(text);
      setRedactMs(Date.now() - t0);
      setRedacted(result);
      setRoundTrip(restore(result, result.redactedText) === text);
    } catch (e) {
      console.log(`[redact] redaction FAILED: ${describe(e)}`);
      setError(describe(e));
      // The same Fast Refresh hazard Emo, Tongue and Gist hit, for the same
      // reason: this is the fourth model called from a timer rather than from a
      // tap, so it is the fourth that can outlive its native half during
      // development.
      redact.current?.release();
      redact.current = null;
      void prepareRedact();
    }
  }, [prepareRedact]);

  // Debounce the field into `runRedact`. The cleanup cancels the pending timer on
  // every keystroke, so only the last one in a burst reaches the model.
  useEffect(() => {
    if (redactState !== 'ready') return;
    const timer = setTimeout(() => void runRedact(secret), 150);
    return () => clearTimeout(timer);
  }, [secret, redactState, runRedact]);

  /**
   * The join with Voz: mask the transcript of the recording just made.
   *
   * This is the honest pairing for this model rather than a contrived one. Voz
   * turns a recording into text, and text is exactly where personal data stops
   * being hard to find and starts being easy to leak -- a transcript is the thing
   * an app sends to a summarizer, stores in a log, or attaches to a support
   * ticket. So the chain Clear -> Ear -> Voz already builds ends here: whatever
   * the microphone heard, masked before it can go anywhere.
   *
   * Falls back to the sample transcript when there is no recording, which is the
   * usual case on a simulator with no Voz weights. Both are real text with real
   * offsets; only one of them came from a microphone.
   */
  const runRedactTranscript = useCallback(async () => {
    const model = redact.current;
    if (!model) return;
    const fromVoz = transcript?.text?.trim();
    const source = fromVoz && fromVoz.length > 0 ? fromVoz : SAMPLE_TRANSCRIPT.join(' ');
    setError(null);
    setBusy('Masking the transcript');
    try {
      const t0 = Date.now();
      const result = await model.redaction(source);
      const elapsed = Date.now() - t0;
      setSecret(source);
      setRedacted(result);
      setRedactMs(elapsed);
      setRoundTrip(restore(result, result.redactedText) === source);
      console.log(
        `[redact] ${fromVoz ? 'Voz transcript' : 'sample transcript'} ` +
          `(${source.length} chars) masked in ${elapsed}ms -> ${result.items.length} items` +
          (result.items.length > 0
            ? `: ${result.items.map((i) => `${i.label} "${i.original}"`).join(', ')}`
            : '')
      );
    } catch (e) {
      console.log(`[redact] transcript FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }, [transcript]);

  /**
   * Get Shapes ready: 0.2 MB for the Core ML export and a session build in
   * milliseconds.
   *
   * Like Emo, Ear and Redact it never announces itself through `busy` -- and here
   * that is not even a judgement call. A twelfth of a megabyte over a cable
   * modem is gone before a banner could render.
   */
  const prepareShapes = useCallback(async () => {
    if (shapes.current) return;
    setShapesState('loading');
    try {
      const t0 = Date.now();
      const model = await Shapes.load();
      shapes.current = model;
      setShapesState('ready');
      console.log(`[shapes] ready in ${Date.now() - t0}ms downloaded=${model.isDownloaded()}`);
    } catch (e) {
      console.log(`[shapes] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setShapesState('absent');
    }
  }, []);

  /**
   * Recognize one stroke and put the fitted shape on screen.
   *
   * Called from the canvas when a finger lifts and from the sample buttons, with
   * no debounce and no timer: a stroke is a discrete event, unlike a text field
   * that changes on every keystroke, so there is nothing to coalesce. Emo, Gist
   * and Redact all debounce for that reason and this one has no reason to.
   *
   * `source` is only for the label on screen. Both paths are the same call with
   * the same arguments, which is the point of having both: a synthetic stroke is
   * not a special case the model knows about.
   */
  const runShapes = useCallback(async (points: CanvasPoint[], source: string) => {
    const model = shapes.current;
    if (!model) return;
    setStroke(points);
    setStrokeSource(source);
    try {
      const t0 = Date.now();
      const result = await model.recognize(points);
      setShapeMs(Date.now() - t0);
      setRecognized(result);
      console.log(
        `[shapes] ${source} (${points.length} pts) -> ${result.shape?.kind ?? 'no shape'} ` +
          `in ${Date.now() - t0}ms, native ${(result.processingSec * 1000).toFixed(1)}ms` +
          (result.shape ? ` ${describeShape(result.shape)}` : ' (rejected)')
      );
    } catch (e) {
      console.log(`[shapes] recognize FAILED: ${describe(e)}`);
      setError(describe(e));
      // The same Fast Refresh hazard Emo, Tongue, Gist and Redact hit, for the
      // same reason: a model called from a gesture rather than from a tap on a
      // button this file owns can outlive its native half during development.
      shapes.current?.release();
      shapes.current = null;
      void prepareShapes();
    }
  }, [prepareShapes]);

  /**
   * The canvas gesture. Points are collected in the view's own coordinates, which
   * is exactly what the model wants -- it is scale- and translation-invariant, so
   * there is no normalization to do and nothing to convert.
   *
   * Two points closer than 1.5 px apart are dropped. That is not thinning for the
   * model's benefit -- it resamples to uniform arc length itself and reads a fixed
   * 256-point window, so extra points cost it nothing -- it is so that a finger
   * held still does not add a hundred identical dots to the ink this component
   * renders.
   */
  const strokeRef = useRef<CanvasPoint[]>([]);

  const beginStroke = useCallback((x: number, y: number) => {
    strokeRef.current = [{ x, y }];
    setRecognized(null);
    setShapeMs(null);
    setStrokeSource(null);
    setStroke(strokeRef.current);
  }, []);

  const extendStroke = useCallback((x: number, y: number) => {
    const points = strokeRef.current;
    const last = points[points.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 1.5) return;
    strokeRef.current = [...points, { x, y }];
    setStroke(strokeRef.current);
  }, []);

  const endStroke = useCallback(() => {
    const points = strokeRef.current;
    if (points.length < 2) return;
    void runShapes(points, 'drawn');
  }, [runShapes]);

  /**
   * Get Align's own half ready: 0.7 MB of compiled Core ML in two cascade stages
   * plus three sidecars.
   *
   * This is the download desert-ant-core manages, and it is the small one. It
   * builds no session -- `SpeechTimestampRefiner` constructs its two stages per
   * locale *and* per audio file, so there is nothing to hoist -- which is why
   * this model has no "warming" cost to show and why `ready` here does not yet
   * mean a transcript is possible.
   */
  const prepareAlign = useCallback(async () => {
    if (align.current) return;
    setAlignState('loading');
    try {
      const t0 = Date.now();
      const model = await Align.load();
      align.current = model;
      setAlignState('ready');
      console.log(
        `[align] ready in ${Date.now() - t0}ms downloaded=${model.isDownloaded()} ` +
          `languages=${model.supportedLanguages().join('/')} dir=${model.resolvedDirectory()}`
      );
    } catch (e) {
      console.log(`[align] prepare FAILED: ${describe(e)}`);
      setError(describe(e));
      setAlignState('absent');
    }
  }, []);

  /**
   * Install Apple's on-device speech model for `ALIGN_LOCALE`.
   *
   * Align's *other* download, and the reason this section has two buttons where
   * every other section has one. Apple's recognizer weights are per-locale, live
   * under `AssetInventory`, and are hundreds of megabytes -- so this behaves like
   * Voz's and Clips' downloads rather than like Emo's: an explicit tap, a
   * progress bar, and a state of its own.
   */
  const prepareAlignLocale = useCallback(async () => {
    const model = align.current;
    if (!model) return;
    setError(null);
    setAlignLocaleState('loading');
    setBusy(`Installing the ${ALIGN_LOCALE} speech model`);
    try {
      const t0 = Date.now();
      await model.prepareLocale(ALIGN_LOCALE, setProgress);
      setAlignLocaleState('ready');
      console.log(`[align] locale ${ALIGN_LOCALE} ready in ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`[align] prepareLocale FAILED: ${describe(e)}`);
      setError(describe(e));
      setAlignLocaleState('absent');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /**
   * Transcribe one file with Apple's recognizer and refine every word boundary.
   *
   * The join is the interesting part and it happens at the end of this function.
   * Align produces word spans; Uhm finds the fillers in the *same* audio; and
   * `Uhm.reconcileWords` trims the one around the other so a cut lands on silence
   * rather than through a word. That is three models over one recording, and it
   * is the only place in this app where a timestamp is used for something where
   * tens of milliseconds actually change the output.
   *
   * Note what is NOT here: Voz. Align cannot refine Voz's words, and that is
   * upstream's shape rather than a gap in this app -- the two `refine` overloads
   * that take an arbitrary `[WordTiming]` are `internal` to the `Align` module,
   * so the only public entry point takes a `SpeechTranscriber.Result`. Align
   * therefore *replaces* Voz as the word-timestamp source when you want refined
   * ones; it does not sharpen Voz's.
   */
  const runAlign = useCallback(async (uri: string, source: string) => {
    const model = align.current;
    if (!model) return;
    setError(null);
    setAlignSource(source);
    setBusy('Refining word timestamps');
    try {
      const t0 = Date.now();
      const result = await model.transcribe({ uri, locale: ALIGN_LOCALE, onProgress: setProgress });
      const waited = Date.now() - t0;
      setAlignMs(waited);
      setAligned(result);

      const shift = timestampShift(result.words);
      console.log(
        `[align] ${source} ok in ${waited}ms — ${result.words.length} words, ` +
          `${result.refinedWordCount} refined, ${result.durationSec.toFixed(2)}s ` +
          `rtf=${result.realtimeFactor.toFixed(2)}x setup=${(result.setupSec * 1000).toFixed(0)}ms ` +
          `refine=${(result.refineSec * 1000).toFixed(0)}ms revision=${result.modelRevision}`
      );
      console.log(`[align] text="${result.text}"`);
      console.log(
        `[align] shift: mean ${(shift.meanAbsSec * 1000).toFixed(1)}ms ` +
          `max ${(shift.maxAbsSec * 1000).toFixed(1)}ms ` +
          `start ${(shift.meanStartSec * 1000).toFixed(1)}ms ` +
          `end ${(shift.meanEndSec * 1000).toFixed(1)}ms`
      );
      result.words.slice(0, 12).forEach((w) =>
        console.log(
          `[align]   ${w.text.padEnd(14)} ${w.originalStart.toFixed(3)}–${w.originalEnd.toFixed(3)}` +
            ` -> ${w.start.toFixed(3)}–${w.end.toFixed(3)}` +
            ` (${w.refined ? `${((w.start - w.originalStart) * 1000).toFixed(0)}ms / ` +
              `${((w.end - w.originalEnd) * 1000).toFixed(0)}ms` : 'kept'})`
        )
      );

      // The three-model chain, on one file: Align times the words, Uhm finds the
      // fillers, `reconcileWords` puts the two together.
      const detector = uhm.current;
      if (detector && result.words.length > 0) {
        const { fillers } = await detector.analyze({ uri });
        const clean = Uhm.reconcileWords(result.words, fillers);
        console.log(
          `[align] + uhm: ${fillers.length} fillers over the same audio; ` +
            `${result.words.length} words -> ${clean.length} after reconcileWords`
        );
      }
    } catch (e) {
      console.log(`[align] transcribe FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /**
   * Name the language of whatever is in the Tongue field.
   *
   * Called straight from `onChangeText` with **no debounce**, which is the whole
   * demonstration. Emo's field two sections down debounces at 150 ms because a
   * suggestion is a promise and a couple of milliseconds; a Tongue detection is
   * synchronous and tens of microseconds, so the timer would cost more than the
   * model and would make the answer lag the keystroke for no reason.
   *
   * `detectSync` rather than `detect` for the same reason. They are the same
   * native call; the async one exists so this package reads like the other six,
   * and so it can load the model for a caller who did not.
   */
  const runRead = useCallback((text: string) => {
    setTyped(text);
    const model = tongue.current;
    if (!model) return;
    if (text.length === 0) {
      setRead(null);
      setReadUs(null);
      return;
    }
    try {
      const t0 = performance.now();
      const detection = model.detectSync(text, { topK: 5 });
      setReadUs(Math.round((performance.now() - t0) * 1000));
      setRead(detection);
    } catch (e) {
      console.log(`[tongue] detect FAILED: ${describe(e)}`);
      setError(describe(e));
      // Same Fast Refresh hazard Emo hits, and for the same reason: this is the
      // other model called from something that is not a tap, so it is the other
      // one that can outlive its native half during development.
      tongue.current?.release();
      tongue.current = null;
      void prepareTongue();
    }
  }, [prepareTongue]);

  /**
   * Name the language of a recording, and say whether Voz can be trusted with it.
   *
   * This is the whole reason Ear is in the chain, and the check is not
   * decorative. Voz does not detect what it is hearing: audio in a language
   * outside its 25 comes back as fluent, confident nonsense rather than as an
   * error, so the only way to catch it is to ask a model whose job is asking.
   *
   * The branch is on `isReliable`, never on `confidence`. They disagree exactly
   * where it matters -- the detector reads Norwegian as Swedish in about 40% of
   * clips and is *sure* when it does -- so a probability threshold would pass the
   * one answer a calibrated rule rejects.
   */
  const runIdentify = useCallback(async (uri: string) => {
    const model = ear.current;
    if (!model) return null;
    setError(null);
    setBusy('Identifying language');
    try {
      const t0 = Date.now();
      const detection = await model.identify({ uri });
      const elapsed = Date.now() - t0;
      setEarMs(elapsed);
      setHeard(detection);
      console.log(
        `[ear] identify ok in ${elapsed}ms (native ${(detection.processingSec * 1000).toFixed(0)}ms) — ` +
          `${detection.language ?? 'none'} at ${detection.confidence.toFixed(2)} ` +
          `reliable=${detection.isReliable} windows=${detection.windows} ` +
          `revision=${detection.modelRevision}`
      );
      console.log(
        `[ear]   candidates: ${detection.candidates
          .slice(0, 5)
          .map((c) => `${c.language} ${c.probability.toFixed(3)}`)
          .join(', ')}`
      );
      // The two reasons an answer can be unreliable, told apart rather than
      // lumped together -- a caller showing "we are not sure" wants to know
      // which, because only one of them gets better with more audio.
      if (!detection.isReliable && detection.language) {
        const nordic = Ear.confusableLanguages.includes(detection.language);
        const runnerUp = detection.candidates[1]?.probability ?? 0;
        console.log(
          nordic
            ? `[ear]   unreliable because ${detection.language} is one of the Nordic three, ` +
                'which the detector confuses confidently'
            : `[ear]   unreliable because the margin is ` +
                `${(detection.confidence - runnerUp).toFixed(3)} < ${Ear.reliableMargin}`
        );
      }
      if (detection.language && !Voz.supportedLanguages.includes(detection.language)) {
        console.log(
          `[ear]   Voz does not cover ${detection.language} — it would transcribe this anyway, ` +
            'and the result would be confident nonsense'
        );
      }
      return detection;
    } catch (e) {
      console.log(`[ear] identify FAILED: ${describe(e)}`);
      setError(describe(e));
      return null;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /**
   * Suggest emoji for whatever is in the field.
   *
   * Called from a 150 ms debounce below rather than from `onChangeText` directly.
   * Not to protect the model -- a suggestion is about two milliseconds, and this
   * is the one model here where per-keystroke inference is the intended use --
   * but to keep React from re-rendering a suggestion row on every frame of a fast
   * typist. The timing printed next to the result is the evidence for that claim
   * on a real device.
   */
  const runSuggest = useCallback(async (text: string, skinTone: EmojiSkinTone = 'default') => {
    const model = emo.current;
    if (!model) return;
    if (text.trim().length === 0) {
      setEmoji(null);
      setEmoMs(null);
      return;
    }
    try {
      const t0 = Date.now();
      const suggestions = await model.suggest(text, { limit: 6, skinTone });
      setEmoMs(Date.now() - t0);
      setEmoji(suggestions);
    } catch (e) {
      console.log(`[emo] suggest FAILED: ${describe(e)}`);
      setError(describe(e));
      // Drop the handle and rebuild it. This exists for one case, and it is a
      // development one: Fast Refresh tears down the native shared-object
      // registry while this closure still holds the JavaScript half, so the next
      // call lands on a model whose native side is gone
      // ("Unable to find the native shared object..."). Emo is the only model
      // here that can hit it, because it is the only one that calls a model from
      // a timer rather than from a tap.
      emo.current?.release();
      emo.current = null;
      void prepareEmo();
    }
  }, [prepareEmo]);

  // Debounce the field into `runSuggest`. The cleanup cancels the pending timer
  // on every keystroke, so only the last one in a burst reaches the model.
  useEffect(() => {
    if (emoState !== 'ready') return;
    const timer = setTimeout(() => void runSuggest(phrase, tone), 150);
    return () => clearTimeout(timer);
  }, [phrase, tone, emoState, runSuggest]);

  /**
   * Find the fillers in a file, and -- when there is a transcript for the same
   * audio -- reconcile the two.
   *
   * The reconciliation is the part worth watching. Voz places a word boundary to
   * about 80 ms and Uhm places a filler edge to 20 ms, so the two models disagree
   * about the same audio by a measurable amount; `Uhm.reconcileWords` is
   * upstream's rule for resolving that, and the count it changes is the count of
   * words that were really "um".
   */
  const runDetectFillers = useCallback(async (uri: string, spoken?: Transcript | null) => {
    const model = uhm.current;
    if (!model) return null;
    setError(null);
    setBusy('Finding fillers');
    try {
      const t0 = Date.now();
      const found = await model.analyze({ uri, onProgress: setProgress });
      console.log(
        `[uhm] analyze ok in ${Date.now() - t0}ms — ${found.fillers.length} fillers in ` +
          `${found.durationSec.toFixed(2)}s rtf=${found.realtimeFactor.toFixed(0)}x ` +
          `decode=${(found.timings.decodeSec * 1000).toFixed(0)}ms ` +
          `inference=${(found.timings.inferenceSec * 1000).toFixed(0)}ms ` +
          `labeling=${(found.timings.labelingSec * 1000).toFixed(0)}ms ` +
          `revision=${found.modelRevision?.slice(0, 7)} runtime=${found.modelRuntime}`
      );
      found.fillers.forEach((f) =>
        console.log(
          `[uhm]   ${(f.type ?? 'filler').padEnd(6)} ${f.start.toFixed(2)}–${f.end.toFixed(2)}s ` +
            `(${(f.durationSec * 1000).toFixed(0)}ms, conf ${f.confidence.toFixed(2)})`
        )
      );
      setDisfluency(found);

      if (spoken && spoken.words.length > 0) {
        const clean = Uhm.reconcileWords(spoken.words, found.fillers);
        console.log(
          `[uhm] reconcileWords: ${spoken.words.length} words -> ${clean.length} ranges ` +
            `(${spoken.words.length - clean.length} removed)`
        );
        setReconciled({ before: spoken.words.length, after: clean.length });
      } else {
        setReconciled(null);
      }
      return found;
    } catch (e) {
      console.log(`[uhm] analyze FAILED: ${describe(e)}`);
      setError(describe(e));
      return null;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  const record = useCallback(async () => {
    setError(null);
    setEnhancedUri(null);
    setMetrics(null);
    setTranscript(null);
    setHighlights(null);
    setDisfluency(null);
    setReconciled(null);
    setAgreement(null);
    // Re-arm the session every time, not once at mount: `stopAndEnhance` hands it
    // back to playback when it finishes, so by the second recording iOS would
    // otherwise refuse with RecordingDisabledException.
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  /**
   * Stop, enhance, and -- if Voz is ready -- transcribe, in one tap.
   *
   * The transcription runs on the *enhanced* file rather than the raw one, which
   * is the reason to have both models in one app: Clear removes the noise and
   * reverb that a recogniser would otherwise have to guess through.
   */
  const stopAndProcess = useCallback(async () => {
    await recorder.stop();
    // Hand the audio session back to playback before doing anything else. While
    // `allowsRecording` is true iOS keeps the session in PlayAndRecord, which
    // both muffles playback through the receiver and leaves the session engaged
    // while the models read the file.
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });

    const uri = recorder.uri;
    if (!uri) {
      setError('The recorder produced no file.');
      return;
    }
    setOriginalUri(uri);

    console.log(`[rec] uri=${uri} bytes=${new File(uri).size}`);

    // Cleaning is a step, not a gate. Returning here when Clear is not loaded --
    // which is what this did -- threw away the recording for the two models that
    // never needed Clear, and Uhm never needs it at all.
    let enhanced: string | null = null;
    const model = clear.current;
    if (!model) {
      console.log('[rec] Clear not loaded — skipping the enhance');
    } else {
      setBusy('Enhancing');
      try {
        const result = await model.enhance({
          uri,
          targetLUFS: 'applePodcasts',
          onProgress: setProgress,
        });
        console.log(
          `[rec] enhanced — ${result.uri.split('/').pop()} bytes=${new File(result.uri).size} ` +
            `${result.durationSec.toFixed(2)}s rtf=${result.realtimeFactor.toFixed(1)}x ` +
            `LUFS=${result.measuredLUFS} truePeak=${result.measuredTruePeakDBFS}`
        );
        enhanced = result.uri;
        setEnhancedUri(result.uri);
        setMetrics(result);
      } catch (e) {
        console.log(`[rec] enhance FAILED: ${describe(e)}`);
        setError(describe(e));
      } finally {
        setBusy(null);
        setProgress(null);
      }
    }

    // Ear before Voz, because that is the order the two are meant to run in:
    // Voz cannot tell you it is out of its depth, so something has to ask first.
    // It runs on whatever audio exists, enhanced or not -- language survives the
    // noise that Clear removes.
    let language: Detection | null = null;
    if (ear.current) {
      language = await runIdentify(enhanced ?? uri);
    } else {
      console.log('[ear] skipped — not ready yet when the recording finished');
    }

    // Voz next, so the fillers can be reconciled against a transcript of the
    // same audio in one pass.
    //
    // Note what this deliberately does NOT do: it does not refuse to transcribe
    // when Ear is unsure or names a language Voz does not cover. Ear's answer is
    // information for the person reading the screen, and gating the rest of the
    // demo on it would hide the models behind each other. A real app routing
    // unattended work would gate; a demo showing what each model says should not.
    let spoken: Transcript | null = null;
    if (enhanced && voz.current) {
      // `runTranscribe` answers undefined when its model went away mid-call.
      spoken = (await runTranscribe(enhanced)) ?? null;
      if (spoken && clips.current) {
        await runFindClips(spoken);
      }
    }

    // The join this app is here to show, and the only place two models answer the
    // same question from different evidence. Ear read the waveform; Tongue reads
    // the words Voz got out of it. Neither sees what the other saw.
    //
    // It is reported, not enforced. Where the two disagree, that is the output --
    // Ear is listening to phonetics and Tongue is reading orthography, and a
    // transcriber that was out of its depth produces text that *looks* like a
    // language it is not. A real pipeline would treat the disagreement as a
    // reason to distrust the transcript; a demo should show it.
    if (spoken && spoken.text.trim().length > 0 && tongue.current) {
      const fromText = tongue.current.detectSync(spoken.text);
      const earSaid = language?.language ?? null;
      setAgreement({
        ear: earSaid,
        earReliable: language?.isReliable ?? false,
        tongue: fromText.language,
        tongueReliability: fromText.reliability,
        words: spoken.words.length,
      });
      console.log(
        `[join] Ear heard ${earSaid ?? 'nothing'} (reliable=${language?.isReliable ?? false}); ` +
          `Tongue read ${fromText.language ?? 'nothing'} from ${spoken.words.length} words ` +
          `(${fromText.reliability}, ${(fromText.processingSec * 1e6).toFixed(0)}us) — ` +
          `${earSaid === fromText.language ? 'AGREE' : 'DISAGREE'}`
      );
    }

    // Uhm runs on whatever audio exists, enhanced or not, and runs even when
    // Clear failed. It reads the waveform, so it needs neither of the two models
    // above -- and a step that needs nothing from the chain should not be lost
    // with the chain. The reconciliation is the only part that wants a
    // transcript, and it is skipped rather than blocking when there is none.
    if (uhm.current) {
      await runDetectFillers(enhanced ?? uri, spoken);
    } else {
      // Said out loud, because the silence was genuinely confusing: Uhm takes
      // about 20 s to load, so a recording stopped before it is ready skips this
      // step -- and skipping it quietly looks exactly like the model failing.
      console.log('[uhm] skipped — not ready yet when the recording finished');
    }

    // One line tying the run together, because the interesting failure is a
    // combination rather than any single step: a transcript that exists, from a
    // language the transcriber does not cover, that nobody flagged.
    console.log(
      `[run] language=${language?.language ?? 'unknown'} ` +
        `reliable=${language?.isReliable ?? false} ` +
        `transcribed=${spoken !== null} ` +
        `trustworthy=${
          spoken === null
            ? 'n/a'
            : language !== null &&
              language.isReliable &&
              Voz.supportedLanguages.includes(language.language ?? '')
        }`
    );
  }, [recorder, runIdentify]);

  /**
   * Rank the transcript's best moments.
   *
   * `Clips.toSentences` is the join between the two models, and it is upstream's
   * own sentence splitter rather than a regex here: Voz hands back words, Clips
   * wants sentences, and where a sentence ends is something clip selection was
   * trained on.
   */
  const runFindClips = useCallback(async (source: Transcript) => {
    const model = clips.current;
    if (!model) return;
    setError(null);
    setBusy('Finding highlights');
    try {
      const sentences = Clips.toSentences(source.words);
      console.log(`[clips] ${source.words.length} words -> ${sentences.length} sentences`);
      const t0 = Date.now();
      const found = await model.find({ sentences });
      console.log(
        `[clips] find ok in ${Date.now() - t0}ms — ${found.length} clips from ` +
          `${sentences.length} sentences`
      );
      found.forEach((c) =>
        console.log(
          `[clips]   #${c.rank} p=${c.percentile.toFixed(2)} score=${c.score.toFixed(2)} ` +
            `${c.durationSec.toFixed(1)}s ranges=${JSON.stringify(c.ranges)} "${c.text.slice(0, 60)}"`
        )
      );
      setHighlights(found);
    } catch (e) {
      console.log(`[clips] find FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /** Transcribe a file that is already on disk. */
  const runTranscribe = useCallback(async (uri: string) => {
    const model = voz.current;
    if (!model) return;
    setError(null);
    setBusy('Transcribing');
    try {
      const t0 = Date.now();
      const result = await model.transcribe({ uri, onProgress: setProgress });
      console.log(
        `[voz] transcribe ok in ${Date.now() - t0}ms — ${result.words.length} words, ` +
          `${result.durationSec.toFixed(2)}s rtf=${result.realtimeFactor.toFixed(1)}x ` +
          `revision=${result.modelRevision} runtime=${result.modelRuntime}`
      );
      console.log(`[voz] "${result.text}"`);
      setTranscript(result);
      return result;
    } catch (e) {
      console.log(`[voz] transcribe FAILED: ${describe(e)}`);
      setError(describe(e));
      return null;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  /**
   * Exercise every native path on synthetic audio, without a microphone.
   *
   * Clear: write a WAV to the cache and run `enhance` on it (the primary,
   * file-based API), then push the same samples through `enhanceSamples` (the
   * in-memory one). Voz: transcribe that same WAV, then the same samples.
   *
   * The Voz legs are a **plumbing check, not an accuracy check** -- a 200 Hz tone
   * under hiss is not speech, so an empty or nonsense transcript is the expected
   * result. What is being asserted is that the model loads, runs on the Neural
   * Engine, and returns a well-formed result with timings in range.
   *
   * Useful on its own as a smoke test after changing anything native, and it
   * needs no permission dialog, so it can be driven from a terminal.
   */
  /**
   * Exercise every native path on synthetic input, without a microphone.
   *
   * Four independent legs, each with its own try/catch and each skipped if its
   * model is not prepared. Independent on purpose: they were one block until a
   * hang inside Clear's in-memory path on the simulator meant the Clips leg --
   * which shares nothing with it -- never ran and reported nothing. A smoke test
   * that can only tell you about its first failure is most of a smoke test
   * missing.
   *
   * Useful after changing anything native, and it needs no permission dialog, so
   * it can be driven from a terminal.
   */
  const selfTest = useCallback(async () => {
    setError(null);
    setBusy('Self-test');
    const failures: string[] = [];
    const sampleRate = 48_000;
    const noisy = syntheticSpeech(sampleRate, 2);
    let enhancedForVoz: string | null = null;

    // The models loaded on mount go first, because each leg awaits the one
    // before it: a leg that hangs rather than throwing takes every later leg
    // down with it, and its own try/catch cannot help. Putting the always-ready
    // ones at the front means the self-test always reports something. Ear leads
    // because it is the cheapest *audio* model here -- ~9 MB and a quarter of a
    // second -- and Tongue follows it because the two answer the same question
    // from different evidence, which makes them worth reading next to each other.

    // --- Ear. Loaded on mount like Uhm, and cheaper, so it runs first.
    //
    //     The synthetic tone is the honest case to assert on here: a 200 Hz sine
    //     under hiss is not speech in any language, so what is being tested is
    //     that the model loads, runs, and returns a well-formed ranking -- not
    //     that it names a language, which would be meaningless. The invariants
    //     are the ones that must hold whatever it heard.
    //
    //     A real recording dropped into the cache as `ear-sample.wav` turns this
    //     into a real question, the same way `uhm-sample.wav` does for Uhm.
    try {
      const identifier = ear.current;
      if (!identifier) {
        console.log('[ear] self-test skipped — model not prepared');
      } else {
        const sample = new File(Paths.cache, 'ear-sample.wav');
        const real = sample.exists;
        let target = sample.uri;
        if (!real) {
          const synthetic = new File(Paths.cache, 'selftest-ear.wav');
          synthetic.create({ overwrite: true });
          await synthetic.write(encodeWav(noisy, sampleRate));
          target = synthetic.uri;
        }
        console.log(`[ear] identifying ${real ? 'real speech' : 'synthetic audio'}: ${target.split('/').pop()}`);

        const t0 = Date.now();
        const detection = await identifier.identify({ uri: target });
        console.log(
          `[ear] identify(file) ok in ${Date.now() - t0}ms — ${detection.language ?? 'none'} ` +
            `at ${detection.confidence.toFixed(3)} reliable=${detection.isReliable} ` +
            `windows=${detection.windows} native=${(detection.processingSec * 1000).toFixed(0)}ms`
        );
        console.log(
          `[ear]   top: ${detection.candidates
            .slice(0, 5)
            .map((c) => `${c.language} ${c.probability.toFixed(3)}`)
            .join(', ')}`
        );

        // The invariants: ranked, normalized, the winner is the head of the list,
        // and the two derived fields agree with the candidates they come from.
        const ranked = detection.candidates.every(
          (c, i) => i === 0 || c.probability <= detection.candidates[i - 1]!.probability
        );
        const bounded = detection.candidates.every((c) => c.probability >= 0 && c.probability <= 1);
        const total = detection.candidates.reduce((sum, c) => sum + c.probability, 0);
        const headAgrees =
          detection.language === (detection.candidates[0]?.language ?? null) &&
          Math.abs(detection.confidence - (detection.candidates[0]?.probability ?? 0)) < 1e-9;
        if (!ranked) failures.push('ear: candidates are not in descending order');
        if (!bounded) failures.push('ear: a probability is outside 0..1');
        if (!headAgrees) failures.push('ear: language/confidence disagree with candidates[0]');
        console.log(
          `[ear] ranked=${ranked} bounded=${bounded} headAgrees=${headAgrees} ` +
            `sum=${total.toFixed(3)}`
        );

        // `isReliable` is decided natively, so this does not recompute it -- it
        // checks that the answer is *consistent* with the two rules it is made
        // of, which is a different and much weaker claim, and the only one a
        // caller can make without duplicating the calibration.
        const runnerUp = detection.candidates[1]?.probability ?? 0;
        const nordic =
          detection.language !== null && Ear.confusableLanguages.includes(detection.language);
        const wideEnough = detection.confidence - runnerUp >= Ear.reliableMargin;
        const consistent = detection.isReliable === (wideEnough && !nordic);
        if (!consistent) {
          failures.push(
            `ear: isReliable=${detection.isReliable} but margin=${(detection.confidence - runnerUp).toFixed(3)} nordic=${nordic}`
          );
        }
        console.log(`[ear] isReliable consistent with margin and Nordic rule: ${consistent}`);

        // Same audio through the in-memory path, which proves the native
        // resample (48 kHz in, 16 kHz model) and the buffer copy.
        const t1 = Date.now();
        const fromSamples = await identifier.identifySamples(noisy, sampleRate);
        console.log(
          `[ear] identifySamples ok in ${Date.now() - t1}ms — ${fromSamples.language ?? 'none'} ` +
            `from ${(noisy.length / sampleRate).toFixed(1)}s of 48 kHz audio`
        );

        // One window instead of three. On audio shorter than one window this
        // must come back having listened to exactly one either way, which is the
        // "fewer are used when the audio is shorter" rule stated as a test.
        const single = await identifier.identify({ uri: target, windows: 1 });
        console.log(
          `[ear] windows=1 -> listened=${single.windows} (default run listened=${detection.windows}); ` +
            `two seconds of audio is under one 30 s window, so both should be 1`
        );
        if (single.windows !== 1) failures.push(`ear: windows=1 listened to ${single.windows}`);

        // The argument guards, which never reach native.
        for (const bad of [0, -1, 1.5]) {
          try {
            await identifier.identify({ uri: target, windows: bad });
            failures.push(`ear: windows=${bad} was accepted`);
          } catch (e) {
            if (!(e instanceof DesertAntError) || e.code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`ear: windows=${bad} raised ${describe(e)}`);
            }
          }
        }
        console.log('[ear] rejected 0, -1 and 1.5 windows with ERR_INVALID_ARGUMENT');

        // A file that is not there. The point is the *code*: a missing file is a
        // decode failure, not an inference failure, so an app can tell "your file
        // is gone" from "the model broke".
        try {
          await identifier.identify({ uri: `${Paths.cache.uri}definitely-not-here.wav` });
          failures.push('ear: a missing file was accepted');
        } catch (e) {
          const code = e instanceof DesertAntError ? e.code : 'not a DesertAntError';
          console.log(`[ear] missing file -> ${code}`);
          if (code !== 'ERR_AUDIO_DECODE_FAILED') {
            failures.push(`ear: missing file raised ${code}`);
          }
        }

        // The claim worth testing by hand, because it is the whole model: does it
        // actually name the language, or does it only produce a well-formed
        // ranking? Drop `ear-<code>.wav` files into the app's cache -- half a
        // minute of speech each, which is what one window is -- and every one of
        // them is a labelled question with a right answer.
        //
        // Nothing is asserted when the files are absent. A test that passes
        // because its fixtures are missing is worse than no test.
        const labelled = LANGUAGE_SAMPLES.map((code) => ({
          code,
          file: new File(Paths.cache, `ear-${code}.wav`),
        })).filter(({ file }) => file.exists);
        if (labelled.length === 0) {
          console.log(
            `[ear] no labelled samples in the cache — drop ear-<code>.wav files there ` +
              `(${LANGUAGE_SAMPLES.join(', ')}) to check the answers rather than the shape`
          );
        } else {
          let correct = 0;
          for (const { code, file } of labelled) {
            const answer = await identifier.identify({ uri: file.uri });
            const right = answer.language === code;
            if (right) correct += 1;
            console.log(
              `[ear]   ${code} -> ${answer.language ?? 'none'} ${answer.confidence.toFixed(3)} ` +
                `${right ? 'OK' : 'WRONG'} reliable=${answer.isReliable} ` +
                `windows=${answer.windows} ${(answer.processingSec * 1000).toFixed(0)}ms ` +
                `runnerUp=${answer.candidates[1]?.language ?? '—'} ` +
                `${(answer.candidates[1]?.probability ?? 0).toFixed(3)}`
            );
          }
          console.log(`[ear] labelled samples: ${correct} of ${labelled.length} correct`);
          if (correct < labelled.length) {
            failures.push(`ear: ${labelled.length - correct} of ${labelled.length} samples misidentified`);
          }
        }

        // The language list, which is the one call that is iOS-only.
        try {
          const languages = await identifier.supportedLanguages();
          console.log(
            `[ear] supportedLanguages -> ${languages.length} codes, ` +
              `unique=${new Set(languages).size}, includes en/pt/ja=` +
              `${['en', 'pt', 'ja'].every((l) => languages.includes(l))}`
          );
          if (languages.length < 90) {
            failures.push(`ear: supportedLanguages returned ${languages.length}, expected ~99`);
          }
        } catch (e) {
          const code = e instanceof DesertAntError ? e.code : 'not a DesertAntError';
          console.log(`[ear] supportedLanguages -> ${code} (expected off iOS)`);
          if (Platform.OS === 'ios') {
            failures.push(`ear: supportedLanguages failed on iOS with ${code}`);
          }
        }
      }
    } catch (e) {
      console.log(`[ear] self-test FAILED: ${describe(e)}`);
      failures.push(`ear: ${describe(e)}`);
    }

    // --- Tongue. Ear's sibling in the text domain, and cheaper than it by four
    //     orders of magnitude: 2 MB already inside the app binary, and a
    //     detection measured in microseconds rather than seconds.
    //
    //     This is the one leg with a real answer key that needs no fixture files.
    //     Ear's labelled samples are half-minute recordings someone has to put in
    //     the cache; Tongue's are strings, so the question "does it actually name
    //     the language, or does it only produce a well-formed ranking?" can be
    //     asked on every run.
    try {
      const reader = tongue.current;
      if (!reader) {
        console.log('[tongue] self-test skipped — model not prepared');
      } else {
        // The invariants first, on one string, before anything is scored.
        const one = reader.detectSync('kann ich das haben');
        console.log(
          `[tongue] detectSync("kann ich das haben") -> ${one.language ?? 'none'} ` +
            `${one.confidence.toFixed(3)} ${one.reliability} tooClose=${one.isTooCloseToCall} ` +
            `route=${one.route.verdict}/${one.route.script ?? '—'} ` +
            `native=${(one.processingSec * 1e6).toFixed(0)}us`
        );
        const ranked = one.candidates.every(
          (c, i) => i === 0 || c.probability <= one.candidates[i - 1]!.probability
        );
        const bounded = one.candidates.every((c) => c.probability >= 0 && c.probability <= 1);
        const headAgrees =
          one.language === (one.candidates[0]?.language ?? null) &&
          Math.abs(one.confidence - (one.candidates[0]?.probability ?? 0)) < 1e-9;
        if (!ranked) failures.push('tongue: candidates are not in descending order');
        if (!bounded) failures.push('tongue: a probability is outside 0..1');
        if (!headAgrees) failures.push('tongue: language/confidence disagree with candidates[0]');
        console.log(`[tongue] ranked=${ranked} bounded=${bounded} headAgrees=${headAgrees}`);

        // `isTooCloseToCall` is decided natively, so this does not recompute it --
        // it checks the answer is *consistent* with the margin it is made of,
        // which is a weaker claim and the only one a caller can make without
        // duplicating the rule.
        const gap = one.confidence - (one.candidates[1]?.probability ?? 0);
        const consistent =
          one.candidates.length < 2 ? !one.isTooCloseToCall : one.isTooCloseToCall === gap < Tongue.tieMargin;
        if (!consistent) {
          failures.push(
            `tongue: isTooCloseToCall=${one.isTooCloseToCall} but the gap is ${gap.toFixed(3)}`
          );
        }
        console.log(`[tongue] isTooCloseToCall consistent with tieMargin: ${consistent}`);

        // The answer key. Eleven languages across seven scripts, each a handful
        // of words -- which is the claim: "detect language based on 3 words".
        let correct = 0;
        for (const { code, text } of TONGUE_SAMPLES) {
          const answer = reader.detectSync(text, { topK: 3 });
          const right = answer.language === code;
          if (right) correct += 1;
          console.log(
            `[tongue]   ${code.padEnd(3)} -> ${(answer.language ?? 'none').padEnd(3)} ` +
              `${answer.confidence.toFixed(3)} ${right ? 'OK   ' : 'WRONG'} ` +
              `${answer.reliability.padEnd(9)} ${answer.route.verdict.padEnd(9)} ` +
              `${(answer.route.script ?? '—').padEnd(10)} ` +
              `${(answer.processingSec * 1e6).toFixed(0)}us  "${text}"`
          );
        }
        console.log(`[tongue] labelled strings: ${correct} of ${TONGUE_SAMPLES.length} correct`);
        if (correct < TONGUE_SAMPLES.length) {
          failures.push(
            `tongue: ${TONGUE_SAMPLES.length - correct} of ${TONGUE_SAMPLES.length} strings misidentified`
          );
        }

        // The latency claim, which is the reason `detectSync` exists at all. A
        // thousand detections of one string, timed in JavaScript, so the number
        // includes the bridge hop a real caller pays.
        const timed = 'the quick brown fox jumps over the lazy dog';
        const t0 = performance.now();
        for (let i = 0; i < 1000; i += 1) reader.detectSync(timed);
        const perCall = ((performance.now() - t0) * 1000) / 1000;
        console.log(`[tongue] 1000 synchronous detections: ${perCall.toFixed(1)}us each, bridge included`);

        // The router's two shortcuts, which are the interesting structure: a
        // script only one language uses answers at probability 1 without the
        // model, and a script several share narrows the field before the model
        // decodes.
        const decisive = reader.detectSync('안녕하세요 반갑습니다');
        const narrowing = reader.detectSync('привет как дела сегодня');
        console.log(
          `[tongue] decisive: ko text -> ${decisive.language} p=${decisive.confidence.toFixed(3)} ` +
            `${decisive.reliability} verdict=${decisive.route.verdict} ` +
            `allowed=${decisive.route.candidates.join('/')}`
        );
        console.log(
          `[tongue] narrowing: ru text -> ${narrowing.language} verdict=${narrowing.route.verdict} ` +
            `allowed=${narrowing.route.candidates.join('/')}`
        );
        if (decisive.route.verdict !== 'decisive') {
          failures.push(`tongue: Hangul routed ${decisive.route.verdict}, expected decisive`);
        }
        if (narrowing.route.verdict !== 'narrowing') {
          failures.push(`tongue: Cyrillic routed ${narrowing.route.verdict}, expected narrowing`);
        }

        // Empty input is an answer, not an error -- a field that clears while
        // someone is typing should get `empty`, not an exception.
        const nothing = reader.detectSync('   \n  ');
        console.log(
          `[tongue] whitespace -> language=${nothing.language} reliability=${nothing.reliability} ` +
            `candidates=${nothing.candidates.length}`
        );
        if (nothing.reliability !== 'empty' || nothing.language !== null) {
          failures.push(`tongue: whitespace gave ${nothing.reliability}/${nothing.language}`);
        }

        // The normalizer is visible, and that is the point of `normalized`: the
        // model never saw the URL, the digits or the capitals.
        const messy = reader.detectSync('Check HTTPS://example.com/x?q=1 @someone — 2024 très bien');
        console.log(`[tongue] normalized: "${messy.normalized}" -> ${messy.language}`);

        // Over the cap. Not an error: truncated at Tongue.maxCharacters scalars,
        // and `normalized` shows exactly what was seen.
        const long = reader.detectSync('gato '.repeat(300));
        console.log(
          `[tongue] ${1500} chars in -> normalized ${long.normalized.length} ` +
            `(cap ${Tongue.maxCharacters}) -> ${long.language}`
        );
        if (long.normalized.length > Tongue.maxCharacters) {
          failures.push(`tongue: normalized ${long.normalized.length} chars, cap is ${Tongue.maxCharacters}`);
        }

        // topK is honoured and does not move the winner.
        const one_ = reader.detectSync('la casa', { topK: 1 });
        const many = reader.detectSync('la casa', { topK: 8 });
        console.log(
          `[tongue] topK 1 -> ${one_.candidates.length} candidate(s), topK 8 -> ` +
            `${many.candidates.length}; winner ${one_.language}/${many.language}; ` +
            `tooClose=${many.isTooCloseToCall} (${many.candidates
              .map((c) => `${c.language} ${c.probability.toFixed(3)}`)
              .join(', ')})`
        );
        if (one_.candidates.length !== 1) failures.push('tongue: topK=1 returned more than one');
        if (one_.language !== many.language) failures.push('tongue: topK changed the winner');

        // The argument guards, which never reach native.
        for (const bad of [0, -1, 1.5]) {
          try {
            reader.detectSync('hola', { topK: bad });
            failures.push(`tongue: topK=${bad} was accepted`);
          } catch (e) {
            if (!(e instanceof DesertAntError) || e.code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`tongue: topK=${bad} raised ${describe(e)}`);
            }
          }
        }
        console.log('[tongue] rejected 0, -1 and 1.5 candidates with ERR_INVALID_ARGUMENT');

        // The script catalogue, which is the one call iOS can answer and Android
        // cannot.
        try {
          const scripts = Tongue.supportedScripts();
          console.log(`[tongue] supportedScripts -> ${scripts.length} names, unique=${new Set(scripts).size}`);
          if (scripts.length < 30) {
            failures.push(`tongue: supportedScripts returned ${scripts.length}, expected ~32`);
          }
        } catch (e) {
          const code = e instanceof DesertAntError ? e.code : 'not a DesertAntError';
          console.log(`[tongue] supportedScripts -> ${code} (expected off iOS)`);
          if (Platform.OS === 'ios') {
            failures.push(`tongue: supportedScripts failed on iOS with ${code}`);
          }
        }

        // And the join, on the one content both models can be asked about
        // without a microphone: the transcript this app ranks with Clips.
        const fromTranscript = reader.detectSync(SAMPLE_TRANSCRIPT.join(' '));
        console.log(
          `[tongue] the sample transcript reads as ${fromTranscript.language} ` +
            `${fromTranscript.confidence.toFixed(3)} ${fromTranscript.reliability}`
        );
      }
    } catch (e) {
      console.log(`[tongue] self-test FAILED: ${describe(e)}`);
      failures.push(`tongue: ${describe(e)}`);
    }

    // --- Gist. The other text model, and the one that answers a different
    //     question about the same string Tongue just read: not what language it
    //     is in, but what it is about.
    //
    //     Nothing here asserts a taxonomy slug. The 36 topics come down with the
    //     weights and are free to be renamed or retuned at the next revision, so
    //     an answer key written here would be a fixture of this package's
    //     opinion rather than of the model's behaviour. What is asserted is the
    //     shape -- ranked, bounded, unique, capped, named -- plus the one
    //     semantic claim that does not depend on any particular slug: the same
    //     subject in three languages should land on the same topic, which is the
    //     multilingual claim and not something a keyword table could fake.
    try {
      const tagger = gist.current;
      if (!tagger) {
        console.log('[gist] self-test skipped — model not prepared (~74 MB, tap to load)');
      } else {
        const t0 = Date.now();
        const tagging = await tagger.classify(GIST_SAMPLES[0]!.text);
        console.log(
          `[gist] classify ok in ${Date.now() - t0}ms — ${tagging.topics.length} topics, ` +
            `variant=${tagging.variant} revision=${tagging.modelRevision} ` +
            `native=${(tagging.processingSec * 1000).toFixed(1)}ms`
        );
        console.log(
          `[gist]   "${GIST_SAMPLES[0]!.text}" -> ` +
            tagging.topics.map((t) => `${t.slug} ${t.score.toFixed(3)}`).join(', ')
        );

        // The invariants: ranked, bounded, capped at topK, no slug twice, and
        // every topic carrying the display name that comes out of taxonomy.json
        // rather than a slug this package retyped.
        const ranked = tagging.topics.every(
          (t, i) => i === 0 || t.score <= tagging.topics[i - 1]!.score
        );
        const bounded = tagging.topics.every((t) => t.score >= 0 && t.score <= 1);
        const unique = new Set(tagging.topics.map((t) => t.slug)).size === tagging.topics.length;
        const named = tagging.topics.every((t) => t.name.length > 0 && t.name !== t.slug);
        const capped = tagging.topics.length <= Gist.defaultTopK;
        const headAgrees = tagging.topic?.slug === (tagging.topics[0]?.slug ?? undefined);
        if (!ranked) failures.push('gist: topics are not in descending order');
        if (!bounded) failures.push('gist: a score is outside 0..1');
        if (!unique) failures.push('gist: the same slug came back twice');
        if (!named) failures.push('gist: a topic has no display name');
        if (!capped) failures.push(`gist: ${tagging.topics.length} topics for topK ${Gist.defaultTopK}`);
        if (!headAgrees) failures.push('gist: topic disagrees with topics[0]');
        console.log(
          `[gist] ranked=${ranked} bounded=${bounded} unique=${unique} named=${named} ` +
            `capped=${capped} headAgrees=${headAgrees} threshold=${tagging.threshold}`
        );

        // One subject, four languages. The claim is 101 languages from one model
        // with no language setting to pass in, so the interesting output is
        // whether the top topic survives translation.
        const multilingual: string[] = [];
        for (const sample of GIST_SAMPLES) {
          const one = await tagger.classify(sample.text);
          multilingual.push(one.topic?.slug ?? 'none');
          console.log(
            `[gist]   ${sample.code} "${sample.text}" -> ` +
              one.topics.map((t) => `${t.slug} ${t.score.toFixed(3)}`).join(', ')
          );
        }
        const agreed = new Set(multilingual).size;
        console.log(
          `[gist] one subject in ${GIST_SAMPLES.length} languages -> ` +
            `${multilingual.join('/')} (${agreed} distinct top topic${agreed === 1 ? '' : 's'})`
        );
        if (agreed > 2) {
          failures.push(`gist: four translations of one sentence gave ${agreed} different topics`);
        }

        // topK caps without changing the winner, and a threshold of 1 leaves
        // exactly the one topic upstream always returns.
        const one_ = await tagger.classify(GIST_SAMPLES[0]!.text, { topK: 1 });
        const many = await tagger.classify(GIST_SAMPLES[0]!.text, { topK: 10 });
        const strict = await tagger.classify(GIST_SAMPLES[0]!.text, { threshold: 1 });
        console.log(
          `[gist] topK 1 -> ${one_.topics.length}, topK 10 -> ${many.topics.length}, ` +
            `threshold 1 -> ${strict.topics.length} (upstream always returns the top one); ` +
            `winner ${one_.topic?.slug}/${many.topic?.slug}/${strict.topic?.slug}`
        );
        if (one_.topics.length !== 1) failures.push('gist: topK=1 returned more than one');
        if (one_.topic?.slug !== many.topic?.slug) failures.push('gist: topK changed the winner');
        if (strict.topics.length !== 1) {
          failures.push(`gist: threshold 1 returned ${strict.topics.length} topics`);
        }
        if (strict.threshold !== 1) failures.push('gist: an explicit threshold was not echoed back');

        // Blank input is an answer, not an error -- and it never reaches the
        // model. The two upstream SDKs disagree here; this is the side taken.
        const blank = await tagger.classify('   ');
        console.log(
          `[gist] blank input -> ${blank.topics.length} topics, topic=${blank.topic} ` +
            '(Kotlin returns none; Swift upstream would name one)'
        );
        if (blank.topics.length !== 0) failures.push('gist: blank input produced a topic');

        // The full distribution, which is what a roll-up eats.
        const distribution = await tagger.scores(GIST_SAMPLES[0]!.text);
        const slugs = Object.keys(distribution.scores);
        const inRange = Object.values(distribution.scores).every((v) => v >= 0 && v <= 1);
        const superset = tagging.topics.every((t) => slugs.includes(t.slug));
        console.log(
          `[gist] scores -> ${slugs.length} topics, inRange=${inRange} ` +
            `coversClassify=${superset} native=${(distribution.processingSec * 1000).toFixed(1)}ms`
        );
        if (slugs.length < 30) failures.push(`gist: scores returned ${slugs.length}, expected 36`);
        if (!inRange) failures.push('gist: a score is outside 0..1');
        if (!superset) failures.push('gist: classify named a topic scores does not have');

        // The argument guards, which never reach native.
        for (const bad of [0, -1, 1.5]) {
          try {
            await tagger.classify('a', { topK: bad });
            failures.push(`gist: topK=${bad} was accepted`);
          } catch (e) {
            if (!(e instanceof DesertAntError) || e.code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`gist: topK=${bad} raised ${describe(e)}`);
            }
          }
        }
        for (const bad of [-0.1, 1.1]) {
          try {
            await tagger.classify('a', { threshold: bad });
            failures.push(`gist: threshold=${bad} was accepted`);
          } catch (e) {
            if (!(e instanceof DesertAntError) || e.code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`gist: threshold=${bad} raised ${describe(e)}`);
            }
          }
        }
        console.log('[gist] rejected topK 0/-1/1.5 and threshold -0.1/1.1 with ERR_INVALID_ARGUMENT');

        // The variant asymmetry: two builds on iOS, one on Android, read off the
        // binary. Asking for a build this platform does not have is refused
        // before anything downloads.
        console.log(`[gist] variants here: ${Gist.variants.join('/')} (iOS 2, Android 1)`);
        if (!Gist.variants.includes('english')) {
          try {
            Gist.create({ variant: 'english' });
            failures.push('gist: the english variant was created on a platform without it');
          } catch (e) {
            const code = e instanceof DesertAntError ? e.code : 'not a DesertAntError';
            console.log(`[gist] english variant -> ${code} (expected off iOS)`);
            if (code !== 'ERR_UNSUPPORTED_PLATFORM') {
              failures.push(`gist: the english refusal raised ${code}`);
            }
          }
        }

        // And the join, on the twelve lines Clips ranks: twelve distributions
        // rolled up into what the whole thing is about, by a function that runs
        // no model at all.
        const t1 = Date.now();
        const posts = [];
        for (const line of SAMPLE_TRANSCRIPT) {
          posts.push({ topics: (await tagger.scores(line)).scores });
        }
        const rolled = channelTopics(posts);
        console.log(
          `[gist] channelTopics over ${posts.length} transcript lines in ${Date.now() - t1}ms -> ` +
            rolled.map((t) => `${t.slug} ${(t.share * 100).toFixed(1)}% x${t.postCount}`).join(', ')
        );
        const shareRanked = rolled.every((t, i) => i === 0 || t.share <= rolled[i - 1]!.share);
        const shareTotal = rolled.reduce((sum, t) => sum + t.share, 0);
        const withinTopN = rolled.length <= Gist.defaultRollupOptions.topN;
        const aboveFloor = rolled.every((t) => t.share >= Gist.defaultRollupOptions.floor);
        const counted = rolled.every((t) => t.postCount >= 0 && t.postCount <= posts.length);
        console.log(
          `[gist] rollup ranked=${shareRanked} withinTopN=${withinTopN} aboveFloor=${aboveFloor} ` +
            `postCountsSane=${counted} sumOfShares=${shareTotal.toFixed(3)} (<=1)`
        );
        if (!shareRanked) failures.push('gist: channel topics are not in descending share order');
        if (!withinTopN) failures.push(`gist: rollup returned ${rolled.length} over topN`);
        if (!aboveFloor) failures.push('gist: a channel topic is below the share floor');
        if (!counted) failures.push('gist: a channel topic counts more posts than there are');
        if (shareTotal > 1.0001) failures.push(`gist: shares sum to ${shareTotal}`);

        // minPosts: two posts do not describe a channel, and upstream says so by
        // returning nothing rather than by being confident about two.
        const tooFew = channelTopics(posts.slice(0, 2));
        console.log(`[gist] two posts -> ${tooFew.length} channel topics (expected 0)`);
        if (tooFew.length !== 0) failures.push(`gist: two posts gave ${tooFew.length} topics`);

        setAbout(rolled);
      }
    } catch (e) {
      console.log(`[gist] self-test FAILED: ${describe(e)}`);
      failures.push(`gist: ${describe(e)}`);
    }

    // --- Redact. The fourth text model, and the one that reads a string for a
    //     different reason than the other three: not which emoji, not which
    //     language, not what it is about, but what in it is a person.
    //
    //     Nothing here asserts which labels a given sentence produces. The
    //     taxonomy and the weights are upstream's, and an answer key written
    //     here would be a fixture of this package's opinion rather than of the
    //     model's behaviour -- and a redaction benchmark run on four sentences
    //     would be worse than no benchmark. What is asserted is the shape, and
    //     the one thing that has to be exactly true for this model to be usable
    //     at all: the round trip. Mask, hand the masked text to something else,
    //     put the originals back -- and get the input again, character for
    //     character.
    try {
      const masker = redact.current;
      if (!masker) {
        console.log('[redact] self-test skipped — model not prepared');
      } else {
        const source = REDACT_SAMPLES[0]!.text;
        const t0 = Date.now();
        const result = await masker.redaction(source);
        console.log(
          `[redact] redaction ok in ${Date.now() - t0}ms — ${result.items.length} items, ` +
            `revision=${result.modelRevision} native=${(result.processingSec * 1000).toFixed(1)}ms`
        );
        console.log(`[redact]   in  "${source}"`);
        console.log(`[redact]   out "${result.redactedText}"`);
        result.items.forEach((item) =>
          console.log(
            `[redact]   ${item.label.padEnd(16)} "${item.original}" -> ${item.placeholder} ` +
              `conf ${item.confidence.toFixed(3)} @${item.start}..${item.end}`
          )
        );

        // The invariants. Ordered, non-overlapping, sliceable, bounded, and every
        // placeholder actually in the output.
        const ordered = result.items.every((it, i) => i === 0 || it.start >= result.items[i - 1]!.end);
        const slices = result.items.every((it) => source.slice(it.start, it.end) === it.original);
        const bounded = result.items.every((it) => it.confidence >= 0 && it.confidence <= 1);
        const placed = result.items.every((it) => result.redactedText.includes(it.placeholder));
        const uniquePlaceholders =
          new Set(result.items.map((it) => it.placeholder)).size === result.items.length;
        const gone = result.items.every((it) => !result.redactedText.includes(it.original));
        if (!ordered) failures.push('redact: items are not in document order, or they overlap');
        if (!slices) failures.push('redact: an offset pair does not slice its own original back out');
        if (!bounded) failures.push('redact: a confidence is outside 0..1');
        if (!placed) failures.push('redact: a placeholder is missing from the redacted text');
        if (!uniquePlaceholders) failures.push('redact: two items share a placeholder');
        if (!gone) failures.push('redact: an original survived into the redacted text');
        if (result.items.length === 0) {
          failures.push('redact: a sentence of nothing but contact details produced no items');
        }
        console.log(
          `[redact] ordered=${ordered} slices=${slices} bounded=${bounded} placed=${placed} ` +
            `unique=${uniquePlaceholders} originalsGone=${gone}`
        );

        // The round trip, which is the product. Restoring the redacted text into
        // itself has to give back the input exactly.
        const back = restore(result, result.redactedText);
        const exact = back === source;
        console.log(`[redact] restore(redactedText) === input -> ${exact}`);
        if (!exact) failures.push('redact: the round trip did not reproduce the input');

        // And the way it is actually used: a "reply" that mentions the
        // placeholders comes back naming the real people.
        const reply = result.items.map((it) => it.placeholder).join(' / ');
        const filled = restore(result, reply);
        const allBack = result.items.every((it) => filled.includes(it.original));
        console.log(`[redact] restore into a reply -> "${filled}" (all originals back: ${allBack})`);
        if (!allBack) failures.push('redact: restore left a placeholder in a reply');

        // Confidence and provenance, reported and NOT asserted -- which is the
        // interesting part of this leg.
        //
        // The tempting assertion is "a checksum-owned label always comes back at
        // exactly 1". Two runs on this simulator disproved both directions of it.
        // A confident neural GIVEN_NAME comes back at exactly 1.000, because a
        // saturated softmax rounds there in a Double and because several of
        // upstream's address post-processing stages build spans through
        // `Span(start, end, label)`, whose `score` defaults to 1.0. And an IMEI
        // -- which IS in `Deterministic.owned` -- came back at 0.900 from the
        // identifiers sample below, because the hybrid resolver can relabel an
        // ML span into an owned label and keep its score.
        //
        // So neither field reads as provenance, and a self-test that asserted
        // otherwise would be pinning a coincidence. What is logged is the shape
        // of the distribution; what is asserted is only that every score is a
        // probability, which is checked above.
        const OWNED = ['EMAIL', 'URL', 'IP_ADDRESS', 'CREDIT_CARD', 'SSN', 'BANK_ACCOUNT',
          'ROUTING_NUMBER', 'TAX_ID', 'GOVERNMENT_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'IMEI'];
        const deterministic = result.items.filter((it) => OWNED.includes(it.label));
        const exactlyOne = result.items.filter((it) => it.confidence === 1);
        console.log(
          `[redact] ${deterministic.length} checksum-owned labels here, ` +
            `${exactlyOne.length} items at exactly 1.000 — the second number is the larger one, ` +
            'so a score of 1 is not a claim about how a span was found'
        );

        // Narrowing the label set narrows the output and nothing else.
        const emailOnly = await masker.redaction(source, { labels: ['EMAIL'] });
        const onlyEmails = emailOnly.items.every((it) => it.label === 'EMAIL');
        console.log(
          `[redact] labels:['EMAIL'] -> ${emailOnly.items.length} items ` +
            `(${emailOnly.items.map((i) => i.label).join(', ') || 'none'}), onlyEmails=${onlyEmails}`
        );
        if (!onlyEmails) failures.push('redact: a narrowed label set produced another label');
        if (emailOnly.items.length > result.items.length) {
          failures.push('redact: narrowing the labels produced more items');
        }
        if (restore(emailOnly, emailOnly.redactedText) !== source) {
          failures.push('redact: the narrowed redaction did not round-trip');
        }

        // ORG is detected and not redacted by default, which is upstream's rule
        // and the one asymmetry in the taxonomy worth showing. Logged rather than
        // asserted: whether this particular sentence has a company in it is the
        // model's opinion, not this test's.
        const withOrg = await masker.redaction(REDACT_SAMPLES[0]!.text, {
          labels: [...Redact.defaultLabels, 'ORG'],
        });
        console.log(
          `[redact] default labels ${Redact.defaultLabels.length} (no ORG) -> ${result.items.length} items; ` +
            `+ORG -> ${withOrg.items.length} items ` +
            `(${withOrg.items.filter((i) => i.label === 'ORG').length} of them ORG)`
        );
        if (Redact.defaultLabels.includes('ORG')) {
          failures.push('redact: ORG is in the default label set');
        }
        if (!Redact.labels.includes('ORG')) failures.push('redact: ORG is not in the full label set');

        // The confidence floor applies to the neural half only, and the claim
        // worth asserting is the one that follows from that rather than the one
        // that sounds like it: a floor of 1 cannot drop a checksum-owned
        // detection, because a checksum is not a score. It can *keep* a neural
        // detection scoring just under 1 -- upstream's own filter is not a strict
        // inequality against a rounded number -- so asserting "everything left is
        // exactly 1" would be asserting a coincidence.
        const identity = (it: { label: string; start: number }) => `${it.label}@${it.start}`;
        const strict = await masker.redaction(source, { minimumConfidence: 1 });
        const surviving = new Set(strict.items.map(identity));
        const checksumsKept = deterministic.every((it) => surviving.has(identity(it)));
        const lowest = strict.items.reduce((min, it) => Math.min(min, it.confidence), 1);
        // Logged, not asserted, for the reason above: an owned label can arrive
        // with a sub-1 score, so "a floor of 1 cannot drop a checksum" is not an
        // invariant either. The monotonicity below is.
        console.log(
          `[redact] minimumConfidence 1 -> ${strict.items.length} items ` +
            `(was ${result.items.length}), every checksum-owned detection kept: ${checksumsKept}, ` +
            `lowest surviving confidence ${lowest.toFixed(3)}`
        );
        if (strict.items.length > result.items.length) {
          failures.push('redact: raising the confidence floor produced more items');
        }
        if (restore(strict, strict.redactedText) !== source) {
          failures.push('redact: the strict redaction did not round-trip');
        }

        // Blank input is an answer, not an error, and it never reaches the
        // weights.
        const blank = await masker.redaction('   ');
        console.log(
          `[redact] blank input -> ${blank.items.length} items, text unchanged: ` +
            `${blank.redactedText === '   '}`
        );
        if (blank.items.length !== 0) failures.push('redact: blank input produced an item');
        if (blank.redactedText !== '   ') failures.push('redact: blank input came back changed');

        // One person's contact details in four languages, with no language passed
        // in. Not an accuracy claim -- four sentences are four sentences -- but a
        // model that only worked in English would show it here.
        for (const sample of REDACT_SAMPLES) {
          const one = await masker.redaction(sample.text);
          console.log(
            `[redact]   ${sample.code} ${one.items.length} items: ` +
              (one.items.map((i) => `${i.label}="${i.original}"`).join(', ') || 'none')
          );
          if (restore(one, one.redactedText) !== sample.text) {
            failures.push(`redact: the ${sample.code} redaction did not round-trip`);
          }
        }

        // The argument guards, which never reach native. Upstream clamps an
        // out-of-range confidence and silently drops an unknown label name; both
        // are refusals here.
        for (const bad of [-0.1, 1.1]) {
          try {
            await masker.redaction('a', { minimumConfidence: bad });
            failures.push(`redact: minimumConfidence=${bad} was accepted`);
          } catch (e) {
            if (!(e instanceof DesertAntError) || e.code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`redact: minimumConfidence=${bad} raised ${describe(e)}`);
            }
          }
        }
        for (const bad of [[], ['EMIAL']] as const) {
          try {
            await masker.redaction('a', { labels: bad as never });
            failures.push(`redact: labels=${JSON.stringify(bad)} was accepted`);
          } catch (e) {
            if (!(e instanceof DesertAntError) || e.code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`redact: labels=${JSON.stringify(bad)} raised ${describe(e)}`);
            }
          }
        }
        console.log(
          '[redact] rejected minimumConfidence -0.1/1.1, an empty label list and a misspelled ' +
            'label with ERR_INVALID_ARGUMENT'
        );

        // Display names: iOS has them, Android does not, and the refusal is the
        // interesting half.
        const names = Object.keys(Redact.labelDisplayNames).length;
        console.log(
          `[redact] ${names} display names here (iOS ${Redact.labels.length}, Android 0)`
        );
        if (names === 0) {
          try {
            Redact.displayName('EMAIL');
            failures.push('redact: displayName answered on a platform with no display names');
          } catch (e) {
            const code = e instanceof DesertAntError ? e.code : 'not a DesertAntError';
            console.log(`[redact] displayName -> ${code} (expected off iOS)`);
            if (code !== 'ERR_UNSUPPORTED_PLATFORM') {
              failures.push(`redact: the display-name refusal raised ${code}`);
            }
          }
        } else if (names !== Redact.labels.length) {
          failures.push(`redact: ${names} display names for ${Redact.labels.length} labels`);
        }

        // And the join: the transcript Voz produced, or the sample one when there
        // is no recording. A transcript is exactly the artifact an app forwards
        // to a summarizer or files with a support ticket, which is where this
        // model belongs in the chain.
        const spoken = transcript?.text?.trim();
        const longText = spoken && spoken.length > 0 ? spoken : SAMPLE_TRANSCRIPT.join(' ');
        const t1 = Date.now();
        const masked = await masker.redaction(longText);
        console.log(
          `[redact] ${spoken ? 'Voz transcript' : 'sample transcript'} ` +
            `(${longText.length} chars, ${longText.split(/\s+/).length} words) in ` +
            `${Date.now() - t1}ms -> ${masked.items.length} items` +
            (masked.items.length > 0
              ? `: ${masked.items.map((i) => `${i.label} "${i.original}"`).join(', ')}`
              : ' (nothing personal in it, which is the right answer for this one)')
        );
        if (restore(masked, masked.redactedText) !== longText) {
          failures.push('redact: the transcript redaction did not round-trip');
        }
      }
    } catch (e) {
      console.log(`[redact] self-test FAILED: ${describe(e)}`);
      failures.push(`redact: ${describe(e)}`);
    }

    // --- Shapes. The first model here whose input is neither audio nor text, and
    //     the leg where that shows: everything below is geometry.
    //
    //     Nothing here asserts which class a given stroke produces. The
    //     classifier and its calibrated gates are upstream's, and "a wobbly loop
    //     must come back an ellipse" is an answer key written from this file's
    //     opinion rather than a property of the model -- a legitimate revision
    //     could tighten a gate and turn that into a red self-test on a working
    //     build. What IS asserted is the shape of the answer, the invariants a
    //     fit has to satisfy whatever class it picked, the two invariances
    //     upstream actually claims, and this package's own refusals. What the
    //     model decided is logged, in full, next to them.
    try {
      const sketcher = shapes.current;
      if (!sketcher) {
        console.log('[shapes] self-test skipped — model not prepared');
      } else {
        const results: { name: string; result: ShapeRecognition }[] = [];
        for (const sample of SHAPE_SAMPLES) {
          const points = sample.stroke();
          const t0 = Date.now();
          const result = await sketcher.recognize(points);
          const waited = Date.now() - t0;
          results.push({ name: sample.name, result });
          console.log(
            `[shapes] ${sample.name.padEnd(9)} ${String(points.length).padStart(3)} pts -> ` +
              `${(result.shape?.kind ?? 'rejected').padEnd(9)} ` +
              `waited ${waited}ms native ${(result.processingSec * 1000).toFixed(1)}ms ` +
              (result.shape ? describeShape(result.shape) : '')
          );

          // Bound once, so the union narrows through the closures below. A
          // property access does not stay narrowed inside a callback.
          const fitted = result.shape;
          if (!fitted) continue;

          // The invariants. Every one of these has to hold for any class, so
          // none of them encodes an expected answer.
          const drawn = outline(fitted, 48);
          const finite = drawn.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
          if (!finite) failures.push(`shapes: ${sample.name} produced a non-finite coordinate`);

          const counts: Record<string, number> = { line: 2, rectangle: 4, triangle: 3 };
          const expected = counts[fitted.kind];
          if (expected !== undefined && drawn.length !== expected) {
            failures.push(`shapes: a ${fitted.kind} has ${drawn.length} points, expected ${expected}`);
          }
          if (fitted.kind === 'ellipse' && fitted.semiMajor < fitted.semiMinor) {
            failures.push('shapes: an ellipse reported a semi-minor axis larger than its major');
          }
          if (fitted.kind === 'star') {
            const { center, outerRadius, innerRadius, pointCount } = fitted;
            if (pointCount < 3) failures.push(`shapes: a star with ${pointCount} points`);
            if (drawn.length !== pointCount * 2) {
              failures.push('shapes: a star outline is not twice its point count');
            }
            // The alternation, which is the one thing the ported `outline` has to
            // get right for a star and the thing a bad port would get wrong.
            const alternates = drawn.every((pt, i) => {
              const radius = Math.hypot(pt.x - center.x, pt.y - center.y);
              return Math.abs(radius - (i % 2 === 0 ? outerRadius : innerRadius)) < 1e-6;
            });
            if (!alternates) failures.push('shapes: a star outline does not alternate its radii');
          }
          if (fitted.kind === 'ellipse' && Math.abs(fitted.semiMajor - fitted.semiMinor) < 1e-9) {
            // A snapped circle: every sample has to sit exactly one radius out,
            // which pins the ported ellipse parametrization against arithmetic.
            const { center, semiMajor } = fitted;
            const worst = Math.max(
              ...drawn.map((pt) => Math.abs(Math.hypot(pt.x - center.x, pt.y - center.y) - semiMajor))
            );
            console.log(`[shapes]   snapped to a circle; outline error ${worst.toExponential(1)}`);
            if (worst > 1e-9) failures.push('shapes: a circle outline is not circular');
          }

          // The fit has to be where the stroke was. A generous box -- half the
          // stroke's own size in every direction -- so this catches a fit that
          // landed somewhere else entirely without pretending to measure accuracy.
          const box = bounds(points);
          const padX = Math.max(box.width * 0.5, 8);
          const padY = Math.max(box.height * 0.5, 8);
          const inside = drawn.every(
            (pt) =>
              pt.x >= box.minX - padX && pt.x <= box.maxX + padX &&
              pt.y >= box.minY - padY && pt.y <= box.maxY + padY
          );
          if (!inside) failures.push(`shapes: the ${sample.name} fit landed outside the stroke`);
          if (isClosed(fitted) !== (fitted.kind !== 'line')) {
            failures.push('shapes: isClosed disagrees with the kind');
          }
        }

        const found = results.filter((r) => r.result.shape).length;
        console.log(
          `[shapes] ${found}/${results.length} samples fitted; ` +
            `rejected ${results.filter((r) => !r.result.shape).map((r) => r.name).join(', ') || 'none'}`
        );

        // Determinism. The same stroke twice has to give the same answer -- there
        // is no sampling anywhere in this model, so anything else would be a bug
        // in the session rather than a property of the network.
        const twice = SHAPE_SAMPLES[0]!.stroke();
        const a = await sketcher.recognize(twice);
        const b = await sketcher.recognize(twice);
        const same = JSON.stringify(a.shape) === JSON.stringify(b.shape);
        console.log(`[shapes] same stroke twice -> identical: ${same}`);
        if (!same) failures.push('shapes: the same stroke gave two different answers');

        // The two invariances upstream claims, checked as claims rather than as
        // answer keys: a shape moved and a shape resized is the same shape. Only
        // flagged when both runs found something and they disagree -- a stroke
        // that falls off a gate at one scale is a model decision, not a failure
        // of this app.
        const moved = twice.map((pt) => ({ x: pt.x + 37, y: pt.y - 11 }));
        const scaled = twice.map((pt) => ({ x: pt.x * 1.7, y: pt.y * 1.7 }));
        const movedResult = await sketcher.recognize(moved);
        const scaledResult = await sketcher.recognize(scaled);
        console.log(
          `[shapes] invariance: base=${a.shape?.kind ?? 'none'} ` +
            `translated=${movedResult.shape?.kind ?? 'none'} ` +
            `scaled x1.7=${scaledResult.shape?.kind ?? 'none'}`
        );
        if (a.shape && movedResult.shape && a.shape.kind !== movedResult.shape.kind) {
          failures.push('shapes: translating a stroke changed its class');
        }
        if (a.shape && scaledResult.shape && a.shape.kind !== scaledResult.shape.kind) {
          failures.push('shapes: scaling a stroke changed its class');
        }

        // A stroke that cannot be a stroke. Upstream answers this with "no shape"
        // on both platforms rather than an error, and this package answers it
        // without loading the model at all.
        const empty = await sketcher.recognize([]);
        const single = await sketcher.recognize([{ x: 10, y: 10 }]);
        console.log(
          `[shapes] empty -> ${empty.shape ?? 'null'}; one point -> ${single.shape ?? 'null'}`
        );
        if (empty.shape || single.shape) {
          failures.push('shapes: a stroke of fewer than two points produced a shape');
        }

        // This package's own refusals, both of them things neither upstream SDK
        // checks. A NaN coordinate is dropped rather than caught by upstream's
        // preprocessor, and an out-of-range confidence is silently clamped.
        const refusals: [string, () => Promise<unknown>][] = [
          ['a NaN coordinate', () => sketcher.recognize([{ x: 0, y: 0 }, { x: NaN, y: 4 }])],
          ['an Infinity coordinate', () => sketcher.recognize([{ x: 0, y: 0 }, { x: 1, y: Infinity }])],
          ['minimumConfidence 95', () => sketcher.recognize(twice, { minimumConfidence: 95 })],
          ['minimumConfidence -0.1', () => sketcher.recognize(twice, { minimumConfidence: -0.1 })],
          ['minimumConfidence NaN', () => sketcher.recognize(twice, { minimumConfidence: NaN })],
        ];
        for (const [what, call] of refusals) {
          try {
            await call();
            failures.push(`shapes: ${what} was accepted`);
          } catch (e) {
            const code = e instanceof DesertAntError ? e.code : 'not a DesertAntError';
            if (code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`shapes: ${what} raised ${code}`);
            }
          }
        }
        console.log(
          '[shapes] refused NaN and Infinity coordinates and minimumConfidence 95/-0.1/NaN ' +
            'with ERR_INVALID_ARGUMENT'
        );

        // The gate, exercised from the other end: a floor of 1 is a floor no
        // classifier clears, so everything comes back rejected. Reported rather
        // than asserted at 0 -- what the default gates accept is the model's
        // business -- but a floor of exactly 1 rejecting everything is arithmetic.
        const gated = await sketcher.recognize(twice, { minimumConfidence: 1 });
        console.log(`[shapes] minimumConfidence 1 -> ${gated.shape?.kind ?? 'rejected'}`);

        // Latency, over every sample, which is the number worth quoting. Upstream
        // advertises "under 10 ms per stroke"; this measures both what the model
        // cost and what the caller waited for, because the gap between them is
        // the bridge and this is the model small enough for that to be visible.
        const natives = results.map((r) => r.result.processingSec * 1000);
        console.log(
          `[shapes] native per stroke: min ${Math.min(...natives).toFixed(1)}ms ` +
            `median ${median(natives).toFixed(1)}ms max ${Math.max(...natives).toFixed(1)}ms ` +
            `over ${natives.length} strokes`
        );
      }
    } catch (e) {
      console.log(`[shapes] self-test FAILED: ${describe(e)}`);
      failures.push(`shapes: ${describe(e)}`);
    }

    // --- Uhm. The only model here that is loaded by the time a self-test can run
    //     without anyone tapping anything, so this leg is the one that always has
    //     something to say.
    //
    //     Two inputs, and the difference between them matters. If a real speech
    //     file has been dropped into the app's cache as `uhm-sample.wav` -- which
    //     is how this was verified, with `say` on a Mac and `afconvert` -- the
    //     detector is being asked a real question and the filler count is a real
    //     answer. Otherwise it gets the same synthetic tone the other legs use,
    //     where zero fillers is the correct result and all that is being asserted
    //     is that the model loads, runs, and returns a well-formed result.
    try {
      const detector = uhm.current;
      if (!detector) {
        console.log('[uhm] self-test skipped — model not prepared');
      } else {
        const sample = new File(Paths.cache, 'uhm-sample.wav');
        const real = sample.exists;
        let target = sample.uri;
        if (!real) {
          // Its own file rather than one another leg left behind: a leg that
          // depends on an earlier leg is a leg that reports nothing when that one
          // fails.
          const synthetic = new File(Paths.cache, 'selftest-uhm.wav');
          synthetic.create({ overwrite: true });
          await synthetic.write(encodeWav(noisy, sampleRate));
          target = synthetic.uri;
        }
        console.log(`[uhm] analyzing ${real ? 'real speech' : 'synthetic audio'}: ${target.split('/').pop()}`);

        const t6 = Date.now();
        const found = await detector.analyze({ uri: target });
        console.log(
          `[uhm] analyze(file) ok in ${Date.now() - t6}ms — ${found.fillers.length} fillers, ` +
            `${found.durationSec.toFixed(2)}s rtf=${found.realtimeFactor.toFixed(0)}x ` +
            `decode=${(found.timings.decodeSec * 1000).toFixed(0)}ms ` +
            `inference=${(found.timings.inferenceSec * 1000).toFixed(0)}ms ` +
            `labeling=${(found.timings.labelingSec * 1000).toFixed(0)}ms`
        );
        found.fillers.forEach((f) =>
          console.log(
            `[uhm]   ${(f.type ?? 'filler').padEnd(6)} ${f.start.toFixed(2)}–${f.end.toFixed(2)}s ` +
              `(${(f.durationSec * 1000).toFixed(0)}ms, conf ${f.confidence.toFixed(2)})`
          )
        );

        // The invariants: in time order, inside the audio, above the threshold
        // that was asked for, and typed with something the labeller can return.
        const balanced = Uhm.biasThresholds.balanced;
        const ordered = found.fillers.every(
          (f, i) => f.end > f.start && (i === 0 || f.start >= found.fillers[i - 1]!.start)
        );
        const inside = found.fillers.every((f) => f.start >= 0 && f.end <= found.durationSec + 0.05);
        const gated = found.fillers.every((f) => f.confidence >= balanced);
        const typed = found.fillers.every((f) => f.type === null || Uhm.fillerTypes.includes(f.type));
        console.log(
          `[uhm] ordered=${ordered} insideAudio=${inside} aboveThreshold=${gated} typesKnown=${typed}`
        );

        // Same audio at 48 kHz through the in-memory path, which proves the
        // native resample as well as the buffer copy.
        const t7 = Date.now();
        const fromSamples = await detector.analyzeSamples(noisy, sampleRate);
        console.log(
          `[uhm] analyzeSamples ok in ${Date.now() - t7}ms — ${fromSamples.fillers.length} fillers ` +
            `from ${fromSamples.durationSec.toFixed(2)}s of 48 kHz audio`
        );

        // A looser gate can only ever find at least as much as a stricter one.
        const recall = await detector.analyze({ uri: target, bias: 'recall' });
        const precision = await detector.analyze({ uri: target, bias: 'precision' });
        console.log(
          `[uhm] bias recall=${recall.fillers.length} balanced=${found.fillers.length} ` +
            `precision=${precision.fillers.length} monotonic=` +
            `${recall.fillers.length >= found.fillers.length && found.fillers.length >= precision.fillers.length}`
        );

        // Types off: the same spans, with nothing labelled. The labeller is the
        // Apple-only half, and this is the switch that skips it.
        const untyped = await detector.analyze({ uri: target, includeTypes: false });
        console.log(
          `[uhm] includeTypes=false -> ${untyped.fillers.length} fillers, ` +
            `allUntyped=${untyped.fillers.every((f) => f.type === null)}`
        );

        // Reconciliation, on spans chosen to hit every rule at once. Pure
        // geometry -- no model, no download, so this leg runs even on a build
        // where nothing was ever downloaded.
        //
        // Each word below is labelled with the case it is there to exercise. The
        // one to read twice is `we`: it *does* overlap a filler and comes back
        // untouched, because the overlap is 8% of its length and
        // `minOverlapFraction` is 0.5. That is the gate working, not failing --
        // Voz places a word boundary to about 80 ms and Uhm places a filler edge
        // to 20 ms, so a sliver of overlap is two models disagreeing rather than
        // a word running into an "um".
        const spans = [
          { start: 0.95, end: 1.35 },
          { start: 2.4, end: 2.6 },
        ];
        const words = [
          { text: 'so', start: 0.0, end: 0.4 }, // no overlap -> untouched
          { text: 'think', start: 0.8, end: 1.1 }, // leaks in -> end pulled to 0.95
          { text: 'um', start: 1.0, end: 1.3 }, // inside the filler -> dropped
          { text: 'I', start: 1.1, end: 1.5 }, // leaks out -> start pushed to 1.35
          { text: 'we', start: 1.3, end: 1.9 }, // overlaps 8% -> under the gate
          { text: 'should', start: 2.0, end: 3.0 }, // contains one -> longer half
          { text: 'go', start: 4.0, end: 4.3 }, // no overlap -> untouched
        ];
        const clean = Uhm.reconcileWords(words, spans);
        console.log(
          `[uhm] reconcileWords: ${words.length} words -> ${clean.length} ranges ` +
            `${JSON.stringify(clean.map((w) => [w.text, +w.start.toFixed(2), +w.end.toFixed(2)]))}`
        );
        const at = (text: string) => clean.find((w) => w.text === text);
        const near = (value: number | undefined, expected: number) =>
          value !== undefined && Math.abs(value - expected) < 0.001;
        console.log(
          `[uhm] dropped(um)=${at('um') === undefined} ` +
            `trimmedEnd(think->0.95)=${near(at('think')?.end, 0.95)} ` +
            `pushedStart(I->1.35)=${near(at('I')?.start, 1.35)} ` +
            `splitKeptLongerHalf(should->2.0-2.4)=${near(at('should')?.end, 2.4)} ` +
            `underGateUntouched(we->1.3-1.9)=${near(at('we')?.start, 1.3) && near(at('we')?.end, 1.9)} ` +
            `untouched(so,go)=${near(at('so')?.end, 0.4) && near(at('go')?.start, 4.0)} ` +
            `sortedByStart=${clean.every((w, i) => i === 0 || w.start >= clean[i - 1]!.start)}`
        );

        setDisfluency(found);
        setReconciled({ before: words.length, after: clean.length });
      }
    } catch (e) {
      failures.push(`uhm: ${describe(e)}`);
      console.log(`[uhm] self-test FAILED: ${describe(e)}`);
    }

    // --- Align. The leg with the most preconditions, and none of them are this
    //     app's doing: it needs iOS 26, Align's own 0.7 MB, Apple's on-device
    //     recognizer for the locale, and a file with actual speech in it. The
    //     synthetic tone every other leg falls back to would produce an empty
    //     transcript, which proves nothing about a *timestamp* refiner, so this
    //     leg skips rather than pretending.
    //
    //     What it asserts is what can be asserted from a device: that the words
    //     come back, that the two timings are both present and self-consistent,
    //     that a word the refiner declined to move has identical spans, that the
    //     spans stay ordered and inside the audio, and that a locale Align does
    //     not refine is refused rather than silently passed through. It does NOT
    //     assert how far anything moved -- upstream's 106.4 ms and 20.2 ms are
    //     upstream's, measured on LibriSpeech against reference boundaries this
    //     app does not have.
    try {
      const refiner = align.current;
      const sample = new File(Paths.cache, ALIGN_SAMPLE);
      if (!refiner) {
        console.log('[align] self-test skipped — model not prepared');
      } else {
        // Everything down to the refusals runs without Apple's recognizer,
        // because none of it reaches one: the language map comes out of a file
        // this SDK downloaded, and every refusal below is raised before a native
        // call is made. That split is what keeps this leg useful on a simulator,
        // where the recognizer assets cannot be installed at all.
        console.log(
          `[align] languages=${refiner.supportedLanguages().join('/')} ` +
            `downloaded=${refiner.isDownloaded()} dir=${refiner.resolvedDirectory()}`
        );
        const known = refiner.supportedLanguages();
        if (!known.includes('en')) {
          failures.push(`align: the downloaded config lists no 'en' (${known.join('/')})`);
        }

        for (const [what, options] of [
          ['an empty locale', { uri: sample.uri, locale: '' }],
          ['a language name for a locale', { uri: sample.uri, locale: 'english' }],
          ['a locale Align does not refine', { uri: sample.uri, locale: 'cy-GB' }],
          ['a zero buffer window', { uri: sample.uri, locale: ALIGN_LOCALE, maxBufferedSeconds: 0 }],
          ['a NaN buffer window', { uri: sample.uri, locale: ALIGN_LOCALE, maxBufferedSeconds: NaN }],
        ] as const) {
          try {
            await refiner.transcribe(options as never);
            failures.push(`align: ${what} was accepted`);
          } catch (e) {
            const code = e instanceof DesertAntError ? e.code : 'unknown';
            if (code !== 'ERR_INVALID_ARGUMENT') {
              failures.push(`align: ${what} raised ${code}`);
            }
          }
        }
        console.log(
          "[align] refused an empty locale, 'english', an unrefined locale, and zero/NaN buffer windows"
        );

        // Everything past here needs Apple's recognizer. A simulator does not
        // have one and cannot install one -- `AssetInventory.status` answers
        // `unsupported` -- so `transcribe` comes back ERR_MODEL_UNAVAILABLE.
        // That is a skip rather than a failure, and asserting the *code* is
        // itself worth something: it proves the native path was reached and the
        // missing-recognizer case was classified rather than surfacing as an
        // inference error.
        if (!sample.exists) {
          console.log(
            `[align] transcription skipped — no ${ALIGN_SAMPLE} in the cache. A timestamp ` +
              'refiner needs speech; the synthetic tone the other legs use has no words to time.'
          );
        } else if (alignLocaleState !== 'ready') {
          try {
            await refiner.transcribe({ uri: sample.uri, locale: ALIGN_LOCALE });
            failures.push('align: transcribe succeeded without a prepared locale, unexpectedly');
          } catch (e) {
            const code = e instanceof DesertAntError ? e.code : 'unknown';
            console.log(
              `[align] transcription skipped — Apple's ${ALIGN_LOCALE} recognizer is not ` +
                `installed (${code}): ${describe(e)}`
            );
            if (code !== 'ERR_MODEL_UNAVAILABLE') {
              failures.push(`align: a missing recognizer raised ${code}, not ERR_MODEL_UNAVAILABLE`);
            }
          }
        } else {

        const t8 = Date.now();
        const result = await refiner.transcribe({ uri: sample.uri, locale: ALIGN_LOCALE });
        const waited = Date.now() - t8;
        const shift = timestampShift(result.words);
        console.log(
          `[align] transcribe ok in ${waited}ms — ${result.words.length} words, ` +
            `${result.refinedWordCount} refined, ${result.durationSec.toFixed(2)}s ` +
            `rtf=${result.realtimeFactor.toFixed(2)}x ` +
            `setup=${(result.setupSec * 1000).toFixed(0)}ms ` +
            `refine=${(result.refineSec * 1000).toFixed(0)}ms ` +
            `locale=${result.locale} refinedLanguage=${result.languageRefined} ` +
            `revision=${result.modelRevision}`
        );
        console.log(`[align] text="${result.text}"`);
        console.log(
          `[align] shift: mean ${(shift.meanAbsSec * 1000).toFixed(1)}ms ` +
            `max ${(shift.maxAbsSec * 1000).toFixed(1)}ms ` +
            `start ${(shift.meanStartSec * 1000).toFixed(1)}ms ` +
            `end ${(shift.meanEndSec * 1000).toFixed(1)}ms ` +
            `(${shift.refinedCount}/${shift.wordCount} moved)`
        );
        result.words.slice(0, 12).forEach((w) =>
          console.log(
            `[align]   ${w.text.padEnd(14)} ` +
              `${w.originalStart.toFixed(3)}–${w.originalEnd.toFixed(3)} -> ` +
              `${w.start.toFixed(3)}–${w.end.toFixed(3)} ` +
              (w.refined
                ? `(${((w.start - w.originalStart) * 1000).toFixed(0)}ms / ` +
                  `${((w.end - w.originalEnd) * 1000).toFixed(0)}ms)`
                : '(kept)')
          )
        );

        if (result.words.length === 0) {
          failures.push('align: the recognizer produced no words from the speech sample');
        }
        if (!result.languageRefined) {
          failures.push(`align: ${ALIGN_LOCALE} came back unrefined`);
        }
        // Ordered, non-inverted, and inside the audio -- on both timelines, since
        // a correction that broke one and not the other would be invisible in a
        // check of either alone.
        const ordered = result.words.every(
          (w, i) =>
            w.end >= w.start &&
            w.originalEnd >= w.originalStart &&
            (i === 0 || w.start >= result.words[i - 1]!.start)
        );
        const inside = result.words.every(
          (w) => w.start >= 0 && w.end <= result.durationSec + 0.5
        );
        // The documented contract of `refined: false`: upstream keeps Apple's
        // span verbatim, so the two timelines must be identical for those words.
        const keptIsIdentical = result.words.every(
          (w) => w.refined || (w.start === w.originalStart && w.end === w.originalEnd)
        );
        // And the converse, which is the one that would catch a silent
        // passthrough being reported as a refinement.
        const refinedActuallyMoved = result.words.every(
          (w) => !w.refined || w.start !== w.originalStart || w.end !== w.originalEnd
        );
        console.log(
          `[align] ordered=${ordered} insideAudio=${inside} ` +
            `keptIsIdentical=${keptIsIdentical} refinedActuallyMoved=${refinedActuallyMoved}`
        );
        if (!ordered) failures.push('align: word spans are not monotonic');
        if (!inside) failures.push('align: a word span falls outside the audio');
        if (!keptIsIdentical) {
          failures.push('align: a word marked unrefined has a different span than the original');
        }

        // `allowUnrefined` is the escape hatch, and what it must produce is a
        // transcript that is honest about being unrefined rather than one that
        // looks the same as a refined one.
        //
        // Welsh is the right probe: Apple may or may not have a recognizer for
        // it, and Align certainly has no language id for it. If the assets are
        // missing this throws ERR_MODEL_UNAVAILABLE, which is a different and
        // equally correct answer -- so both are accepted and the one that
        // happened is logged.
        try {
          const unrefined = await refiner.transcribe({
            uri: sample.uri,
            locale: 'cy-GB',
            allowUnrefined: true,
          });
          console.log(
            `[align] allowUnrefined cy-GB -> languageRefined=${unrefined.languageRefined} ` +
              `refinedWordCount=${unrefined.refinedWordCount} words=${unrefined.words.length}`
          );
          if (unrefined.languageRefined || unrefined.refinedWordCount > 0) {
            failures.push('align: an unrefined language reported refinements');
          }
        } catch (e) {
          const code = e instanceof DesertAntError ? e.code : 'unknown';
          console.log(`[align] allowUnrefined cy-GB -> ${code} (no Apple recognizer for it)`);
          if (code !== 'ERR_MODEL_UNAVAILABLE') {
            failures.push(`align: allowUnrefined raised ${code}`);
          }
        }

        // The three-model chain, on one file. Align times the words, Uhm finds
        // the fillers in the same audio, and `reconcileWords` trims the one
        // around the other -- which is the only place in this app where tens of
        // milliseconds change an output rather than a number on screen.
        const detector = uhm.current;
        if (!detector) {
          console.log('[align] + uhm skipped — Uhm not prepared');
        } else if (result.words.length === 0) {
          console.log('[align] + uhm skipped — no words to reconcile');
        } else {
          const { fillers } = await detector.analyze({ uri: sample.uri });
          const clean = Uhm.reconcileWords(result.words, fillers);
          const fromApple = Uhm.reconcileWords(
            result.words.map((w) => ({
              text: w.text,
              start: w.originalStart,
              end: w.originalEnd,
            })),
            fillers
          );
          console.log(
            `[align] + uhm: ${fillers.length} fillers over the same audio; ` +
              `${result.words.length} words -> ${clean.length} reconciled ` +
              `(Apple's own timings -> ${fromApple.length})`
          );
          // Not asserted as an improvement -- there is no ground truth here to
          // say which count is better. What IS asserted is that the join runs on
          // Align's output at all, which is the integration this leg is for.
          const reconciledOrdered = clean.every(
            (w, i) => w.end >= w.start && (i === 0 || w.start >= clean[i - 1]!.start)
          );
          if (!reconciledOrdered) {
            failures.push('align: reconcileWords returned spans out of order');
          }
        }

        setAligned(result);
        setAlignMs(waited);
        setAlignSource(ALIGN_SAMPLE);
        }
      }
    } catch (e) {
      failures.push(`align: ${describe(e)}`);
      console.log(`[align] self-test FAILED: ${describe(e)}`);
    }

    // --- Clear: file in, file out (the primary API), then the in-memory one.
    try {
      const model = clear.current ?? Clear.create();
      const input = new File(Paths.cache, 'selftest.wav');
      input.create({ overwrite: true });
      await input.write(encodeWav(noisy, sampleRate));

      const t0 = Date.now();
      const fileResult = await model.enhance({ uri: input.uri });
      const output = new File(fileResult.uri);
      console.log(
        `[clear] enhance(file) ok in ${Date.now() - t0}ms — ` +
          `${fileResult.uri.split('/').pop()} exists=${output.exists} bytes=${output.size} ` +
          `${fileResult.durationSec.toFixed(2)}s rtf=${fileResult.realtimeFactor.toFixed(1)}x ` +
          `variant=${fileResult.modelVariant} revision=${fileResult.modelRevision}`
      );
      enhancedForVoz = fileResult.uri;
      setMetrics(fileResult);
      setOriginalUri(input.uri);
      setEnhancedUri(fileResult.uri);

      const t1 = Date.now();
      const bufferResult = await model.enhanceSamples(noisy, sampleRate);
      console.log(
        `[clear] enhanceSamples ok in ${Date.now() - t1}ms — ` +
          `${bufferResult.channels.length}ch x ${bufferResult.samples.length} @ ` +
          `${bufferResult.sampleRate}Hz peak=${peakOf(bufferResult.samples).toFixed(4)}`
      );
      if (!clear.current) model.release();
    } catch (e) {
      failures.push(`clear: ${describe(e)}`);
      console.log(`[clear] self-test FAILED: ${describe(e)}`);
    }

    // --- Voz. A plumbing check, not an accuracy check: a 200 Hz tone under hiss
    //     is not speech, so an empty transcript is the expected result. What is
    //     asserted is that the model loads, runs, and returns a well-formed
    //     result with timings in range.
    try {
      const speech = voz.current;
      if (!speech) {
        console.log('[voz] self-test skipped — model not prepared');
      } else {
        const t2 = Date.now();
        const fromFile = await speech.transcribe({ uri: enhancedForVoz ?? '' });
        console.log(
          `[voz] transcribe(file) ok in ${Date.now() - t2}ms — ${fromFile.words.length} words ` +
            `${fromFile.durationSec.toFixed(2)}s rtf=${fromFile.realtimeFactor.toFixed(1)}x ` +
            `revision=${fromFile.modelRevision} text="${fromFile.text}"`
        );
        // Voz runs at 16 kHz; passing 48 kHz proves the native resample path.
        const t3 = Date.now();
        const fromSamples = await speech.transcribeSamples(noisy, sampleRate);
        console.log(
          `[voz] transcribeSamples ok in ${Date.now() - t3}ms — ` +
            `${fromSamples.words.length} words text="${fromSamples.text}"`
        );
        const ordered = fromFile.words.every(
          (w, i) => w.end >= w.start && (i === 0 || w.start >= fromFile.words[i - 1]!.start)
        );
        console.log(`[voz] word timings monotonic and non-negative: ${ordered}`);
        setTranscript(fromFile);
      }
    } catch (e) {
      failures.push(`voz: ${describe(e)}`);
      console.log(`[voz] self-test FAILED: ${describe(e)}`);
    }

    // --- Clips. Unlike the other two this needs no audio at all: its input is
    //     text plus times, so a synthetic transcript exercises the real model on
    //     a real workload without a microphone or a recording.
    try {
      const cutter = clips.current;
      if (!cutter) {
        console.log('[clips] self-test skipped — model not prepared');
      } else {
        // `toSentences` first, on synthetic words, so the splitter is covered
        // even though the lines below are already sentence-shaped.
        const words = SAMPLE_TRANSCRIPT.flatMap((line, index) =>
          line.split(' ').map((token, position, all) => ({
            text: position === 0 ? token : ` ${token}`,
            start: index * 4 + (position / all.length) * 3.5,
            end: index * 4 + ((position + 1) / all.length) * 3.5,
          }))
        );
        const built = Clips.toSentences(words);
        console.log(`[clips] toSentences: ${words.length} words -> ${built.length} sentences`);

        const t4 = Date.now();
        const found = await cutter.find({ sentences: built });
        console.log(
          `[clips] find ok in ${Date.now() - t4}ms — ${found.length} clips ` +
            `(default limit ${Clips.defaultLimit}, revision ${Clips.modelRevision})`
        );
        found.forEach((c) =>
          console.log(
            `[clips]   #${c.rank} p=${c.percentile.toFixed(2)} s=${c.score.toFixed(2)} ` +
              `${c.durationSec.toFixed(1)}s ids=${JSON.stringify(c.sentenceIds)} ` +
              `ranges=${JSON.stringify(c.ranges.map((r) => [+r.start.toFixed(2), +r.end.toFixed(2)]))} ` +
              `"${c.text.slice(0, 60)}"`
          )
        );

        // The invariants worth asserting: ranked best-first, non-overlapping, and
        // every clip resolving to a playable span inside the recording.
        const ranked = found.every((c, i) => i === 0 || c.score <= found[i - 1]!.score);
        const seen = new Set<number>();
        const disjoint = found.every((c) =>
          c.sentenceIds.every((id) => (seen.has(id) ? false : (seen.add(id), true)))
        );
        const playable = found.every(
          (c) => c.ranges.length > 0 && c.ranges.every((r) => r.end > r.start && r.start >= 0)
        );
        const bounded = found.every((c) => c.percentile >= 0 && c.percentile <= 1);
        console.log(
          `[clips] ranked=${ranked} nonOverlapping=${disjoint} playableRanges=${playable} ` +
            `percentilesInRange=${bounded}`
        );

        // A short transcript is upstream's documented empty case.
        const tooShort = await cutter.find({ sentences: built.slice(0, 2) });
        console.log(`[clips] two sentences -> ${tooShort.length} clips (expected 0)`);

        // A smaller limit sizes the work as well as the answer.
        const t5 = Date.now();
        const three = await cutter.find({ sentences: built, limit: 3 });
        console.log(`[clips] limit 3 -> ${three.length} clips in ${Date.now() - t5}ms`);

        setHighlights(found);
      }
    } catch (e) {
      failures.push(`clips: ${describe(e)}`);
      console.log(`[clips] self-test FAILED: ${describe(e)}`);
    }

    console.log(
      failures.length === 0
        ? '[selftest] all prepared models passed'
        : `[selftest] ${failures.length} failed: ${failures.join(' | ')}`
    );
    if (failures.length > 0) setError(failures.join('\n'));
    setBusy(null);
    setProgress(null);
    // `transcript` and `alignLocaleState` are the two pieces of state this
    // closure reads rather than reaching for through a ref. The Redact leg masks
    // the transcript Voz produced when there is one; the Align leg has to know
    // whether Apple's per-locale speech model was installed, which is not
    // something any model object can be asked. Every other leg works from a ref,
    // a constant or a file it writes itself.
  }, [transcript, alignLocaleState]);

  const audioToTranscribe = enhancedUri ?? originalUri;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Desert Ant</Text>
      <Text style={styles.subtitle}>
        Clear cleans it, Ear names the language, Voz reads it, Clips cuts it, Uhm finds
        the ums — and Tongue names the language again, from the words rather than the
        sound, Gist says what those words are about, and Redact takes the people out
        of them before they go anywhere. Then one that reads neither: Shapes turns a
        stroke you draw into a shape.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button
        label={recorderState.isRecording ? 'Stop and process' : 'Record'}
        onPress={recorderState.isRecording ? stopAndProcess : record}
        disabled={!ready || busy !== null}
        tone={recorderState.isRecording ? 'danger' : 'primary'}
      />

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.busyText}>
            {busy}
            {progress ? ` — ${progress.phase}` : ''}
            {/* Clear on Android reports phase boundaries only, so a percentage
                there would be a fiction. Voz is Apple-only and always real.
                See ProgressEvent.fraction. */}
            {progress && Platform.OS === 'ios' ? ` ${Math.round(progress.fraction * 100)}%` : ''}
          </Text>
        </View>
      ) : null}

      <Button label="Run self-test" onPress={selfTest} disabled={busy !== null} tone="ghost" />

      {originalUri ? (
        <Button label="Play original" onPress={() => void replay(originalPlayer)} tone="ghost" />
      ) : null}
      {enhancedUri ? (
        <Button label="Play enhanced" onPress={() => void replay(enhancedPlayer)} tone="ghost" />
      ) : null}

      {metrics ? (
        <View style={styles.metrics}>
          <Text style={styles.sectionTitle}>Clear</Text>
          <Row label="Realtime factor" value={`${metrics.realtimeFactor.toFixed(0)}x`} />
          <Row label="Duration" value={`${metrics.durationSec.toFixed(1)} s`} />
          <Row label="Processing" value={`${(metrics.processingSec * 1000).toFixed(0)} ms`} />
          <Row label="Input LUFS" value={format(metrics.measuredLUFS)} />
          <Row label="True peak" value={format(metrics.measuredTruePeakDBFS, 'dBFS')} />
          <Row label="Runtime" value={metrics.modelRuntime ?? '—'} />
        </View>
      ) : null}

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Voz</Text>

        {vozState === 'unsupported' ? (
          <Text style={styles.note}>
            Not available on this platform. Voz is Core ML only — desert-ant-core ships no
            Android build of it.
          </Text>
        ) : null}

        {vozState === 'absent' ? (
          <>
            <Text style={styles.note}>
              The weights are about 490 MB and are not on this device yet. Downloading them is
              a deliberate step, not something the SDK does behind you.
            </Text>
            <Button
              label="Download and prepare Voz (~490 MB)"
              onPress={() => void prepareVoz()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {vozState === 'loading' && busy === null ? (
          <Text style={styles.note}>Preparing…</Text>
        ) : null}

        {vozState === 'ready' && audioToTranscribe ? (
          <Button
            label={enhancedUri ? 'Transcribe the enhanced audio' : 'Transcribe the recording'}
            onPress={() => void runTranscribe(audioToTranscribe)}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}

        {vozState === 'ready' && !audioToTranscribe ? (
          <Text style={styles.note}>Ready. Record something to transcribe it.</Text>
        ) : null}

        {transcript ? (
          <>
            <Row label="Realtime factor" value={`${transcript.realtimeFactor.toFixed(0)}x`} />
            <Row label="Processing" value={`${(transcript.processingSec * 1000).toFixed(0)} ms`} />
            <Row label="Words" value={`${transcript.words.length}`} />
            <Row label="Revision" value={transcript.modelRevision ?? '—'} />
            <Text style={styles.transcript}>
              {transcript.text.length > 0 ? transcript.text : '(nothing recognized)'}
            </Text>
            {/* The timings are the reason to use this model rather than any
                dictation API, so show them rather than only the text. */}
            <View style={styles.words}>
              {transcript.words.slice(0, 60).map((word, index) => (
                <View key={`${index}-${word.start}`} style={styles.word}>
                  <Text style={styles.wordText}>{word.text}</Text>
                  <Text style={styles.wordTime}>{word.start.toFixed(2)}s</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Clips</Text>

        {clipsState === 'unsupported' ? (
          <Text style={styles.note}>
            {Clips.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {clipsState === 'absent' ? (
          <>
            <Text style={styles.note}>
              About 288 MB, and not on this device yet. Clips needs no audio — it
              works from the transcript — so the self-test can exercise it once the
              weights are here.
            </Text>
            <Button
              label="Download and prepare Clips (~288 MB)"
              onPress={() => void prepareClips()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {clipsState === 'loading' && busy === null ? (
          <Text style={styles.note}>Preparing…</Text>
        ) : null}

        {clipsState === 'ready' && transcript ? (
          <Button
            label="Find the highlights"
            onPress={() => void runFindClips(transcript)}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}

        {clipsState === 'ready' && !transcript ? (
          <Text style={styles.note}>Ready. Transcribe something to rank it.</Text>
        ) : null}

        {highlights ? (
          highlights.length === 0 ? (
            <Text style={styles.note}>
              No clips — a transcript under three sentences has nothing to choose
              between.
            </Text>
          ) : (
            <>
              <Row label="Clips found" value={`${highlights.length}`} />
              {highlights.map((clip) => (
                <View key={clip.rank} style={styles.clip}>
                  <View style={styles.clipHeader}>
                    <Text style={styles.clipRank}>#{clip.rank + 1}</Text>
                    <Text style={styles.clipMeta}>
                      {`p${clip.percentile.toFixed(2)} · ${clip.durationSec.toFixed(1)}s · ` +
                        clip.ranges
                          .map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}`)
                          .join(', ')}
                    </Text>
                  </View>
                  <Text style={styles.clipText}>{clip.text}</Text>
                </View>
              ))}
            </>
          )
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Uhm</Text>

        {uhmState === 'unsupported' ? (
          <Text style={styles.note}>
            {Uhm.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {uhmState === 'absent' ? (
          <>
            <Text style={styles.note}>
              Preparing Uhm failed. It is about 45 MB — small enough that this app
              loads it on mount rather than behind a button — so this is worth
              retrying.
            </Text>
            <Button
              label="Retry (~45 MB)"
              onPress={() => void prepareUhm()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {uhmState === 'loading' ? (
          <Text style={styles.note}>
            Preparing — downloading about 45 MB if it is not already here, then
            building the Core ML session.
          </Text>
        ) : null}

        {uhmState === 'ready' && audioToTranscribe ? (
          <Button
            label="Find the fillers"
            onPress={() => void runDetectFillers(audioToTranscribe, transcript)}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}

        {uhmState === 'ready' && !audioToTranscribe ? (
          <Text style={styles.note}>
            Ready. Record something — Uhm needs no transcript, only the audio.
          </Text>
        ) : null}

        {disfluency ? (
          <>
            <Row label="Fillers" value={`${disfluency.fillers.length}`} />
            <Row label="Realtime factor" value={`${disfluency.realtimeFactor.toFixed(0)}x`} />
            <Row
              label="Inference"
              value={`${(disfluency.timings.inferenceSec * 1000).toFixed(0)} ms`}
            />
            <Row
              label="Labelling"
              value={`${(disfluency.timings.labelingSec * 1000).toFixed(0)} ms`}
            />
            {reconciled ? (
              <Row
                label="Words after reconcile"
                value={`${reconciled.after} of ${reconciled.before}`}
              />
            ) : null}
            {disfluency.fillers.length === 0 ? (
              <Text style={styles.note}>
                Nothing found. On synthetic audio that is the right answer — a tone
                under hiss contains no speech to be disfluent in.
              </Text>
            ) : (
              <View style={styles.words}>
                {disfluency.fillers.slice(0, 60).map((filler, index) => (
                  <View key={`${index}-${filler.start}`} style={styles.filler}>
                    <Text style={styles.wordText}>{filler.type ?? 'filler'}</Text>
                    <Text style={styles.wordTime}>
                      {filler.start.toFixed(2)}s · {(filler.durationSec * 1000).toFixed(0)}ms
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Ear</Text>

        {earState === 'unsupported' ? (
          <Text style={styles.note}>
            {Ear.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {earState === 'absent' ? (
          <>
            <Text style={styles.note}>
              Preparing Ear failed. It is about 9 MB, so this is worth retrying.
            </Text>
            <Button
              label="Retry (~9 MB)"
              onPress={() => void prepareEar()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {earState === 'loading' ? (
          <Text style={styles.note}>Preparing — about 9 MB if it is not already here.</Text>
        ) : null}

        {earState === 'ready' && !heard ? (
          <Text style={styles.note}>
            Ready. Record something and Ear will name the language before Voz reads
            it — which is the order they are meant to run in, because Voz cannot
            tell you when it is out of its depth.
          </Text>
        ) : null}

        {heard ? (
          <>
            <Row label="Language" value={heard.language ?? 'none'} />
            <Row label="Confidence" value={heard.confidence.toFixed(2)} />
            <Row label="Reliable" value={heard.isReliable ? 'yes' : 'no'} />
            <Row label="Windows heard" value={`${heard.windows}`} />
            <Row
              label="Identification"
              value={`${(heard.processingSec * 1000).toFixed(0)} ms${
                earMs === null ? '' : ` (${earMs} ms with the bridge)`
              }`}
            />

            {/* The two reasons an answer is unreliable are different problems,
                so they get different sentences. More audio fixes one of them and
                nothing fixes the other. */}
            {!heard.isReliable && heard.language ? (
              <Text style={styles.note}>
                {Ear.confusableLanguages.includes(heard.language)
                  ? `${heard.language} is one of Norwegian, Swedish and Danish, which the ` +
                    'detector confuses with each other confidently rather than uncertainly. ' +
                    'The confidence above does not reveal the problem, which is exactly why ' +
                    'this flag exists and a threshold would not do.'
                  : `The top two candidates are within ${Ear.reliableMargin} of each other, so ` +
                    'the answer is a choice between them rather than a reading. More audio ' +
                    'usually helps here.'}
              </Text>
            ) : null}

            {/* The join this model exists for. Voz will happily transcribe audio
                in a language it was never trained on and return fluent nonsense,
                so the comparison is the useful output, not the code. */}
            {heard.language && !Voz.supportedLanguages.includes(heard.language) ? (
              <Text style={styles.note}>
                Voz does not cover {heard.language}. It would transcribe this anyway and the
                result would be confident nonsense — Voz does not detect what it is
                hearing, which is what Ear is here to do.
              </Text>
            ) : null}

            {heard.candidates.length > 0 ? (
              <View style={styles.words}>
                {heard.candidates.slice(0, 6).map((candidate, index) => (
                  <View key={`${index}-${candidate.language}`} style={styles.filler}>
                    <Text style={styles.wordText}>{candidate.language}</Text>
                    <Text style={styles.wordTime}>{candidate.probability.toFixed(3)}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.note}>
                Nothing to listen to. On synthetic audio that is the right answer — a
                tone under hiss is not speech in any language.
              </Text>
            )}
          </>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Tongue</Text>

        {tongueState === 'unsupported' ? (
          <Text style={styles.note}>
            {Tongue.unsupportedReason ?? 'Not available in this build.'}
          </Text>
        ) : null}

        {tongueState === 'absent' ? (
          <>
            <Text style={styles.note}>
              Reading the bundled model failed. Nothing was downloaded — the 2 MB is
              inside the app binary — so this is a build problem rather than a network
              one.
            </Text>
            <Button
              label="Retry"
              onPress={() => void prepareTongue()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {tongueState === 'loading' ? (
          <Text style={styles.note}>Reading the bundled 2 MB.</Text>
        ) : null}

        {tongueState === 'ready' ? (
          <>
            <Text style={styles.note}>
              Ear names the language of a recording; Tongue names it from the words.
              Type three and it answers — synchronously, with no debounce, because a
              detection costs less than the keystroke that triggered it.
            </Text>
            <TextInput
              value={typed}
              onChangeText={runRead}
              placeholder="kann ich das haben"
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.input}
            />
            {/* Seven scripts, so the router's two shortcuts are something a tester
                can tap: Hangul and Greek are decided by script alone at
                probability 1, Cyrillic narrows to eight languages before the
                model decodes, and "la casa" is a genuine tie between Italian and
                Spanish that the model is right to refuse to break. */}
            <View style={styles.phrases}>
              {TONGUE_PHRASES.map((sample) => (
                <Pressable
                  key={sample}
                  onPress={() => runRead(sample)}
                  style={({ pressed }) => [styles.phrase, pressed && styles.buttonPressed]}>
                  <Text style={styles.phraseText}>{sample}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {read ? (
          <>
            <Row label="Language" value={read.language ?? 'none'} />
            <Row label="Confidence" value={read.confidence.toFixed(3)} />
            <Row label="Reliability" value={read.reliability} />
            <Row
              label="Route"
              value={`${read.route.verdict}${read.route.script ? ` · ${read.route.script}` : ''}`}
            />
            <Row
              label="Detection"
              value={`${(read.processingSec * 1e6).toFixed(0)} µs${
                readUs === null ? '' : ` (${readUs} µs with the bridge)`
              }`}
            />

            {/* The two things a caller should not read as the same problem. One is
                about how much evidence there was; the other is about two
                languages being equally good answers for it. */}
            {read.reliability === 'tentative' ? (
              <Text style={styles.note}>
                Tentative — under 12 characters, or the winner leads by less than 0.20.
                Treat it as unknown rather than as an answer with an asterisk. One or two
                words is often genuinely undecidable, whatever the probability says.
              </Text>
            ) : null}

            {read.isTooCloseToCall ? (
              <Text style={styles.note}>
                The top two are within {Tongue.tieMargin} of each other, so this is a tie
                rather than a reading — show both. “la casa” is equally Italian and
                Spanish, and saying so is more useful than picking.
              </Text>
            ) : null}

            {read.route.verdict === 'decisive' ? (
              <Text style={styles.note}>
                Settled by script alone: only {read.route.candidates.join(', ')} uses{' '}
                {read.route.script}, so the model was never asked. That is why the
                probability is 1 and the answer is confident however short the text is —
                25 of the 84 languages are reachable this way.
              </Text>
            ) : null}

            {read.route.verdict === 'narrowing' ? (
              <Text style={styles.note}>
                {read.route.script} narrowed the field to{' '}
                {read.route.candidates.join(', ')} before the model decoded — so the
                probabilities above are over those {read.route.candidates.length}, not over
                all 59.
              </Text>
            ) : null}

            <Text style={styles.note}>
              The model saw: “{read.normalized}”
            </Text>

            {read.candidates.length > 0 ? (
              <View style={styles.words}>
                {read.candidates.map((candidate, index) => (
                  <View key={`${index}-${candidate.language}`} style={styles.filler}>
                    <Text style={styles.wordText}>{candidate.language}</Text>
                    <Text style={styles.wordTime}>{candidate.probability.toFixed(3)}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.note}>
                Nothing survived normalization, so there is no answer — which is a
                different thing from a low-confidence one.
              </Text>
            )}
          </>
        ) : null}

        {/* Two models, one recording, different evidence. Reported rather than
            enforced: where they disagree, the disagreement is the output. */}
        {agreement ? (
          <>
            <Text style={styles.sectionTitle}>Ear vs Tongue</Text>
            <Row
              label="Ear, from the audio"
              value={`${agreement.ear ?? 'none'}${agreement.earReliable ? '' : ' (unreliable)'}`}
            />
            <Row
              label="Tongue, from the words"
              value={`${agreement.tongue ?? 'none'} (${agreement.tongueReliability})`}
            />
            <Text style={styles.note}>
              {agreement.ear === agreement.tongue
                ? `Both read it as ${agreement.tongue}, from ${agreement.words} transcribed words ` +
                  'and from the waveform respectively. Two models that share no input agreeing is ' +
                  'worth more than either alone.'
                : 'They disagree. Ear hears phonetics and Tongue reads orthography, so a ' +
                  'transcriber out of its depth produces text that looks like a language it is ' +
                  'not — which is exactly the case this comparison exists to surface.'}
            </Text>
          </>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Emo</Text>

        {emoState === 'unsupported' ? (
          <Text style={styles.note}>
            {Emo.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {emoState === 'absent' ? (
          <>
            <Text style={styles.note}>
              Preparing Emo failed. It is about 5 MB — the smallest model here —
              so this is worth retrying.
            </Text>
            <Button
              label="Retry (~5 MB)"
              onPress={() => void prepareEmo()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {emoState === 'loading' ? (
          <Text style={styles.note}>Preparing — about 5 MB if it is not already here.</Text>
        ) : null}

        {emoState === 'ready' ? (
          <>
            <Text style={styles.note}>
              Type a task or a message. Emo reads text rather than audio, so this
              is the one model here that needs no recording — and it answers in
              about two milliseconds, which is what makes a suggestion per
              keystroke reasonable.
            </Text>
            <TextInput
              value={phrase}
              onChangeText={setPhrase}
              placeholder="Pay my bills"
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.input}
            />
            {/* Three languages and one intent, so the multilingual claim is
                something a tester can tap rather than take on trust: the same
                phrase in Spanish and Japanese should land on the same emoji. */}
            <View style={styles.phrases}>
              {SAMPLE_PHRASES.map((sample) => (
                <Pressable
                  key={sample}
                  onPress={() => setPhrase(sample)}
                  style={({ pressed }) => [styles.phrase, pressed && styles.buttonPressed]}>
                  <Text style={styles.phraseText}>{sample}</Text>
                </Pressable>
              ))}
            </View>
            {/* Read off the linked binary rather than hardcoded, so this row is
                whatever the native enum actually accepts. */}
            <View style={styles.phrases}>
              {Emo.skinTones.map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setTone(option)}
                  style={({ pressed }) => [
                    styles.phrase,
                    option === tone && styles.phraseSelected,
                    pressed && styles.buttonPressed,
                  ]}>
                  <Text style={[styles.phraseText, option === tone && styles.phraseTextSelected]}>
                    {option}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {emoji ? (
          <>
            <Row label="Suggestions" value={`${emoji.length}`} />
            <Row label="Latency" value={emoMs === null ? '—' : `${emoMs} ms`} />
            {emoji.length === 0 ? (
              <Text style={styles.note}>Nothing suggested.</Text>
            ) : (
              <View style={styles.words}>
                {emoji.map((suggestion, index) => (
                  <View key={`${index}-${suggestion.emoji}`} style={styles.emoji}>
                    <Text style={styles.emojiGlyph}>{suggestion.emoji}</Text>
                    <Text style={styles.wordTime}>{suggestion.confidence.toFixed(2)}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Gist</Text>

        {gistState === 'unsupported' ? (
          <Text style={styles.note}>
            {Gist.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {gistState === 'absent' ? (
          <>
            <Text style={styles.note}>
              Type a headline and Gist names what it is about, from a fixed
              36-topic taxonomy, in 101 languages with no language setting to pass
              in. The multilingual build is about 74 MB — the download is the
              expensive part of this model, not the inference — so it waits for a
              tap rather than arriving on mount.
            </Text>
            {/* Read off the native binary, not off Platform.OS: two builds on
                iOS, one on Android, because the Kotlin constructor takes no
                variant. Locked once a model is loaded — a variant selects which
                files get downloaded, so switching means another download. */}
            {Gist.variants.length > 1 ? (
              <View style={styles.phrases}>
                {Gist.variants.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => setGistVariant(option)}
                    style={({ pressed }) => [
                      styles.phrase,
                      option === gistVariant && styles.phraseSelected,
                      pressed && styles.buttonPressed,
                    ]}>
                    <Text
                      style={[
                        styles.phraseText,
                        option === gistVariant && styles.phraseTextSelected,
                      ]}>
                      {option === 'english' ? 'english (~15 MB)' : 'multilingual (~74 MB)'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Button
              label={gistVariant === 'english' ? 'Prepare Gist (~15 MB)' : 'Prepare Gist (~74 MB)'}
              onPress={() => void prepareGist()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {gistState === 'loading' ? (
          <Text style={styles.note}>
            Preparing — about {gistVariant === 'english' ? '15' : '74'} MB if it is
            not already here.
          </Text>
        ) : null}

        {gistState === 'ready' ? (
          <>
            <Text style={styles.note}>
              Multi-label, so two or three topics is the ordinary answer rather
              than a tie. The top topic always comes back even when nothing clears
              the model’s threshold — a text always has a nearest topic, and the
              score is what says how near.
            </Text>
            <TextInput
              value={topic}
              onChangeText={setTopic}
              placeholder="How to start a podcast with just your iPhone"
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.input}
            />
            {/* One subject in four languages, then two that are not about
                podcasting at all. The first four are the 101-language claim
                made tappable: no language is passed in, so the top topic
                surviving translation is the model rather than a keyword table. */}
            <View style={styles.phrases}>
              {GIST_PHRASES.map((sample) => (
                <Pressable
                  key={sample}
                  onPress={() => setTopic(sample)}
                  style={({ pressed }) => [styles.phrase, pressed && styles.buttonPressed]}>
                  <Text style={styles.phraseText}>{sample}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {tagged ? (
          <>
            <Row label="Topics" value={`${tagged.topics.length}`} />
            <Row label="Latency" value={gistMs === null ? '—' : `${gistMs} ms`} />
            <Row
              label="Model"
              value={`${tagged.variant} ${tagged.modelRevision ?? ''}`.trim()}
            />
            {tagged.topics.length === 0 ? (
              <Text style={styles.note}>
                Nothing to read — blank input is an answer here rather than an
                error, and it never reaches the weights.
              </Text>
            ) : (
              <View style={styles.words}>
                {tagged.topics.map((entry, index) => (
                  <View key={`${index}-${entry.slug}`} style={styles.filler}>
                    <Text style={styles.wordText}>{entry.name}</Text>
                    <Text style={styles.wordTime}>{entry.score.toFixed(3)}</Text>
                  </View>
                ))}
              </View>
            )}
            {tagged.topics.length === 1 ? (
              <Text style={styles.note}>
                One topic, so this may be the nearest topic rather than a
                confident one — the top one is returned either way. Two or more
                would mean every one of them cleared the threshold.
              </Text>
            ) : null}
          </>
        ) : null}

        {/* The join with Clips, on the same twelve lines: one model ranks the
            moments worth cutting, the other says what the thing is about. The
            roll-up itself runs no model — it is pure arithmetic, bound from
            upstream rather than reimplemented here. */}
        {gistState === 'ready' ? (
          <>
            <Text style={styles.sectionTitle}>What the sample transcript is about</Text>
            <Text style={styles.note}>
              Twelve lines, one distribution each, rolled up into channel-level
              topics. Clips ranks which of these lines are worth cutting; this
              says what they are collectively about, which is the other half of
              describing a piece of content.
            </Text>
            <Button
              label="Read the transcript"
              onPress={() => void runAbout()}
              disabled={busy !== null}
              tone="ghost"
            />
          </>
        ) : null}

        {about ? (
          about.length === 0 ? (
            <Text style={styles.note}>
              Nothing cleared the share floor, or there were fewer than{' '}
              {Gist.defaultRollupOptions.minPosts} posts — which is upstream
              declining to describe a channel from too little rather than being
              confident about it.
            </Text>
          ) : (
            <View style={styles.words}>
              {about.map((entry, index) => (
                <View key={`${index}-${entry.slug}`} style={styles.filler}>
                  <Text style={styles.wordText}>{entry.slug}</Text>
                  <Text style={styles.wordTime}>
                    {(entry.share * 100).toFixed(0)}% · {entry.postCount} line
                    {entry.postCount === 1 ? '' : 's'}
                  </Text>
                </View>
              ))}
            </View>
          )
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Redact</Text>

        {redactState === 'unsupported' ? (
          <Text style={styles.note}>
            {Redact.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {redactState === 'loading' ? (
          <Text style={styles.note}>Preparing — about 12 MB if it is not already here.</Text>
        ) : null}

        {redactState === 'absent' ? (
          <Button
            label="Prepare Redact (~12 MB)"
            onPress={() => void prepareRedact()}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}

        {redactState === 'ready' ? (
          <>
            <Text style={styles.note}>
              Type anything with a name, an email, a phone number or a card in it
              and Redact replaces each one with a numbered placeholder, in 27
              languages with no language setting to pass in. The mapping back to
              the originals stays here; the masked text is the part that is safe
              to send somewhere.
            </Text>
            <TextInput
              value={secret}
              onChangeText={setSecret}
              placeholder="Email Anna Kovács at anna.kovacs@example.com"
              autoCorrect={false}
              autoCapitalize="none"
              multiline
              style={styles.input}
            />
            {/* One person's details in four languages, then an address, a set of
                machine identifiers, and one sentence with nothing personal in it
                — which is the one to watch, because a false positive corrupts
                the text whatever reads it next. */}
            <View style={styles.phrases}>
              {REDACT_PHRASES.map((sample) => (
                <Pressable
                  key={sample}
                  onPress={() => setSecret(sample)}
                  style={({ pressed }) => [styles.phrase, pressed && styles.buttonPressed]}>
                  <Text style={styles.phraseText}>{sample}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {redacted ? (
          <>
            <Text style={styles.transcript}>
              {redacted.redactedText.length > 0 ? redacted.redactedText : '(nothing)'}
            </Text>
            <Row label="Found" value={`${redacted.items.length}`} />
            <Row label="Latency" value={redactMs === null ? '—' : `${redactMs} ms`} />
            <Row
              label="Round trip"
              value={roundTrip === null ? '—' : roundTrip ? 'exact' : 'MISMATCH'}
            />
            <Row label="Revision" value={redacted.modelRevision ?? '—'} />
            {redacted.items.length === 0 ? (
              <Text style={styles.note}>
                Nothing personal in it — which for this model is a result rather
                than a miss. Not masking ordinary words matters as much as
                catching real ones.
              </Text>
            ) : (
              <View style={styles.words}>
                {redacted.items.map((item, index) => (
                  <View key={`${index}-${item.placeholder}`} style={styles.filler}>
                    {/* The display name where the platform has one, and the label
                        itself where it does not. Never derived from the slug:
                        upstream's own names include "IMEI", "SSN" and
                        "IP address", none of which title-casing produces. */}
                    <Text style={styles.wordText}>
                      {Redact.labelDisplayNames[item.label] ?? item.label}
                    </Text>
                    {/* The number, not a word. An early version of this row
                        said "checksum" for a confidence of exactly 1 — and the
                        simulator disproved it in one tap: a confident neural
                        GIVEN_NAME saturates to 1.0 as well. What a detection was
                        found by is its label, not its score. */}
                    <Text style={styles.wordTime}>
                      {item.placeholder} · {item.confidence.toFixed(3)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}

        {/* The join with Voz, on whatever the microphone heard: a transcript is
            exactly the artifact an app forwards to a summarizer or files with a
            support ticket, so it is where this model belongs in the chain. Falls
            back to the sample transcript when there is no recording. */}
        {redactState === 'ready' ? (
          <Button
            label={transcript ? 'Mask the transcript' : 'Mask the sample transcript'}
            onPress={() => void runRedactTranscript()}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Shapes</Text>

        {shapesState === 'unsupported' ? (
          <Text style={styles.note}>
            {Shapes.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {shapesState === 'loading' ? (
          <Text style={styles.note}>Preparing — 0.2 MB, so this is usually over already.</Text>
        ) : null}

        {shapesState === 'absent' ? (
          <Button
            label="Prepare Shapes (0.2 MB)"
            onPress={() => void prepareShapes()}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}

        {shapesState === 'ready' ? (
          <>
            <Text style={styles.note}>
              Draw one stroke in the box with a finger. A wobbly loop comes back an
              exact circle, a crooked box a square, a scribble nothing at all —
              which is the half worth watching, because a whiteboard that turns a
              scribble into a triangle is worse than one that leaves it alone. Grey
              is what you drew; blue is what came back.
            </Text>
            {/* The canvas is the honest demo of this model: it reads a gesture, so
                a gesture is what it should be given. The buttons below feed the
                same recognizer strokes generated in code -- which is what makes
                the self-test reproducible, and what a simulator can tap. Both
                paths are one call with one set of arguments. */}
            <View
              style={styles.canvas}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(event) =>
                beginStroke(event.nativeEvent.locationX, event.nativeEvent.locationY)
              }
              onResponderMove={(event) =>
                extendStroke(event.nativeEvent.locationX, event.nativeEvent.locationY)
              }
              onResponderRelease={endStroke}
              onResponderTerminate={endStroke}>
              {stroke.length === 0 && !recognized ? (
                <Text style={styles.canvasHint}>draw here</Text>
              ) : null}
              <Ink points={stroke} />
              {recognized?.shape ? <Fit shape={recognized.shape} /> : null}
            </View>
            <View style={styles.phrases}>
              {SHAPE_SAMPLES.map((sample) => (
                <Pressable
                  key={sample.name}
                  onPress={() => void runShapes(sample.stroke(), sample.name)}
                  style={({ pressed }) => [
                    styles.phrase,
                    strokeSource === sample.name && styles.phraseSelected,
                    pressed && styles.buttonPressed,
                  ]}>
                  <Text
                    style={[
                      styles.phraseText,
                      strokeSource === sample.name && styles.phraseTextSelected,
                    ]}>
                    {sample.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {recognized ? (
          <>
            <Row label="Stroke" value={`${strokeSource ?? 'drawn'} · ${stroke.length} points`} />
            <Row label="Shape" value={recognized.shape ? recognized.shape.kind : 'rejected'} />
            {recognized.shape ? (
              <Row label="Geometry" value={describeShape(recognized.shape)} />
            ) : null}
            {/* Two numbers, not one, and the gap between them is the point: the
                model is advertised at under ten milliseconds, which is small
                enough that the bridge hop shows up beside it. */}
            <Row
              label="Native"
              value={`${(recognized.processingSec * 1000).toFixed(1)} ms`}
            />
            <Row label="Waited" value={shapeMs === null ? '—' : `${shapeMs} ms`} />
            <Row label="Revision" value={recognized.modelRevision ?? '—'} />
            {!recognized.shape ? (
              <Text style={styles.note}>
                Nothing fitted — which for this model is a result rather than a
                miss. The classifier has to clear its class's calibrated
                confidence gate AND the geometric fit has to clear its residual
                gate, so a confident guess that does not actually fit is still
                thrown away.
              </Text>
            ) : null}
          </>
        ) : null}
      </View>

      <View style={styles.metrics}>
        <Text style={styles.sectionTitle}>Align</Text>

        {alignState === 'unsupported' ? (
          <Text style={styles.note}>
            {Align.unsupportedReason ?? 'Not available on this device.'}
          </Text>
        ) : null}

        {alignState === 'loading' ? (
          <Text style={styles.note}>Preparing — 0.7 MB, so this is usually over already.</Text>
        ) : null}

        {alignState === 'absent' ? (
          <Button
            label="Prepare Align (0.7 MB)"
            onPress={() => void prepareAlign()}
            disabled={busy !== null}
            tone="ghost"
          />
        ) : null}

        {alignState === 'ready' ? (
          <>
            <Text style={styles.note}>
              The one model here that does not answer a question. Apple&apos;s
              SpeechAnalyzer transcribes well and times loosely; Align takes the
              same words and moves the boundaries, by tens of milliseconds. The
              text never changes. Both timings come back, so the shift is
              measurable on your own audio rather than taken on trust.
            </Text>
            {/* The pinned-revision warning, on screen rather than only in the
                log. This is the only model in the app whose weights can change
                under a shipped build. */}
            {!Align.revisionIsPinned ? (
              <Text style={styles.note}>
                Weights resolve “{Align.modelRevision}” — a branch, not a tag. A push to the Hub changes what an already-shipped
                app downloads, with no version number moving. Ship the directory
                yourself if that matters.
              </Text>
            ) : null}

            {alignLocaleState !== 'ready' ? (
              <>
                <Text style={styles.note}>
                  Align needs Apple&apos;s on-device recognizer for the locale as
                  well as its own weights, and that is the larger of the two
                  downloads. It is not pulled on launch.
                </Text>
                <Button
                  label={
                    alignLocaleState === 'loading'
                      ? `Installing ${ALIGN_LOCALE}…`
                      : `Install the ${ALIGN_LOCALE} speech model`
                  }
                  onPress={() => void prepareAlignLocale()}
                  disabled={busy !== null || alignLocaleState === 'loading'}
                  tone="ghost"
                />
              </>
            ) : null}

            {alignLocaleState === 'ready' ? (
              <>
                <Button
                  label="Refine the speech sample"
                  onPress={() => void runAlign(new File(Paths.cache, ALIGN_SAMPLE).uri, ALIGN_SAMPLE)}
                  disabled={busy !== null}
                  tone="ghost"
                />
                {(enhancedUri ?? originalUri) ? (
                  <Button
                    label={enhancedUri ? 'Refine the enhanced recording' : 'Refine the recording'}
                    onPress={() => void runAlign((enhancedUri ?? originalUri)!, enhancedUri ? 'enhanced' : 'recording')}
                    disabled={busy !== null}
                    tone="ghost"
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {aligned ? (
          <>
            <Text style={styles.transcript}>
              {aligned.text.length > 0 ? aligned.text : '(nothing recognized)'}
            </Text>
            <Row label="Source" value={alignSource ?? '—'} />
            <Row label="Words" value={`${aligned.words.length}`} />
            <Row
              label="Refined"
              value={`${aligned.refinedWordCount} / ${aligned.words.length}`}
            />
            <Row
              label="Mean shift"
              value={`${(timestampShift(aligned.words).meanAbsSec * 1000).toFixed(1)} ms`}
            />
            <Row
              label="Max shift"
              value={`${(timestampShift(aligned.words).maxAbsSec * 1000).toFixed(1)} ms`}
            />
            {/* Three numbers, not one, because they belong to different vendors.
                "Waited" is the whole call, most of which is Apple recognizing;
                "Refine" is the only part Align is responsible for; "Setup" is the
                per-call cost of building the two cascade stages. */}
            <Row label="Refine" value={`${(aligned.refineSec * 1000).toFixed(0)} ms`} />
            <Row label="Setup" value={`${(aligned.setupSec * 1000).toFixed(0)} ms`} />
            <Row label="Waited" value={alignMs === null ? '—' : `${alignMs} ms`} />
            <Row label="Language refined" value={aligned.languageRefined ? 'yes' : 'NO'} />
            <Row label="Revision" value={aligned.modelRevision ?? '—'} />
            {aligned.words.length > 0 ? (
              <View style={styles.words}>
                {aligned.words.slice(0, 16).map((word, index) => (
                  <View key={`${index}-${word.text}`} style={styles.filler}>
                    <Text style={styles.wordText}>{word.text}</Text>
                    {/* Apple's span above, Align's below -- the two numbers this
                        model exists to put next to each other. */}
                    <Text style={styles.wordTime}>
                      {word.refined
                        ? `${(word.originalStart * 1000).toFixed(0)} → ${(word.start * 1000).toFixed(0)} ms`
                        : 'kept'}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

/**
 * The stroke as it was drawn: one small dot per point.
 *
 * Dots rather than a line because there is no SVG in this app and no wish to add
 * one for a demo -- and because dots show the thing a polyline would hide, which
 * is that a real stroke's points are unevenly spaced (fast on the straights, slow
 * on the curves). That unevenness is exactly what upstream's uniform arc-length
 * resampling exists to undo before the model sees it.
 */
function Ink({ points }: { points: CanvasPoint[] }) {
  // Every second point past a hundred, so a long stroke does not become a
  // thousand views. The model gets all of them; only the ink is thinned.
  const step = points.length > 100 ? Math.ceil(points.length / 100) : 1;
  return (
    <>
      {points
        .filter((_, index) => index % step === 0)
        .map((point, index) => (
          <View key={index} style={[styles.inkDot, { left: point.x - 1.5, top: point.y - 1.5 }]} />
        ))}
    </>
  );
}

/**
 * The fitted shape, drawn from `outline` -- the same call an app would make.
 *
 * Each segment is one rotated View, which is the whole trick that lets this file
 * draw vector geometry with no drawing library: a segment is a 2 px bar centered
 * on the midpoint of its two endpoints and rotated to their angle.
 */
function Fit({ shape }: { shape: FittedShape }) {
  const points = outline(shape, 48);
  const closed = isClosed(shape);
  const last = closed ? points.length : points.length - 1;
  const segments = [];
  for (let i = 0; i < last; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.01) continue;
    segments.push(
      <View
        key={i}
        style={[
          styles.fitSegment,
          {
            left: (a.x + b.x) / 2 - length / 2,
            top: (a.y + b.y) / 2 - 1,
            width: length,
            transform: [{ rotate: `${Math.atan2(b.y - a.y, b.x - a.x)}rad` }],
          },
        ]}
      />
    );
  }
  return <>{segments}</>;
}

/**
 * One intent in three languages, plus two that are not about money at all.
 *
 * The point of the first three is the semantic stream: Emo's vocabulary is
 * toneless and language-free, so "Pay my bills" and its Spanish and Japanese
 * translations should rank the same emoji. That is the claim that separates this
 * model from a keyword table, and it is cheap to check by tapping.
 */
/**
 * The locale this app asks Align for.
 *
 * One rather than a picker, and hardcoded rather than derived from the device:
 * Apple's speech model is a per-locale download of hundreds of megabytes, so a
 * demo that let you pick would mostly be a demo of downloading. `en-US` is the
 * language the speech samples in this app are in.
 */
const ALIGN_LOCALE = 'en-US';

/**
 * The speech file Align is pointed at.
 *
 * Deliberately the *same* file Uhm analyzes, rather than one of its own. That is
 * what makes the three-model join real: Align times the words in this audio, Uhm
 * finds the fillers in this audio, and `Uhm.reconcileWords` puts the two
 * together. Two models over two different recordings would prove nothing about
 * either.
 */
const ALIGN_SAMPLE = 'uhm-sample.wav';

const SAMPLE_PHRASES = [
  'Pay my bills',
  'Pagar mis facturas',
  '請求書を払う',
  'go for a run',
  'call mum on her birthday',
];

/**
 * Tongue's answer key: a handful of words per language, with the right answer
 * attached.
 *
 * Eleven languages across seven scripts, and every one of them short on purpose
 * -- the product claim is "detect language based on 3 words", so a paragraph
 * would be testing something easier than what is advertised. Ear's labelled
 * fixtures are half-minute recordings someone has to drop into the cache; these
 * are strings, so this half of the comparison runs on every self-test with
 * nothing to install.
 *
 * `es` and `it` are both here deliberately. They are the pair the model is most
 * often right to be unsure about, and the self-test prints the margin rather
 * than only the verdict.
 */
const TONGUE_SAMPLES = [
  { code: 'de', text: 'kann ich das haben' },
  { code: 'es', text: 'me gustaría pedir la cuenta' },
  { code: 'fr', text: 'je voudrais réserver une table' },
  { code: 'pt', text: 'onde fica a estação de trem' },
  { code: 'it', text: 'vorrei prenotare un tavolo per due' },
  { code: 'nl', text: 'waar is het dichtstbijzijnde station' },
  { code: 'en', text: 'where is the nearest train station' },
  { code: 'ru', text: 'привет как дела сегодня' },
  { code: 'ja', text: 'これをください' },
  { code: 'ko', text: '안녕하세요 반갑습니다' },
  { code: 'el', text: 'που είναι ο σταθμός' },
] as const;

/**
 * The buttons under the Tongue field: one per interesting behaviour rather than
 * one per language.
 *
 * Hangul and Greek are settled by the script router alone and come back at
 * probability 1; Cyrillic narrows to eight languages before the model decodes;
 * "la casa" is a real tie between Italian and Spanish; and "hi i am" is the
 * cautionary one -- it reads as Welsh to any character model at high
 * probability, which is what `reliability` exists to catch and a confidence
 * threshold does not.
 */
const TONGUE_PHRASES = [
  'kann ich das haben',
  'la casa',
  'hi i am',
  'привет как дела',
  '안녕하세요',
  'που είναι ο σταθμός',
  'これをください',
];

/**
 * One subject in four languages, for the Gist self-test.
 *
 * Not an answer key -- the 36 taxonomy slugs come down with the weights and are
 * upstream's to rename, so hardcoding one here would be testing this package's
 * memory rather than the model. The assertion is agreement *between* these four:
 * no language is ever passed in, so a top topic that survives translation is the
 * 101-language claim, and a keyword table could not fake it.
 *
 * Four rather than two because two agreeing is a coin flip, and the leg allows at
 * most two distinct answers across the four -- multi-label scoring genuinely can
 * put "starting a podcast" between technology and the creator economy depending
 * on the phrasing, and failing the run for that would be asserting a taxonomy.
 */
const GIST_SAMPLES = [
  { code: 'en', text: 'How to start a podcast with just your iPhone' },
  { code: 'es', text: 'Cómo empezar un podcast solo con tu iPhone' },
  { code: 'de', text: 'Wie du nur mit deinem iPhone einen Podcast startest' },
  { code: 'ja', text: 'iPhoneだけでポッドキャストを始める方法' },
] as const;

/**
 * The buttons under the Gist field: the four translations above, then two that
 * are about something else entirely.
 *
 * The last two are there so the row is not all one topic -- a tagger that
 * answered "technology" to everything would look perfect against the first four
 * alone.
 */
const GIST_PHRASES = [
  ...GIST_SAMPLES.map((sample) => sample.text),
  'Why our index fund beat the hedge fund over ten years',
  'The best one-pan salmon recipe for a weeknight',
];

/**
 * One person's contact details, in four of Redact's 27 languages.
 *
 * Not an answer key -- which labels these produce is the model's opinion and
 * upstream's taxonomy, and four sentences are not a benchmark. What they are for
 * is the round trip: every one of them is masked and restored, and the assertion
 * is that the restored text is the input again, character for character, which
 * is a property no amount of taxonomy drift can change.
 *
 * The card number is 4111 1111 1111 1111, the Luhn-valid number every payment
 * processor publishes as a test value, so nothing here is anyone's data. The
 * email is on `example.com`, which is reserved by RFC 2606 for exactly this.
 */
const REDACT_SAMPLES = [
  {
    code: 'en',
    text:
      'Email Anna Kovács at anna.kovacs@example.com or call +36 1 234 5678; ' +
      'her card is 4111 1111 1111 1111.',
  },
  {
    code: 'es',
    text:
      'Escribe a Anna Kovács a anna.kovacs@example.com o llama al +36 1 234 5678; ' +
      'su tarjeta es 4111 1111 1111 1111.',
  },
  {
    code: 'de',
    text:
      'Schreib Anna Kovács an anna.kovacs@example.com oder ruf +36 1 234 5678 an; ' +
      'ihre Karte ist 4111 1111 1111 1111.',
  },
  {
    code: 'hu',
    text:
      'Írj Kovács Annának a anna.kovacs@example.com címre, vagy hívd a +36 1 234 5678 ' +
      'számot; a kártyája 4111 1111 1111 1111.',
  },
] as const;

/**
 * The buttons under the Redact field: the four translations above, then three
 * that exercise other parts of the taxonomy -- a postal address, a set of
 * machine identifiers, and one sentence with no personal data in it at all.
 *
 * The last is the one worth having. Precision matters as much as recall here,
 * because a false positive corrupts the text whatever reads it next, and a
 * masker that redacted something in this sentence would be doing damage rather
 * than work.
 */
const REDACT_PHRASES = [
  ...REDACT_SAMPLES.map((sample) => sample.text),
  'Ship it to Dr. Maria Silva, 42 Rue de la Paix, Apt 3B, 75002 Paris.',
  'The box at 192.168.1.14 logged in from https://example.com with IMEI 490154203237518.',
  'The deployment finished at noon and the dashboard looks fine.',
];

/**
 * The labelled fixtures the Ear leg looks for, as `ear-<code>.wav` in the app's
 * cache.
 *
 * Six languages in four scripts, each about half a minute -- one full window, so
 * the detector is answering with its real context rather than from padding.
 * Generated on a Mac with `say` and `afconvert`; see packages/ear/README.md.
 */
const LANGUAGE_SAMPLES = ['en', 'es', 'pt', 'fr', 'de', 'ja'];

/** How far along a model is. Shared by the two that download on demand. */
type ModelState = 'unsupported' | 'absent' | 'loading' | 'ready';

/**
 * A transcript to rank when there is no microphone in the loop.
 *
 * Written as something a clip selector has a real opinion about -- a few lines
 * that carry a point, and a few that are throat-clearing around them -- so the
 * self-test shows ranking rather than an arbitrary ordering of equals.
 */
const SAMPLE_TRANSCRIPT = [
  'So thanks everyone for joining, we can probably get started.',
  'I want to talk about why the first version failed.',
  'We spent four months building a recommendation engine nobody asked for.',
  'The metrics looked fine in staging, which is exactly the problem.',
  'Staging had a thousand users and production had two million.',
  'Every assumption we made about cache locality was wrong at that scale.',
  'Anyway, that is the background.',
  'The rewrite took six weeks and it is a third of the code.',
  'The single biggest lesson is that we should have shipped a fake version first.',
  'A button that did nothing would have told us in two days what took four months.',
  'I think that is the thing I would tell anyone starting out.',
  'Right, any questions before we move on to the roadmap?',
];

/** A 200 Hz tone standing in for voice, buried in broadband hiss. */
function syntheticSpeech(sampleRate: number, seconds: number) {
  const samples = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] =
      0.25 * Math.sin((2 * Math.PI * 200 * i) / sampleRate) + 0.05 * (Math.random() * 2 - 1);
  }
  return samples;
}

/** Minimal 16-bit PCM WAV, so the self-test has a real file to hand to the models. */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

function peakOf(samples: Float32Array) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]!));
  return peak;
}

async function replay(player: {
  seekTo: (s: number) => Promise<void>;
  play: () => void;
}) {
  // Seek first so a second tap restarts rather than resuming at the end, and
  // await it: `seekTo` is asynchronous, and playing before it lands can drop the
  // first fraction of a second.
  await player.seekTo(0);
  player.play();
}

function format(value: number | null, unit = 'LUFS') {
  return value === null ? 'bypassed' : `${value.toFixed(1)} ${unit}`;
}

function describe(error: unknown) {
  return error instanceof DesertAntError
    ? `${error.code}: ${error.message}`
    : String((error as Error)?.message ?? error);
}

/**
 * A deterministic wobble.
 *
 * A linear congruential generator seeded per sample, rather than `Math.random`,
 * so "the rough rectangle" is the same rough rectangle on every launch. That is
 * what makes the self-test's numbers comparable between runs and what lets a
 * disagreement between two builds mean something.
 */
function wobble(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
}

/**
 * Six synthetic strokes, in the canvas's own coordinates.
 *
 * They are drawn the way a hand draws: unevenly spaced points, a few pixels of
 * jitter, and a little overshoot past the start where a loop closes. That is not
 * decoration -- a perfect analytic circle is an easier input than a real one, and
 * a demo that fed the model perfect inputs would prove nothing about what it does
 * with a finger.
 *
 * The last one is the one to watch. A scribble is what this model is asked to
 * *reject*, and a recognizer that never rejects anything is worse than useless on
 * a whiteboard -- so there is a sample for it, and the self-test logs what
 * happened without asserting an answer.
 */
const SHAPE_SAMPLES: { name: string; stroke: () => CanvasPoint[] }[] = [
  {
    name: 'circle',
    stroke: () => {
      const jitter = wobble(0x5eed01);
      const points: CanvasPoint[] = [];
      // Slightly past a full turn, the way a hand closes a loop.
      for (let i = 0; i <= 104; i += 1) {
        const t = (i / 96) * 2 * Math.PI;
        points.push({
          x: 120 + 70 * Math.cos(t) + jitter() * 6,
          y: 102 + 70 * Math.sin(t) + jitter() * 6,
        });
      }
      return points;
    },
  },
  {
    name: 'rectangle',
    stroke: () => polygonStroke([
      { x: 45, y: 35 },
      { x: 196, y: 35 },
      { x: 196, y: 172 },
      { x: 45, y: 172 },
    ], 28, 6, 0x5eed02, true),
  },
  {
    name: 'triangle',
    stroke: () => polygonStroke([
      { x: 120, y: 28 },
      { x: 208, y: 172 },
      { x: 32, y: 172 },
    ], 34, 6, 0x5eed03, true),
  },
  {
    name: 'line',
    stroke: () => polygonStroke([
      { x: 28, y: 152 },
      { x: 214, y: 56 },
    ], 44, 5, 0x5eed04, false),
  },
  {
    name: 'star',
    stroke: () => {
      const jitter = wobble(0x5eed05);
      const vertices: CanvasPoint[] = [];
      for (let i = 0; i < 10; i += 1) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const radius = i % 2 === 0 ? 76 : 31;
        vertices.push({ x: 120 + radius * Math.cos(angle), y: 104 + radius * Math.sin(angle) });
      }
      const points = polygonStroke(vertices, 12, 5, 0x5eed05, true);
      return points.map((pt) => ({ x: pt.x + jitter() * 1.5, y: pt.y + jitter() * 1.5 }));
    },
  },
  {
    name: 'scribble',
    stroke: () => {
      // A bounded random walk with a hard turn every few steps: no consistent
      // curvature, no closed outline, nothing for a fitter to agree with.
      const jitter = wobble(0x5eed06);
      const points: CanvasPoint[] = [{ x: 60, y: 60 }];
      let angle = 0;
      for (let i = 0; i < 90; i += 1) {
        angle += jitter() * 2.4 + (i % 7 === 0 ? jitter() * 4 : 0);
        const previous = points[points.length - 1]!;
        points.push({
          x: Math.min(230, Math.max(20, previous.x + Math.cos(angle) * 11)),
          y: Math.min(190, Math.max(20, previous.y + Math.sin(angle) * 11)),
        });
      }
      return points;
    },
  },
];

/**
 * Walk a polygon's edges, laying down jittered points as it goes.
 *
 * `perEdge` points per edge and `amplitude` pixels of wobble, plus -- when the
 * figure is closed -- a short overshoot past the starting corner, because that is
 * what a hand does and because a stroke that stops exactly on its own first point
 * is a cleaner input than the model will ever get.
 */
function polygonStroke(
  vertices: CanvasPoint[],
  perEdge: number,
  amplitude: number,
  seed: number,
  closed: boolean
): CanvasPoint[] {
  const jitter = wobble(seed);
  const points: CanvasPoint[] = [];
  const edges = closed ? vertices.length : vertices.length - 1;
  for (let e = 0; e < edges; e += 1) {
    const a = vertices[e]!;
    const b = vertices[(e + 1) % vertices.length]!;
    for (let i = 0; i < perEdge; i += 1) {
      const t = i / perEdge;
      points.push({
        x: a.x + (b.x - a.x) * t + jitter() * amplitude,
        y: a.y + (b.y - a.y) * t + jitter() * amplitude,
      });
    }
  }
  if (closed) {
    const a = vertices[0]!;
    const b = vertices[1]!;
    for (let i = 0; i < 4; i += 1) {
      const t = i / perEdge;
      points.push({
        x: a.x + (b.x - a.x) * t + jitter() * amplitude,
        y: a.y + (b.y - a.y) * t + jitter() * amplitude,
      });
    }
  }
  return points;
}

/** A one-line summary of a fitted shape's geometry, for a log line and a row. */
function describeShape(shape: FittedShape): string {
  const n = (value: number) => value.toFixed(1);
  const deg = (radians: number) => `${((radians * 180) / Math.PI).toFixed(0)}°`;
  switch (shape.kind) {
    case 'line':
      return `(${n(shape.from.x)}, ${n(shape.from.y)}) → (${n(shape.to.x)}, ${n(shape.to.y)})`;
    case 'rectangle': {
      const [a, b, c] = shape.corners;
      if (!a || !b || !c) return `${shape.corners.length} corners`;
      const w = Math.hypot(b.x - a.x, b.y - a.y);
      const h = Math.hypot(c.x - b.x, c.y - b.y);
      const square = Math.abs(w - h) < 1e-6 ? ' (square)' : '';
      return `${n(w)} × ${n(h)}${square} at ${deg(Math.atan2(b.y - a.y, b.x - a.x))}`;
    }
    case 'triangle': {
      const [a, b, c] = shape.vertices;
      if (!a || !b || !c) return `${shape.vertices.length} vertices`;
      const sides = [
        Math.hypot(b.x - a.x, b.y - a.y),
        Math.hypot(c.x - b.x, c.y - b.y),
        Math.hypot(a.x - c.x, a.y - c.y),
      ];
      return `sides ${sides.map(n).join(' / ')}`;
    }
    case 'ellipse': {
      const circle = Math.abs(shape.semiMajor - shape.semiMinor) < 1e-9;
      return circle
        ? `circle r ${n(shape.semiMajor)} at (${n(shape.center.x)}, ${n(shape.center.y)})`
        : `axes ${n(shape.semiMajor)} / ${n(shape.semiMinor)} at ${deg(shape.rotation)}`;
    }
    case 'star':
      return `${shape.pointCount} points, r ${n(shape.outerRadius)} / ${n(shape.innerRadius)} ` +
        `at ${deg(shape.rotation)}`;
  }
}

/** The stroke's bounding box, for the "the fit landed where the stroke was"
 *  invariant in the self-test. */
function bounds(points: CanvasPoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'danger' | 'ghost';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        tone === 'danger' && styles.buttonDanger,
        tone === 'ghost' && styles.buttonGhost,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}>
      <Text style={[styles.buttonLabel, tone === 'ghost' && styles.buttonLabelGhost]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 88, paddingBottom: 64, gap: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  subtitle: { fontSize: 16, opacity: 0.6, marginBottom: 16 },
  error: { color: '#b00020', marginBottom: 8 },
  button: {
    backgroundColor: '#1f6feb',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDanger: { backgroundColor: '#b00020' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#1f6feb' },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.75 },
  buttonLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
  buttonLabelGhost: { color: '#1f6feb' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  busyText: { opacity: 0.7 },
  metrics: { marginTop: 16, gap: 6 },
  sectionTitle: { fontSize: 20, fontWeight: '700', marginBottom: 2 },
  note: { opacity: 0.6, lineHeight: 20, marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { opacity: 0.6 },
  rowValue: { fontVariant: ['tabular-nums'], fontWeight: '600' },
  transcript: { marginTop: 10, fontSize: 17, lineHeight: 24 },
  clip: {
    borderLeftWidth: 3,
    borderLeftColor: '#1f6feb',
    paddingLeft: 10,
    paddingVertical: 6,
    marginTop: 8,
    gap: 3,
  },
  clipHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  clipRank: { fontWeight: '700', fontSize: 15 },
  clipMeta: { fontSize: 12, opacity: 0.55, fontVariant: ['tabular-nums'] },
  clipText: { fontSize: 15, lineHeight: 21 },
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  word: {
    borderWidth: 1,
    borderColor: '#d0d7de',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
  },
  filler: {
    borderWidth: 1,
    borderColor: '#f0b429',
    backgroundColor: '#fdf5e3',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d0d7de',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 17,
    marginTop: 4,
  },
  phrases: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  phrase: {
    borderWidth: 1,
    borderColor: '#1f6feb',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  phraseText: { color: '#1f6feb', fontSize: 13 },
  phraseSelected: { backgroundColor: '#1f6feb' },
  phraseTextSelected: { color: 'white' },
  emoji: {
    borderWidth: 1,
    borderColor: '#d0d7de',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 2,
  },
  emojiGlyph: { fontSize: 28 },
  canvas: {
    height: 210,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#d0d7de',
    borderStyle: 'dashed',
    borderRadius: 12,
    backgroundColor: '#fbfcfd',
    overflow: 'hidden',
  },
  canvasHint: { position: 'absolute', left: 14, top: 12, fontSize: 13, opacity: 0.35 },
  inkDot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#8b949e',
  },
  fitSegment: { position: 'absolute', height: 2, borderRadius: 1, backgroundColor: '#1f6feb' },
  wordText: { fontWeight: '600' },
  wordTime: { fontSize: 11, opacity: 0.5, fontVariant: ['tabular-nums'] },
});
