import {
  Clear,
  DesertAntError,
  type ClearMetrics,
  type ProgressEvent,
} from '@desert-ant-labs/react-native-clear';
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
 * One recording, both models: record a clip, enhance it on device with Clear,
 * then transcribe the enhanced audio with Voz and A/B the two.
 *
 * The whole point of both file APIs is visible here: the recording never becomes
 * a JavaScript array. `recorder.uri` goes into Clear, an enhanced `uri` comes
 * out, that same `uri` goes into Voz, and text comes back.
 *
 * The two models are deliberately loaded on different terms. Clear's weights are
 * ~9 MB, so it loads on mount. Voz's are ~490 MB, so it does not: the app checks
 * whether they are already on disk and otherwise waits for an explicit tap. That
 * asymmetry is the honest one to demonstrate -- an SDK that silently pulled half
 * a gigabyte on first launch would be a bug in the app, not a feature of the model.
 */
export default function App() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  const clear = useRef<Clear | null>(null);
  const voz = useRef<Voz | null>(null);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [originalUri, setOriginalUri] = useState<string | null>(null);
  const [enhancedUri, setEnhancedUri] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ClearMetrics | null>(null);

  const [vozState, setVozState] = useState<'unsupported' | 'absent' | 'loading' | 'ready'>(
    Voz.isSupported ? 'absent' : 'unsupported'
  );
  const [transcript, setTranscript] = useState<Transcript | null>(null);

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
    })();

    return () => {
      cancelled = true;
      clear.current?.release();
      clear.current = null;
      voz.current?.release();
      voz.current = null;
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

  const record = useCallback(async () => {
    setError(null);
    setEnhancedUri(null);
    setMetrics(null);
    setTranscript(null);
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

    const model = clear.current;
    if (!model) return;

    console.log(`[rec] uri=${uri} bytes=${new File(uri).size}`);
    setBusy('Enhancing');
    let enhanced: string | null = null;
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

    if (enhanced && voz.current) {
      await runTranscribe(enhanced);
    }
  }, [recorder]);

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
    } catch (e) {
      console.log(`[voz] transcribe FAILED: ${describe(e)}`);
      setError(describe(e));
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
  const selfTest = useCallback(async () => {
    setError(null);
    setBusy('Self-test');
    try {
      const model = clear.current ?? Clear.create();
      const sampleRate = 48_000;
      const noisy = syntheticSpeech(sampleRate, 2);

      // --- Clear: the primary API, file in, file out
      const input = new File(Paths.cache, 'selftest.wav');
      input.create({ overwrite: true });
      await input.write(encodeWav(noisy, sampleRate));

      const t0 = Date.now();
      const fileResult = await model.enhance({
        uri: input.uri,
        onProgress: (e) => console.log(`[clear] ${e.phase} ${e.fraction.toFixed(2)}`),
      });
      const output = new File(fileResult.uri);
      console.log(
        `[clear] enhance(file) ok in ${Date.now() - t0}ms — ` +
          `${fileResult.uri.split('/').pop()} exists=${output.exists} bytes=${output.size} ` +
          `${fileResult.durationSec.toFixed(2)}s rtf=${fileResult.realtimeFactor.toFixed(1)}x ` +
          `LUFS=${fileResult.measuredLUFS} truePeak=${fileResult.measuredTruePeakDBFS} ` +
          `variant=${fileResult.modelVariant} revision=${fileResult.modelRevision} ` +
          `runtime=${fileResult.modelRuntime}`
      );

      // --- Clear: the in-memory API
      const t1 = Date.now();
      const bufferResult = await model.enhanceSamples(noisy, sampleRate);
      console.log(
        `[clear] enhanceSamples ok in ${Date.now() - t1}ms — ` +
          `${bufferResult.channels.length}ch x ${bufferResult.samples.length} @ ` +
          `${bufferResult.sampleRate}Hz rtf=${bufferResult.realtimeFactor.toFixed(1)}x ` +
          `peak=${peakOf(bufferResult.samples).toFixed(4)}`
      );

      setMetrics(fileResult);
      setOriginalUri(input.uri);
      setEnhancedUri(fileResult.uri);
      if (!clear.current) model.release();

      // --- Voz, if its weights are here. Skipped rather than downloaded: a
      //     smoke test should not pull 490 MB behind the user's back.
      const speech = voz.current;
      if (!speech) {
        console.log('[voz] self-test skipped — model not prepared');
        return;
      }

      const t2 = Date.now();
      const fromFile = await speech.transcribe({
        uri: fileResult.uri,
        onProgress: (e) => console.log(`[voz] ${e.phase} ${e.fraction.toFixed(2)}`),
      });
      console.log(
        `[voz] transcribe(file) ok in ${Date.now() - t2}ms — ` +
          `${fromFile.words.length} words ${fromFile.durationSec.toFixed(2)}s ` +
          `rtf=${fromFile.realtimeFactor.toFixed(1)}x revision=${fromFile.modelRevision} ` +
          `runtime=${fromFile.modelRuntime} text="${fromFile.text}"`
      );

      // Voz runs at 16 kHz; passing 48 kHz here proves the native resample path.
      const t3 = Date.now();
      const fromSamples = await speech.transcribeSamples(noisy, sampleRate);
      console.log(
        `[voz] transcribeSamples ok in ${Date.now() - t3}ms — ` +
          `${fromSamples.words.length} words ${fromSamples.durationSec.toFixed(2)}s ` +
          `rtf=${fromSamples.realtimeFactor.toFixed(1)}x text="${fromSamples.text}"`
      );

      const ordered = fromFile.words.every(
        (word, i) => word.end >= word.start && (i === 0 || word.start >= fromFile.words[i - 1]!.start)
      );
      console.log(`[voz] word timings monotonic and non-negative: ${ordered}`);
      setTranscript(fromFile);
    } catch (e) {
      console.log(`[selftest] FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  const audioToTranscribe = enhancedUri ?? originalUri;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Desert Ant</Text>
      <Text style={styles.subtitle}>Clear enhances it, Voz reads it back</Text>

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
    </ScrollView>
  );
}

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
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  word: {
    borderWidth: 1,
    borderColor: '#d0d7de',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
  },
  wordText: { fontWeight: '600' },
  wordTime: { fontSize: 11, opacity: 0.5, fontVariant: ['tabular-nums'] },
});
