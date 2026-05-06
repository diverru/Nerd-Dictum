/**
 * openWakeWord pipeline running continuously in the main process.
 *
 * Mirrors the streaming logic from openwakeword/utils.py
 * (https://github.com/dscripka/openWakeWord) precisely:
 *
 *   For every 1280-sample (80 ms @ 16 kHz) audio chunk:
 *     - Mel spec is computed on the last 1760 samples (1280 + 480 sample
 *       lookback for the FFT window).
 *     - Resulting mel frames are appended to a rolling 970-row mel buffer.
 *     - One new 96-dim embedding is computed from the last 76 mel rows
 *       (sliding window with stride 8).
 *     - Embeddings are appended to a rolling 120-row feature buffer.
 *     - If 16+ embeddings exist, the wake-word classifier is run on the
 *       last 16 → probability ∈ [0,1].
 *
 * On `probability > threshold` (with cooldown), `onDetect` fires.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import * as ort from 'onnxruntime-node';
import { PvRecorder } from '@picovoice/pvrecorder-node';

// Built-in keyword name -> filename in assets/wake-word/.
const BUILTIN_KEYWORDS: Record<string, string> = {
  hey_jarvis: 'hey_jarvis_v0.1.onnx',
  alexa: 'alexa_v0.1.onnx',
  hey_mycroft: 'hey_mycroft_v0.1.onnx',
};

export interface WakeWordOptions {
  keyword: string;
  threshold?: number;
  cooldownMs?: number;
  onDetect: (info: { keyword: string; probability: number }) => void;
  onError?: (error: Error) => void;
  onLog?: (message: string) => void;
}

const FRAME_LENGTH = 1280; // 80 ms @ 16 kHz — one PvRecorder read
const MEL_LOOKBACK = 480; // 160 * 3 — see openwakeword/utils.py
const MEL_INPUT_LENGTH = FRAME_LENGTH + MEL_LOOKBACK; // 1760 samples
const MEL_FEATURES = 32;
const MEL_BUFFER_MAX = 970; // ~10 s of mel history (frames at 100 fps)
const MEL_WINDOW_SIZE = 76; // window size for the embedding model
const EMBEDDING_DIM = 96;
const EMB_BUFFER_MAX = 120; // ~10 s of embedding history (12.5 fps)
const EMB_WINDOW_SIZE = 16; // window size for the wake-word classifier
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_COOLDOWN_MS = 1500;

let melSession: ort.InferenceSession | null = null;
let embSession: ort.InferenceSession | null = null;
let wakeSession: ort.InferenceSession | null = null;
let recorder: PvRecorder | null = null;
let running = false;

function builtinModelsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'wake-word');
  }
  return path.join(app.getAppPath(), 'assets', 'wake-word');
}

export function customModelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'wake-words');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore — startWakeWord will surface the real error if the dir is missing
    }
  }
  return dir;
}

/**
 * Resolve a keyword name to an absolute path:
 *   1. If it matches a built-in, return assets/wake-word/<file>.onnx
 *   2. Else look up <name>.onnx in the custom dir
 */
function resolveKeywordPath(keyword: string): string | null {
  const builtinFile = BUILTIN_KEYWORDS[keyword];
  if (builtinFile) {
    const p = path.join(builtinModelsDir(), builtinFile);
    if (fs.existsSync(p)) return p;
  }
  const customPath = path.join(customModelsDir(), `${keyword}.onnx`);
  if (fs.existsSync(customPath)) return customPath;
  return null;
}

/**
 * Returns the list of available wake-word models for the settings UI.
 *   - All 3 built-ins (always)
 *   - Every *.onnx file dropped in <userData>/wake-words/
 */
