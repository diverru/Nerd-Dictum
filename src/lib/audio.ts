/**
 * Audio recording module.
 * Audio data is encoded by MediaRecorder (opus) for compact upload.
 * A parallel Web Audio worklet runs only for RMS / silence detection,
 * optionally retaining PCM for a 16 kHz WAV export (local-STT pipeline).
 */

import { encodeWavToBase64 } from './wav-encoder';

// Audio configuration
const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1; // mono
const BITS_PER_SAMPLE = 16;
const RECORDER_BITRATE = 24000; // opus 24 kbps — clean speech, ~10x smaller than PCM WAV
const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
];

// Validation constants
const MIN_RECORDING_MS = 250;
const MAX_RECORDING_MS = 15 * 60 * 1000; // 15 minutes

// Silence detection constants
const SILENCE_THRESHOLD = 0.01; // RMS threshold below which audio is considered silence
const DEFAULT_SILENCE_DURATION_MS = 2500; // Stop recording after 2.5s of silence

// Debug logging interval
let lastRmsLogTime = 0;
const RMS_LOG_INTERVAL_MS = 500; // Log RMS every 500ms
const SILENCE_STATE_LOG_DEBOUNCE_MS = 1000;

export class AudioRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioRecordingError';
  }
}

/**
 * Dependencies for AudioRecorder (injectable for testing)
 */
export interface AudioRecorderDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext: (options?: AudioContextOptions) => AudioContext;
  getWorkletUrl: () => string;
}

const defaultDeps: AudioRecorderDeps = {
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext: (options) => new AudioContext(options),
  getWorkletUrl: () => {
    // In Electron production builds (file:// protocol), window.location.origin returns "null"
    // Use a relative path which works correctly with both http:// and file:// protocols
    if (window.location.protocol === 'file:') {
      // For file:// protocol, construct path relative to current HTML file
      const basePath = window.location.href.substring(0, window.location.href.lastIndexOf('/'));
      return `${basePath}/audio-processor.worklet.js`;
    }
    // For http:// (dev server), use absolute path from origin
    return new URL('/audio-processor.worklet.js', window.location.origin).href;
  },
};

export type SilenceStopCallback = () => void;
export type AudioLevelCallback = (rms: number) => void;

export interface AudioRecorderOptions {
  deviceId?: string;
  silenceDetectionEnabled?: boolean;
  silenceDurationMs?: number;
  /**
   * If true, the worklet's raw PCM frames are kept around and mergeable into
   * a 16 kHz mono WAV via `getWavBase64()`. Costs a bit of memory and an
   * extra resample/encode step at stop(); off by default because the main
   * "Gemini direct" mode uses opus.
   */
  retainPcmForWav?: boolean;
}

export class AudioRecorder {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recorderChunks: Blob[] = [];
  private recordedMimeType: string = 'audio/webm';
  // Optional parallel PCM buffer for WAV output (local-STT pipeline).
  private pcmChunks: Float32Array[] = [];
  private wavBase64: string | null = null;
  private recordingStartTime: number = 0;
  private isRecording: boolean = false;
  private originalSampleRate: number = TARGET_SAMPLE_RATE;
  private deps: AudioRecorderDeps;
  private silenceStartTime: number | null = null;
  private onSilenceStop: SilenceStopCallback | null = null;
  private onAudioLevel: AudioLevelCallback | null = null;
  private silenceStopFired: boolean = false;
  private options: AudioRecorderOptions;
  private lastSilenceLogTime: number = Number.NEGATIVE_INFINITY;
  private lastSoundLogTime: number = Number.NEGATIVE_INFINITY;

  constructor(deps: AudioRecorderDeps = defaultDeps, options: AudioRecorderOptions = {}) {
    this.deps = deps;
    this.options = {
      deviceId: options.deviceId || '',
      silenceDetectionEnabled: options.silenceDetectionEnabled ?? true,
      silenceDurationMs: options.silenceDurationMs || DEFAULT_SILENCE_DURATION_MS,
      retainPcmForWav: options.retainPcmForWav ?? false,
    };
  }

  /**
   * Set callback to be called when recording stops due to silence
   */
  setOnSilenceStop(callback: SilenceStopCallback | null): void {
    this.onSilenceStop = callback;
  }

