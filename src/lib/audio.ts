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

// Loudness measurement constants
// Digital silence has no decibel value (log of zero). Anything at or below
// this is treated as "as quiet as we bother to measure".
const DB_FLOOR = -100;
// The worklet posts one frame per render quantum (128 samples), so at 16 kHz
// this is roughly half a second of actual speech. Below that the percentiles
// are noise and we report nothing rather than a number that looks real.
const MIN_SPEECH_FRAMES_FOR_LOUDNESS = 60;
// Averaging lengths measured side by side, in milliseconds. A raw frame is
// ~8 ms, far too short: ordinary speech swings 13-16 dB between vowels and
// consonants, which would read as shouting. Shouting is sustained level, so
// the right window is the shortest one at which an ordinary phrase stops
// jumping around — that is what these candidates are here to find out.
const CANDIDATE_WINDOW_MS = [250, 500, 1000, 2000];
// Fewer windows than this and the percentiles describe nothing.
const MIN_WINDOWS_FOR_STATS = 4;

// Spectral tilt constants.
// Tilt is the slope of the log spectrum: how fast energy falls off as
// frequency rises. A calm voice falls off steeply; a strained one pushes
// energy upward and the slope flattens. Measured on this speaker, calm sat at
// -9.3 dB/kHz with a spread of only +-0.33, while deliberately angry
// recordings landed 1.5 to 2.5 dB/kHz higher — four to seven times the calm
// spread. That tiny spread is what makes it a better signal than loudness.
//
// Crucially it is a SLOPE, so a constant gain offset cancels out: a
// microphone that flattens level in hardware cannot flatten this.
const TILT_FFT_SIZE = 1024;
// 200 Hz skips the fundamental and room rumble; 6 kHz is the top of useful
// speech energy at a 16 kHz sample rate.
const TILT_MIN_HZ = 200;
const TILT_MAX_HZ = 6000;
// One spectrum per this many worklet frames (~8 ms each), i.e. about 30/s.
// Sampling every frame buys nothing: neighbouring 8 ms slices of the same
// vowel have almost the same spectrum.
const TILT_FRAME_STRIDE = 4;
// Below this many spectra the median is not worth reporting. Roughly half a
// second of speech; shorter than that the median is noise. Above it the
// scoring damps short recordings itself rather than refusing them.
const MIN_TILT_SAMPLES = 15;
// Rolling window for the live indicator, in spectra. At ~30 a second this is
// roughly two seconds of speech: long enough that one hard consonant cannot
// swing the colour, short enough that the speaker sees themselves getting
// louder while it is happening rather than afterwards.
const LIVE_TILT_WINDOW = 90;
// Start showing a colour once this many spectra exist, roughly a third of a
// second of speech, rather than waiting for a full window. The reading is
// damped for its own length (see liveTension), so an early one is cautious
// instead of wrong.
const LIVE_TILT_MIN_SAMPLES = 12;
// Emit at most this often, in spectra, so the indicator updates ~10 times a
// second instead of re-rendering on every measurement.
const LIVE_TILT_EMIT_EVERY = 3;
// Dumps every frame's level into the log. Superseded by saved recordings —
// the frame series now travels in the JSON sidecar next to the WAV, where it
// costs nothing and sits beside the audio it describes. Left here as a switch
// for when there is no capture marker and the log is all there is.
const DUMP_FRAME_SERIES = false;
// electron-log handles long lines, but a multi-megabyte one helps nobody.
const FRAME_SERIES_CHUNK = 400;

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
/** Rolling median spectral tilt during recording, in dB per kHz. */
export type VoiceTiltCallback = (
  rollingTiltDbPerKhz: number,
  windowSeconds: number
) => void;

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

/**
 * How loud one recording was, in dBFS (0 dB = full scale, everything is
 * negative). Only frames above SILENCE_THRESHOLD are counted, so pauses
 * between sentences don't drag the numbers down.
 *
 * Absolute values here are mic-dependent and mean little on their own. The
 * useful figures are differences: this recording's `medianDb` against the
 * speaker's usual level, and `spreadDb` inside a single recording.
 */
export interface LevelStats {
  /** Typical level. Median, so a cough can't move it. */
  medianDb: number;
  /** Loud end: the level exceeded 5% of the time. */
  peakDb: number;
  /** Quiet end: the level exceeded 75% of the time. */
  quietDb: number;
  /** peakDb − quietDb. */
  spreadDb: number;
  /** How many values the percentiles were taken over. */
  count: number;
}

