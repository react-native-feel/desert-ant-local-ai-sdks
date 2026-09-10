import { Clear, DesertAntError, type ClearMetrics, type ProgressEvent } from '@desert-ant-labs/react-native-clear';
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
 * Record a clip, enhance it on device, then A/B the two.
 *
 * The whole point of the file API is visible here: the recording never becomes
 * a JavaScript array. `recorder.uri` goes in, an enhanced `uri` comes out, and
 * both are handed straight to a player.
 */
export default function App() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  const clear = useRef<Clear | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalUri, setOriginalUri] = useState<string | null>(null);
  const [enhancedUri, setEnhancedUri] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ClearMetrics | null>(null);

  // Logged before anything else touches the model: reading these two proves the
  // native module resolved and its `@JS` properties are bound, which is the
  // failure most likely to be silent.
  useEffect(() => {
    console.log(
      `[clear] isSupported=${Clear.isSupported} nativeCore=${Clear.nativeCoreVersion}`
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
      setBusy('Loading the model');
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
    })();

    return () => {
      cancelled = true;
      clear.current?.release();
      clear.current = null;
    };
  }, []);

  const record = useCallback(async () => {
    setError(null);
    setEnhancedUri(null);
    setMetrics(null);
    // Re-arm the session every time, not once at mount: `stopAndEnhance` hands it
    // back to playback when it finishes, so by the second recording iOS would
    // otherwise refuse with RecordingDisabledException.
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  const stopAndEnhance = useCallback(async () => {
    await recorder.stop();
    // Hand the audio session back to playback before doing anything else. While
    // `allowsRecording` is true iOS keeps the session in PlayAndRecord, which
    // both muffles playback through the receiver and leaves the session engaged
    // while Clear reads the file.
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
    try {
      const result = await model.enhance({
        uri,
        targetLUFS: 'applePodcasts',
        onProgress: setProgress,
      });
      console.log(
        `[rec] ok — ${result.uri.split('/').pop()} bytes=${new File(result.uri).size} ` +
          `${result.durationSec.toFixed(2)}s rtf=${result.realtimeFactor.toFixed(1)}x ` +
          `LUFS=${result.measuredLUFS} truePeak=${result.measuredTruePeakDBFS}`
      );
      setEnhancedUri(result.uri);
      setMetrics(result);
    } catch (e) {
      console.log(`[rec] FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [recorder]);

  /**
   * Exercise both native paths on synthetic audio, without a microphone: write a
   * WAV to the cache and run `enhance` on it (the primary, file-based API), then
   * push the same samples through `enhanceSamples` (the in-memory one).
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

      // --- the primary API: file in, file out
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

      // --- the in-memory API
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
    } catch (e) {
      console.log(`[clear] self-test FAILED: ${describe(e)}`);
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Clear</Text>
      <Text style={styles.subtitle}>On-device speech enhancement</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button
        label={recorderState.isRecording ? 'Stop and enhance' : 'Record'}
        onPress={recorderState.isRecording ? stopAndEnhance : record}
        disabled={!ready || busy !== null}
        tone={recorderState.isRecording ? 'danger' : 'primary'}
      />

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.busyText}>
            {busy}
            {progress ? ` — ${progress.phase}` : ''}
            {/* Android reports phase boundaries only, so a percentage there
                would be a fiction. See ProgressEvent.fraction. */}
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
          <Row label="Realtime factor" value={`${metrics.realtimeFactor.toFixed(0)}x`} />
          <Row label="Duration" value={`${metrics.durationSec.toFixed(1)} s`} />
          <Row label="Processing" value={`${(metrics.processingSec * 1000).toFixed(0)} ms`} />
          <Row label="Input LUFS" value={format(metrics.measuredLUFS)} />
          <Row label="True peak" value={format(metrics.measuredTruePeakDBFS, 'dBFS')} />
          <Row label="Runtime" value={metrics.modelRuntime ?? '—'} />
        </View>
      ) : null}
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

/** Minimal 16-bit PCM WAV, so the self-test has a real file to hand to `enhance`. */
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
  container: { padding: 24, paddingTop: 88, gap: 12 },
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
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { opacity: 0.6 },
  rowValue: { fontVariant: ['tabular-nums'], fontWeight: '600' },
});