export function listAvailableModels(): Array<{ name: string; label: string; isBuiltin: boolean }> {
  const result: Array<{ name: string; label: string; isBuiltin: boolean }> = [
    { name: 'hey_jarvis', label: 'Hey Jarvis (built-in)', isBuiltin: true },
    { name: 'alexa', label: 'Alexa (built-in)', isBuiltin: true },
    { name: 'hey_mycroft', label: 'Hey Mycroft (built-in)', isBuiltin: true },
  ];
  const dir = customModelsDir();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (file.toLowerCase().endsWith('.onnx')) {
        const name = file.slice(0, -'.onnx'.length);
        result.push({ name, label: `${name} (custom)`, isBuiltin: false });
      }
    }
  } catch {
    // dir missing — already handled by customModelsDir
  }
  return result;
}

export async function startWakeWord(options: WakeWordOptions): Promise<boolean> {
  if (running) {
    await stopWakeWord();
  }

  const builtinDir = builtinModelsDir();
  const wakePath = resolveKeywordPath(options.keyword);
  const log = options.onLog ?? (() => {});

  if (!wakePath) {
    const err = new Error(
      `Wake-word model "${options.keyword}" not found. Looked in built-ins ` +
        `and ${customModelsDir()}.`
    );
    options.onError?.(err);
    log(`[WakeWord] ${err.message}`);
    return false;
  }

  try {
    log(`[WakeWord] Loading mel/embedding from ${builtinDir}, wake-word from ${wakePath}`);
    melSession = await ort.InferenceSession.create(
      path.join(builtinDir, 'melspectrogram.onnx')
    );
    embSession = await ort.InferenceSession.create(
      path.join(builtinDir, 'embedding_model.onnx')
    );
    wakeSession = await ort.InferenceSession.create(wakePath);
    log(
      `[WakeWord] Loaded. mel.in=${melSession.inputNames}, mel.out=${melSession.outputNames}, ` +
        `emb.in=${embSession.inputNames}, emb.out=${embSession.outputNames}, ` +
        `wake.in=${wakeSession.inputNames}, wake.out=${wakeSession.outputNames}`
    );
  } catch (error) {
    options.onError?.(error as Error);
    melSession = embSession = wakeSession = null;
    return false;
  }

  try {
    recorder = new PvRecorder(FRAME_LENGTH, -1);
    recorder.start();
    const selected = recorder.getSelectedDevice();
    const all = PvRecorder.getAvailableDevices();
    log(`[WakeWord] Recorder started (frame=${FRAME_LENGTH} @ 16kHz, mic="${selected}")`);
    log(`[WakeWord] Available mics: ${all.map((d, i) => `${i}:${d}`).join(' | ')}`);
  } catch (error) {
    options.onError?.(error as Error);
    melSession = embSession = wakeSession = null;
    return false;
  }

  running = true;
  void runDetectionLoop(options, log);
  return true;
}