  /**
   * Set callback to receive real-time audio level (RMS) updates during recording.
   * Called at ~10-15fps with normalized RMS value (0 to 1).
   */
  setOnAudioLevel(callback: AudioLevelCallback | null): void {
    this.onAudioLevel = callback;
  }

  /**
   * Calculate RMS (root mean square) of audio samples
   */
  private calculateRMS(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Start recording audio from the microphone
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      throw new AudioRecordingError('Recording already in progress');
    }

    try {
      // Request microphone access
      const audioConstraints: MediaTrackConstraints = {
        channelCount: CHANNELS,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      };

      // Add device ID if specified
      if (this.options.deviceId) {
        audioConstraints.deviceId = { exact: this.options.deviceId };
      }

      console.log('[AudioRecorder] Requesting microphone with constraints:', JSON.stringify(audioConstraints, null, 2));

      this.mediaStream = await this.deps.getUserMedia({
        audio: audioConstraints,
      });

      // Log which device we actually got
      const audioTrack = this.mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        const trackSettings = audioTrack.getSettings();
        console.log('[AudioRecorder] Got audio track:', {
          label: audioTrack.label,
          deviceId: trackSettings.deviceId,
          sampleRate: trackSettings.sampleRate,
          channelCount: trackSettings.channelCount,
          echoCancellation: trackSettings.echoCancellation,
          noiseSuppression: trackSettings.noiseSuppression,
        });
      }