export interface LoudnessStats {
  /**
   * Raw frames, one per render quantum (~8 ms at 16 kHz). `medianDb` here is a
   * stable, usable baseline. `spreadDb` is NOT a shouting signal: inside
   * ordinary speech vowels are loud and consonants quiet, which alone produces
   * 13–16 dB. Measured, not assumed.
   */
  frames: LevelStats;
  /**
   * Median slope of the log spectrum in dB per kHz, over 200-6000 Hz, across
   * the recording's speech. Less negative means a harsher, more strained
   * voice. Null when the recording held too few spectra to bother.
   */
  tiltDbPerKhz: number | null;
  /** How many spectra the tilt median was taken over. */
  tiltSamples: number;
  /**
   * The same speech averaged over windows of different lengths, keyed by
   * window duration in milliseconds. Longer windows average syllables away and
   * leave only sustained level — which is what shouting actually is. Which
   * length is right is an open question, so several are measured side by side.
   * A window length that didn't fit in the recording is absent.
   */
  windows: Record<number, LevelStats>;
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
  private onVoiceTilt: VoiceTiltCallback | null = null;
  private silenceStopFired: boolean = false;
  private options: AudioRecorderOptions;
  private lastSilenceLogTime: number = Number.NEGATIVE_INFINITY;
  private lastSoundLogTime: number = Number.NEGATIVE_INFINITY;
  // RMS of every frame loud enough to be speech. Silent frames are excluded so
  // pauses between sentences don't drag the recording's loudness down.
  private speechFrameRms: number[] = [];
  // How much audio one worklet frame covers. Derived from the device's real
  // sample rate on the first frame, because the rate we asked for is not
  // always the rate we get.
  private frameDurationMs: number = 0;
  private loudness: LoudnessStats | null = null;
  // Snapshotted at stop(), because cleanup() empties speechFrameRms in the
  // same call and callers read this afterwards.
  private speechSeconds: number = 0;
  private deviceLabel: string = '';
  // Spectral tilt is read off a parallel AnalyserNode rather than computed by
  // hand: the browser already has an optimised FFT, and a slope needs a real
  // spectrum, not the 128-sample frames the worklet delivers.
  private analyserNode: AnalyserNode | null = null;
  private spectrumDb: Float32Array<ArrayBuffer> | null = null;
  private tiltSamples: number[] = [];
  private speechFrameCounter: number = 0;

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
   * Set a callback for the rolling spectral tilt during recording — the live
   * "how harsh does this sound right now" reading. Fires about ten times a
   * second once enough spectra have accumulated, and not at all on a device
   * with no analyser.
   */
  setOnVoiceTilt(callback: VoiceTiltCallback | null): void {
    this.onVoiceTilt = callback;
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
        // Chromium turns auto gain control ON by default, which is precisely
        // what erases the signal the loudness detector reads: shouting gets
        // quietly turned down within a second or so. Ask for it off. The
        // browser may still refuse (some USB mics do gain in hardware), so
        // the actual state is logged from getSettings() below.
        autoGainControl: false,
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
          autoGainControl: trackSettings.autoGainControl,
        });
        // Surfaced to the main log because every loudness threshold downstream
        // is meaningless while AGC is on.
        this.deviceLabel = audioTrack.label;
        mainLog(
          `[Loudness] autoGainControl=${trackSettings.autoGainControl} (requested false) on "${audioTrack.label}"`
        );
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
      this.speechFrameRms = [];
      this.tiltSamples = [];
      this.speechFrameCounter = 0;
      this.frameDurationMs = 0;
      this.speechSeconds = 0;
      this.loudness = null;
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

        // Loudness measurement runs regardless of the silence-detection
        // setting — it feeds the "are you shouting" check, not auto-stop.
        if (this.frameDurationMs === 0 && inputData.length > 0 && this.originalSampleRate > 0) {
          this.frameDurationMs = (inputData.length / this.originalSampleRate) * 1000;
        }
        if (rms >= SILENCE_THRESHOLD) {
          this.speechFrameRms.push(rms);
          this.speechFrameCounter++;
          if (
            this.analyserNode &&
            this.spectrumDb &&
            this.speechFrameCounter % TILT_FRAME_STRIDE === 0
          ) {
            this.analyserNode.getFloatFrequencyData(this.spectrumDb);
            const tilt = spectralTilt(this.spectrumDb, this.originalSampleRate / TILT_FFT_SIZE);
            if (tilt !== null) {
              this.tiltSamples.push(tilt);
              this.emitLiveTilt();
            }
          }
        }

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

      // Parallel analyser for spectral tilt. Guarded because the injected test
      // AudioContext is a stub without the Web Audio analyser.
      if (typeof this.audioContext.createAnalyser === 'function') {
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = TILT_FFT_SIZE;
        // No smoothing: we take our own median over the recording, and the
        // node's default 0.8 would blur transitions into each other first.
        this.analyserNode.smoothingTimeConstant = 0;
        this.spectrumDb = new Float32Array(new ArrayBuffer(this.analyserNode.frequencyBinCount * 4));
        this.sourceNode.connect(this.analyserNode);
      }

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

    // Measure loudness before any early return below, so a rejected recording
    // still leaves numbers behind to look at.
    this.speechSeconds = (this.speechFrameRms.length * this.frameDurationMs) / 1000;
    this.loudness = computeLoudnessStats(
      this.speechFrameRms,
      this.frameDurationMs,
      this.tiltSamples
    );
    if (this.loudness) {
      const f = this.loudness.frames;
      mainLog(
        `[Loudness] frame(${this.frameDurationMs.toFixed(1)}ms) median=${f.medianDb.toFixed(1)}dB ` +
          `peak=${f.peakDb.toFixed(1)}dB quiet=${f.quietDb.toFixed(1)}dB ` +
          `spread=${f.spreadDb.toFixed(1)}dB n=${f.count} duration=${recordingDuration}ms`
      );
      const tilt = this.loudness.tiltDbPerKhz;
      mainLog(
        `[Tilt] ${tilt === null ? 'n/a' : `${tilt.toFixed(2)}dB/kHz`} ` +
          `from ${this.loudness.tiltSamples} spectra`
      );
      for (const windowMs of CANDIDATE_WINDOW_MS) {
        const w = this.loudness.windows[windowMs];
        if (!w) continue;
        mainLog(
          `[Loudness] win${windowMs}ms median=${w.medianDb.toFixed(1)}dB ` +
            `peak=${w.peakDb.toFixed(1)}dB quiet=${w.quietDb.toFixed(1)}dB ` +
            `spread=${w.spreadDb.toFixed(1)}dB n=${w.count}`
        );
      }
      if (DUMP_FRAME_SERIES) {
        const series = this.speechFrameRms.map((r) => rmsToDb(r).toFixed(1));
        const chunks = Math.ceil(series.length / FRAME_SERIES_CHUNK);
        const tag = `${this.recordingStartTime}`;
        for (let i = 0; i < chunks; i++) {
          const part = series.slice(i * FRAME_SERIES_CHUNK, (i + 1) * FRAME_SERIES_CHUNK);
          mainLog(`[LoudnessSeries] ${tag} ${i + 1}/${chunks} ${part.join(',')}`);
        }
      }
    }

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
   * Loudness of the most recent recording, or null if it held no speech.
   * Available after `stop()`.
   */
  getLoudnessStats(): LoudnessStats | null {
    return this.loudness;
  }

  /** Label of the microphone the last recording came from, e.g. "Default - AirWave". */
  getDeviceLabel(): string {
    return this.deviceLabel;
  }

  /**
   * Median tilt over the last couple of seconds, pushed to the live callback.
   * Silent until there are enough spectra for the median to mean anything.
   */
  private emitLiveTilt(): void {
    if (!this.onVoiceTilt) return;
    if (this.tiltSamples.length < LIVE_TILT_MIN_SAMPLES) return;
    if (this.tiltSamples.length % LIVE_TILT_EMIT_EVERY !== 0) return;
    const window = this.tiltSamples.slice(-LIVE_TILT_WINDOW);
    // Each spectrum covers TILT_FRAME_STRIDE worklet frames of speech.
    const windowSeconds = (window.length * TILT_FRAME_STRIDE * this.frameDurationMs) / 1000;
    this.onVoiceTilt(quantile(window, 0.5), windowSeconds);
  }

  /**
   * How many seconds of the last recording were actually speech — pauses
   * between sentences excluded. Zero before the first frame arrives.
   */
  getSpeechSeconds(): number {
    return this.speechSeconds;
  }

  /** Raw per-frame levels in dBFS of the last recording. Kept for offline analysis. */
  getFrameSeriesDb(): number[] {
    return this.speechFrameRms.map(rmsToDb);
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

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    this.spectrumDb = null;

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
    // `loudness` deliberately survives cleanup — callers read it after stop().
    this.speechFrameRms = [];
    this.tiltSamples = [];
    this.speechFrameCounter = 0;
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

/**
 * Amplitude to decibels. Silence would be -Infinity, so it is clamped to
 * DB_FLOOR — a number the callers can still do arithmetic on.
 */
export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(rms));
}