async function runDetectionLoop(
  options: WakeWordOptions,
  log: (message: string) => void
): Promise<void> {
  if (!recorder || !melSession || !embSession || !wakeSession) return;

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const melInputName = melSession.inputNames[0];
  const melOutputName = melSession.outputNames[0];
  const embInputName = embSession.inputNames[0];
  const embOutputName = embSession.outputNames[0];
  const wakeInputName = wakeSession.inputNames[0];
  const wakeOutputName = wakeSession.outputNames[0];

  // Rolling raw-audio context (capped to MEL_INPUT_LENGTH between calls).
  let audioBuffer: number[] = [];
  // Mel buffer: each row = 32 mel features.
  const melBuffer: Float32Array[] = [];
  // Embedding buffer: each row = 96-dim embedding.
  const embBuffer: Float32Array[] = [];

  let lastDetectionTime = 0;
  let warmupAnnounced = false;

  // Rolling diagnostics window (last ~5s)
  const recentProbs: number[] = []; // wake prob history
  const RECENT_PROB_LEN = 16; // ~1.3 s of predictions; for peak-of-N trigger
  let topProb = 0;
  let lastHeartbeat = Date.now();
  let framesSinceHeartbeat = 0;
  let peakAudioAbs = 0;
  let sumAudioRms = 0;
  let aboveThresholdCount = 0;

  while (running && recorder) {
    let frame: Int16Array;
    try {
      frame = await recorder.read();
    } catch (error) {
      log(`[WakeWord] recorder.read failed: ${(error as Error).message}`);
      break;
    }

    // 1. Append fresh int16 samples to the audio context buffer + diag stats.
    let frameSqSum = 0;
    let framePeak = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      audioBuffer.push(v);
      const abs = v < 0 ? -v : v;
      if (abs > framePeak) framePeak = abs;
      frameSqSum += v * v;
    }
    const frameRms = Math.sqrt(frameSqSum / frame.length);
    if (framePeak > peakAudioAbs) peakAudioAbs = framePeak;
    sumAudioRms += frameRms;
    framesSinceHeartbeat++;

    // 2. Need at least 1760 samples (1280 + 480 lookback) before first mel call.
    if (audioBuffer.length < MEL_INPUT_LENGTH) continue;

    // 3. Mel spec on the most recent 1760 samples.
    //    Raw int16 cast to float32 (NOT normalised) — the mel model handles scaling.
    const melInputData = new Float32Array(MEL_INPUT_LENGTH);
    const audioStart = audioBuffer.length - MEL_INPUT_LENGTH;
    for (let i = 0; i < MEL_INPUT_LENGTH; i++) {
      melInputData[i] = audioBuffer[audioStart + i];
    }
    // Trim audio buffer to keep just the lookback for next iteration.
    audioBuffer = audioBuffer.slice(-MEL_INPUT_LENGTH);

    let melTensor: ort.Tensor;
    try {
      const melInput = new ort.Tensor('float32', melInputData, [1, MEL_INPUT_LENGTH]);
      const melOut = await melSession.run({ [melInputName]: melInput });
      melTensor = melOut[melOutputName];
    } catch (error) {
      log(`[WakeWord] mel inference failed: ${(error as Error).message}`);
      break;
    }

    const melArr = melTensor.data as Float32Array;
    const melDims = melTensor.dims;
    // Expected shape variants: [1,1,T,32] or [1,T,32]
    const newMelFrames =
      melDims.length >= 2
        ? melDims[melDims.length - 2]
        : Math.floor(melArr.length / MEL_FEATURES);
    for (let t = 0; t < newMelFrames; t++) {
      const row = new Float32Array(MEL_FEATURES);
      for (let f = 0; f < MEL_FEATURES; f++) {
        // Normalisation as in openwakeword/utils.py: value/10 + 2
        row[f] = melArr[t * MEL_FEATURES + f] / 10 + 2;
      }
      melBuffer.push(row);
      if (melBuffer.length > MEL_BUFFER_MAX) melBuffer.shift();
    }

    // 4. Compute one new embedding from the last 76 mel rows.
    if (melBuffer.length < MEL_WINDOW_SIZE) continue;

    const melWindowData = new Float32Array(MEL_WINDOW_SIZE * MEL_FEATURES);
    const melStart = melBuffer.length - MEL_WINDOW_SIZE;
    for (let t = 0; t < MEL_WINDOW_SIZE; t++) {
      const row = melBuffer[melStart + t];
      for (let f = 0; f < MEL_FEATURES; f++) {
        melWindowData[t * MEL_FEATURES + f] = row[f];
      }
    }

    let embTensor: ort.Tensor;
    try {
      const embInput = new ort.Tensor('float32', melWindowData, [
        1,
        MEL_WINDOW_SIZE,
        MEL_FEATURES,
        1,
      ]);
      const embOut = await embSession.run({ [embInputName]: embInput });
      embTensor = embOut[embOutputName];
    } catch (error) {
      log(`[WakeWord] embedding inference failed: ${(error as Error).message}`);
      break;
    }

    const embData = embTensor.data as Float32Array;
    const embedding = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) embedding[i] = embData[i];
    embBuffer.push(embedding);
    if (embBuffer.length > EMB_BUFFER_MAX) embBuffer.shift();

    // 5. Need 16 embeddings (~1.28 s of context) before first wake prediction.
    if (embBuffer.length < EMB_WINDOW_SIZE) continue;
    if (!warmupAnnounced) {
      log('[WakeWord] Warmup complete, classifier active');
      warmupAnnounced = true;
    }

    const wakeInputData = new Float32Array(EMB_WINDOW_SIZE * EMBEDDING_DIM);
    const embStart = embBuffer.length - EMB_WINDOW_SIZE;
    for (let t = 0; t < EMB_WINDOW_SIZE; t++) {
      const row = embBuffer[embStart + t];
      for (let f = 0; f < EMBEDDING_DIM; f++) {
        wakeInputData[t * EMBEDDING_DIM + f] = row[f];
      }
    }

    let prob = 0;
    try {
      const wakeInput = new ort.Tensor('float32', wakeInputData, [
        1,
        EMB_WINDOW_SIZE,
        EMBEDDING_DIM,
      ]);
      const wakeOut = await wakeSession.run({ [wakeInputName]: wakeInput });
      prob = (wakeOut[wakeOutputName].data as Float32Array)[0];
    } catch (error) {
      log(`[WakeWord] wake inference failed: ${(error as Error).message}`);
      break;
    }

    if (prob > topProb) topProb = prob;
    if (prob > threshold * 0.5) aboveThresholdCount++;
    recentProbs.push(prob);
    if (recentProbs.length > RECENT_PROB_LEN) recentProbs.shift();

    // Trigger on peak-of-recent-frames rather than a single frame — wake-word
    // predictions are noisy; one good utterance produces 2-5 frames in a row
    // above threshold but a single frame may dip below.
    let recentPeak = 0;
    for (const p of recentProbs) if (p > recentPeak) recentPeak = p;

    const now = Date.now();
    if (now - lastHeartbeat > 5000) {
      // Only log when peakProb cleared a sane noise floor — there's no signal
      // in dumping a heartbeat every 5 s when the room is quiet. The floor is
      // the lower of the user's detection threshold and a hard 0.05 minimum,
      // so an aggressively low threshold still gets observable logs.
      const heartbeatFloor = Math.min(threshold, 0.05);
      if (topProb >= heartbeatFloor) {
        const avgRms = framesSinceHeartbeat > 0 ? sumAudioRms / framesSinceHeartbeat : 0;
        log(
          `[WakeWord] heartbeat: peakProb=${topProb.toFixed(3)}, framesAbove50%=${aboveThresholdCount}, ` +
            `audioPeak=${peakAudioAbs}, audioRms=${avgRms.toFixed(0)}, mel=${melBuffer.length}/${MEL_BUFFER_MAX}, emb=${embBuffer.length}/${EMB_BUFFER_MAX}`
        );
      }
      topProb = 0;
      peakAudioAbs = 0;
      sumAudioRms = 0;
      framesSinceHeartbeat = 0;
      aboveThresholdCount = 0;
      lastHeartbeat = now;
    }

    if (recentPeak > threshold && now - lastDetectionTime > cooldownMs) {
      lastDetectionTime = now;
      log(`[WakeWord] DETECTED ${options.keyword} (peak=${recentPeak.toFixed(3)} over last ${recentProbs.length} frames, current=${prob.toFixed(3)})`);
      try {
        options.onDetect({ keyword: options.keyword, probability: recentPeak });
      } catch (error) {
        log(`[WakeWord] onDetect handler threw: ${(error as Error).message}`);
      }
    }
  }
}

export async function stopWakeWord(): Promise<void> {
  running = false;
  if (recorder) {
    try {
      recorder.stop();
    } catch {
      // ignore
    }
    try {
      recorder.release();
    } catch {
      // ignore
    }
    recorder = null;
  }
  melSession = null;
  embSession = null;
  wakeSession = null;
}

export function isWakeWordRunning(): boolean {
  return running;
}
