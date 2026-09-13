import {
  Clear,
  DesertAntError,
  type ClearMetrics,
  type ProgressEvent,
} from '@desert-ant-labs/react-native-clear';
import { Clips, type Clip } from '@desert-ant-labs/react-native-clips';
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
  View,
} from 'react-native';

/**
 * One recording, four models, in the order they compose: record, enhance it on
 * device with Clear, transcribe the enhanced audio with Voz, hand that
 * transcript to Clips to find the moments worth cutting, and run Uhm over the
 * same audio to find every "um" in it.
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

      // Uhm is ~45 MB, so it loads on mount like Clear rather than behind a tap.
      // It is the fourth model and the only one that needs nothing from the other
      // three: give it audio and it answers.
      if (cancelled || !Uhm.isSupported) return;
      void prepareUhm(false);

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

    // Voz first, so the fillers can be reconciled against a transcript of the
    // same audio in one pass.
    let spoken: Transcript | null = null;
    if (enhanced && voz.current) {
      // `runTranscribe` answers undefined when its model went away mid-call.
      spoken = (await runTranscribe(enhanced)) ?? null;
      if (spoken && clips.current) {
        await runFindClips(spoken);
      }
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
  }, [recorder]);

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

    // Uhm goes first because it is the only model loaded without anyone tapping
    // anything, and because each leg awaits the one before it: a leg that hangs
    // rather than throwing takes every later leg down with it, and its own
    // try/catch cannot help. Putting the always-ready one at the front means the
    // self-test always reports something.

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
  }, []);

  const audioToTranscribe = enhancedUri ?? originalUri;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Desert Ant</Text>
      <Text style={styles.subtitle}>
        Clear cleans it, Voz reads it, Clips cuts it, Uhm finds the ums
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
    </ScrollView>
  );
}

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
  wordText: { fontWeight: '600' },
  wordTime: { fontSize: 11, opacity: 0.5, fontVariant: ['tabular-nums'] },
});