/**
 * Value below which `fraction` of the sorted samples fall (0 = smallest,
 * 1 = largest). Interpolates between neighbours.
 */
export function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = Math.min(Math.max(fraction, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Slope of a log-magnitude spectrum against frequency, in dB per kHz, fitted
 * by least squares over [minHz, maxHz].
 *
 * Because it is a slope, any constant gain applied to the whole spectrum
 * cancels out — which is the entire point: a microphone that levels loudness
 * in hardware still cannot hide a change in the shape of the spectrum.
 *
 * `spectrumDb[i]` is the level of the bin centred on `i * binHz`. Bins at
 * digital silence carry no information and are skipped; with fewer than three
 * usable bins there is no line to fit and the result is null.
 */
export function spectralTilt(
  spectrumDb: Float32Array | number[],
  binHz: number,
  minHz: number = TILT_MIN_HZ,
  maxHz: number = TILT_MAX_HZ
): number | null {
  if (binHz <= 0) return null;
  const first = Math.max(1, Math.ceil(minHz / binHz));
  const last = Math.min(spectrumDb.length - 1, Math.floor(maxHz / binHz));
  if (last - first < 2) return null;

  let n = 0;
  let sumF = 0;
  let sumD = 0;
  for (let i = first; i <= last; i++) {
    const d = spectrumDb[i];
    if (!Number.isFinite(d)) continue;
    n++;
    sumF += (i * binHz) / 1000;
    sumD += d;
  }
  if (n < 3) return null;

  const meanF = sumF / n;
  const meanD = sumD / n;
  let num = 0;
  let den = 0;
  for (let i = first; i <= last; i++) {
    const d = spectrumDb[i];
    if (!Number.isFinite(d)) continue;
    const fc = (i * binHz) / 1000 - meanF;
    num += fc * (d - meanD);
    den += fc * fc;
  }
  if (den === 0) return null;
  return num / den;
}

/** Percentile summary of a list of amplitudes. */
export function summariseLevels(rmsValues: number[]): LevelStats {
  const db = rmsValues.map(rmsToDb);
  const medianDb = quantile(db, 0.5);
  const peakDb = quantile(db, 0.95);
  const quietDb = quantile(db, 0.25);
  return { medianDb, peakDb, quietDb, spreadDb: peakDb - quietDb, count: db.length };
}

/**
 * Chunk consecutive frames into windows and return each window's RMS.
 *
 * Energy is what averages correctly, not amplitude, so the mean is taken over
 * the squares and the square root applied at the end. A trailing chunk shorter
 * than the window is dropped — a partial window reads quieter than it was.
 */
export function windowRms(frameRms: number[], framesPerWindow: number): number[] {
  if (framesPerWindow < 1) return [];
  const out: number[] = [];
  for (let start = 0; start + framesPerWindow <= frameRms.length; start += framesPerWindow) {
    let energy = 0;
    for (let i = start; i < start + framesPerWindow; i++) {
      energy += frameRms[i] * frameRms[i];
    }
    out.push(Math.sqrt(energy / framesPerWindow));
  }
  return out;
}

/**
 * Summarise a recording's speech frames, both raw and averaged over each
 * candidate window length. Returns null when there was too little speech to
 * say anything — a recording of pure silence has no loudness.
 *
 * `frameDurationMs` is how much audio one frame covers; it comes from the
 * device's actual sample rate, which is not always the one we asked for.
 */
export function computeLoudnessStats(
  speechFrameRms: number[],
  frameDurationMs: number,
  tiltSamples: number[] = []
): LoudnessStats | null {
  if (speechFrameRms.length < MIN_SPEECH_FRAMES_FOR_LOUDNESS) return null;

  const windows: Record<number, LevelStats> = {};
  if (frameDurationMs > 0) {
    for (const windowMs of CANDIDATE_WINDOW_MS) {
      const framesPerWindow = Math.max(1, Math.round(windowMs / frameDurationMs));
      const levels = windowRms(speechFrameRms, framesPerWindow);
      // Percentiles over one or two windows are theatre, not measurement.
      if (levels.length >= MIN_WINDOWS_FOR_STATS) {
        windows[windowMs] = summariseLevels(levels);
      }
    }
  }

  return {
    frames: summariseLevels(speechFrameRms),
    tiltDbPerKhz:
      tiltSamples.length >= MIN_TILT_SAMPLES ? quantile(tiltSamples, 0.5) : null,
    tiltSamples: tiltSamples.length,
    windows,
  };
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
export { TARGET_SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE, MIN_RECORDING_MS, MAX_RECORDING_MS, SILENCE_THRESHOLD, DEFAULT_SILENCE_DURATION_MS, SILENCE_STATE_LOG_DEBOUNCE_MS, DB_FLOOR, MIN_SPEECH_FRAMES_FOR_LOUDNESS };
