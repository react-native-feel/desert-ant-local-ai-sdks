import { Clear, DesertAntError, type ClearMetrics, type ProgressEvent } from '@desert-ant-labs/react-native-clear';
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

  const originalPlayer = useAudioPlayer(originalUri ?? undefined);
  const enhancedPlayer = useAudioPlayer(enhancedUri ?? undefined);

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
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  const stopAndEnhance = useCallback(async () => {
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) {
      setError('The recorder produced no file.');
      return;
    }
    setOriginalUri(uri);

    const model = clear.current;
    if (!model) return;

    setBusy('Enhancing');
    try {
      const result = await model.enhance({
        uri,
        targetLUFS: 'applePodcasts',
        onProgress: setProgress,
      });
      setEnhancedUri(result.uri);
      setMetrics(result);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [recorder]);

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

      {originalUri ? (
        <Button label="Play original" onPress={() => replay(originalPlayer)} tone="ghost" />
      ) : null}
      {enhancedUri ? (
        <Button label="Play enhanced" onPress={() => replay(enhancedPlayer)} tone="ghost" />
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

function replay(player: { seekTo: (s: number) => void; play: () => void }) {
  player.seekTo(0);
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