      // Create audio context
      this.audioContext = this.deps.createAudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
      });

      // Store the actual sample rate (may differ from requested)
      this.originalSampleRate = this.audioContext.sampleRate;
      console.log(`[AudioRecorder] AudioContext created: requested=${TARGET_SAMPLE_RATE}Hz, actual=${this.originalSampleRate}Hz`);

      // Create source node from media stream
      this.sourceNode = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );

      // Load and register the AudioWorklet processor
      // In Electron/Vite, the worklet file is served from the public directory
      const workletUrl = this.deps.getWorkletUrl();
      console.log('[AudioRecorder] Loading worklet from:', workletUrl);
      await this.audioContext.audioWorklet.addModule(workletUrl);
      console.log('[AudioRecorder] Worklet loaded successfully');

      // Create AudioWorkletNode to replace deprecated ScriptProcessorNode
      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');

      // Set up opus encoding via MediaRecorder on the same MediaStream
      this.recordedMimeType = pickRecorderMimeType();
      this.recorderChunks = [];
      this.pcmChunks = [];
      this.wavBase64 = null;
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: this.recordedMimeType,
        audioBitsPerSecond: RECORDER_BITRATE,
      });
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recorderChunks.push(event.data);
        }
      };
      this.mediaRecorder.start();

      // Reset silence detection
      this.silenceStartTime = null;
      this.silenceStopFired = false;
      this.lastSilenceLogTime = Number.NEGATIVE_INFINITY;
      this.lastSoundLogTime = Number.NEGATIVE_INFINITY;

      // Worklet powers RMS / audio-level / silence-detection. When
      // retainPcmForWav is on, we also clone the PCM chunks for a later
      // WAV export (local-STT pipeline).
      this.workletNode.port.onmessage = (event: MessageEvent) => {
        if (!this.isRecording) return;

        const { type, data } = event.data;
        if (type !== 'audio') return;

        const inputData = data as Float32Array;

        if (this.options.retainPcmForWav) {
          // Clone — the underlying ArrayBuffer is reused by the worklet.
          this.pcmChunks.push(new Float32Array(inputData));
        }

        // Calculate RMS for audio level callback and silence detection
        const rms = this.calculateRMS(inputData);
        const now = Date.now();
        const recordingDuration = now - this.recordingStartTime;

        // Call audio level callback (normalized RMS, clamped to 0-1)
        // Multiply by ~3 to make typical speech levels more visible (raw RMS is often 0.01-0.1)
        if (this.onAudioLevel) {
          const normalizedLevel = Math.min(1, rms * 3);
          this.onAudioLevel(normalizedLevel);
        }

        // Silence detection (only if enabled)
        if (this.options.silenceDetectionEnabled) {
          // Periodic RMS logging for debugging
          if (now - lastRmsLogTime >= RMS_LOG_INTERVAL_MS) {
            lastRmsLogTime = now;
            const isSilent = rms < SILENCE_THRESHOLD;
            const silenceDuration = this.silenceStartTime ? now - this.silenceStartTime : 0;
            console.log(`[AudioRecorder] RMS: ${rms.toFixed(4)} | threshold: ${SILENCE_THRESHOLD} | silent: ${isSilent} | silenceDuration: ${silenceDuration}ms | recordingDuration: ${recordingDuration}ms`);
          }

          if (rms < SILENCE_THRESHOLD) {
            // Audio is silent
            if (this.silenceStartTime === null) {
              this.silenceStartTime = now;
              if (now - this.lastSilenceLogTime >= SILENCE_STATE_LOG_DEBOUNCE_MS) {
                console.log('[AudioRecorder] Silence started');
                this.lastSilenceLogTime = now;
              }
            } else {
              const silenceDuration = now - this.silenceStartTime;
              // Only auto-stop if we've recorded enough content (past MIN_RECORDING_MS)
              // and callback hasn't been fired yet
              const silenceThreshold = this.options.silenceDurationMs || DEFAULT_SILENCE_DURATION_MS;
              if (silenceDuration >= silenceThreshold && recordingDuration >= MIN_RECORDING_MS && !this.silenceStopFired) {
                console.log(`[AudioRecorder] Silence threshold reached (${silenceDuration}ms >= ${silenceThreshold}ms), triggering auto-stop`);
                this.silenceStopFired = true;
                if (this.onSilenceStop) {
                  this.onSilenceStop();
                }
              }
            }
          } else {
            // Audio is not silent, reset silence timer
            if (this.silenceStartTime !== null) {
              if (now - this.lastSoundLogTime >= SILENCE_STATE_LOG_DEBOUNCE_MS) {
                console.log('[AudioRecorder] Sound detected, resetting silence timer');
                this.lastSoundLogTime = now;
              }
            }
            this.silenceStartTime = null;
          }
        }
      };

      // Connect nodes: source -> worklet -> destination
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);

      this.isRecording = true;
      this.recordingStartTime = Date.now();
    } catch (error) {
      this.cleanup();
      if (error instanceof Error) {
        if (
          error.name === 'NotAllowedError' ||
          error.name === 'PermissionDeniedError'
        ) {
          throw new AudioRecordingError('Microphone permission denied');
        }
        if (
          error.name === 'NotFoundError' ||
          error.name === 'DevicesNotFoundError'
        ) {
          throw new AudioRecordingError('No microphone found');
        }
        throw new AudioRecordingError(`Failed to start recording: ${error.message}`);
      }
      throw new AudioRecordingError('Failed to start recording');
    }
  }

  /**
   * Stop recording and return the audio as base64-encoded WAV
   */
  async stop(): Promise<string> {
    if (!this.isRecording) {
      throw new AudioRecordingError('No recording in progress');
    }

    const recordingDuration = Date.now() - this.recordingStartTime;
    this.isRecording = false;

    // Validate recording duration
    if (recordingDuration < MIN_RECORDING_MS) {
      this.cleanup();
      throw new AudioRecordingError(
        `Recording too short (minimum ${MIN_RECORDING_MS}ms)`
      );
    }

    if (recordingDuration > MAX_RECORDING_MS) {
      this.cleanup();
      throw new AudioRecordingError(
        `Recording too long (maximum ${MAX_RECORDING_MS / 60000} minutes)`
      );
    }

    try {
      const recorder = this.mediaRecorder;
      if (!recorder) {
        throw new AudioRecordingError('MediaRecorder was not initialized');
      }

      // Wait for the recorder to flush its remaining buffer.
      const flushStart = performance.now();
      await new Promise<void>((resolve) => {
        const finish = () => {
          recorder.onstop = null;
          recorder.onerror = null;
          resolve();
        };
        recorder.onstop = finish;
        recorder.onerror = finish;
        if (recorder.state === 'inactive') {
          finish();
        } else {
          recorder.stop();
        }
      });
      const flushMs = performance.now() - flushStart;

      const encodeStart = performance.now();
      const blob = new Blob(this.recorderChunks, { type: this.recordedMimeType });
      const base64 = await blobToBase64(blob);
      const encodeMs = performance.now() - encodeStart;

      // Optional: build a 16 kHz WAV from accumulated PCM for the local-STT
      // pipeline. Skipped when retainPcmForWav was off — pcmChunks is empty.
      let wavMs = 0;
      if (this.options.retainPcmForWav && this.pcmChunks.length > 0) {
        const wavStart = performance.now();
        this.wavBase64 = buildWavBase64FromPcm(
          this.pcmChunks,
          this.originalSampleRate,
          TARGET_SAMPLE_RATE
        );
        wavMs = performance.now() - wavStart;
      }

      mainLog(
        `[Timing] recorder.stop: flush=${flushMs.toFixed(0)}ms, encode=${encodeMs.toFixed(0)}ms${wavMs ? `, wav=${wavMs.toFixed(0)}ms` : ''}, recDuration=${recordingDuration}ms, blobSize=${blob.size}B, base64=${base64.length}ch, mime=${this.recordedMimeType}`
      );

      return base64;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Returns the recorded audio as a base64-encoded 16 kHz mono PCM WAV,
   * or null if `retainPcmForWav` was off. Available after `stop()`.
   */
  getWavBase64(): string | null {
    return this.wavBase64;
  }

  /**
   * Mime type of the audio produced by the most recent recording, with
   * any `;codecs=...` suffix stripped — Gemini's audio sniffer keys on
   * the bare type.
   */
  getMimeType(): string {
    const semi = this.recordedMimeType.indexOf(';');
    return semi >= 0 ? this.recordedMimeType.slice(0, semi).trim() : this.recordedMimeType;
  }

  /**
   * Cancel recording without returning audio
   */
  cancel(): void {
    this.isRecording = false;
    this.cleanup();
  }

  /**
   * Check if currently recording
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get current recording duration in milliseconds
   */
  getRecordingDuration(): number {
    if (!this.isRecording) {
      return 0;
    }
    return Date.now() - this.recordingStartTime;
  }

  /**
   * Clean up all resources
   */
  private cleanup(): void {
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.onerror = null;
      if (this.mediaRecorder.state !== 'inactive') {
        try {
          this.mediaRecorder.stop();
        } catch {
          // ignore
        }
      }
      this.mediaRecorder = null;
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.recorderChunks = [];
    this.pcmChunks = [];
    this.silenceStartTime = null;
    this.silenceStopFired = false;
  }
}

// Forward a timing/diagnostic message to the main process log so it
// shows up in `~/Library/Logs/Nerd Dictum/main.log` (the place the
// user actually tails). Falls back to console.log in tests / non-Electron.
function mainLog(message: string): void {
  if (typeof window !== 'undefined' && window.electronAPI?.log) {
    window.electronAPI.log(message);
  } else {
    console.log(message);
  }
}

function buildWavBase64FromPcm(
  chunks: Float32Array[],
  fromSampleRate: number,
  toSampleRate: number
): string {
  // Concatenate chunks
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.length;
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // Linear-interpolation resample to target rate (e.g. 48k -> 16k).
  const resampled =
    fromSampleRate === toSampleRate ? merged : resampleLinear(merged, fromSampleRate, toSampleRate);

  // Float32 [-1, 1] -> int16
  const pcm16 = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    const sample = Math.max(-1, Math.min(1, resampled[i]));
    pcm16[i] = sample < 0 ? Math.trunc(sample * 32768) : Math.trunc(sample * 32767);
  }

  return encodeWavToBase64(pcm16, {
    sampleRate: toSampleRate,
    numChannels: CHANNELS,
    bitsPerSample: BITS_PER_SAMPLE,
  });
}

function resampleLinear(
  audioData: Float32Array,
  fromSampleRate: number,
  toSampleRate: number
): Float32Array {
  if (fromSampleRate === toSampleRate) return audioData;
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.round(audioData.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, audioData.length - 1);
    const fraction = srcIndex - srcFloor;
    result[i] = audioData[srcFloor] * (1 - fraction) + audioData[srcCeil] * fraction;
  }
  return result;
}

function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return 'audio/webm';
  }
  const supported = RECORDER_MIME_CANDIDATES.find((mime) =>
    MediaRecorder.isTypeSupported(mime)
  );
  return supported || 'audio/webm';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return a data URL'));
        return;
      }
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Export utility functions for testing
export { TARGET_SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE, MIN_RECORDING_MS, MAX_RECORDING_MS, SILENCE_THRESHOLD, DEFAULT_SILENCE_DURATION_MS, SILENCE_STATE_LOG_DEBOUNCE_MS };
