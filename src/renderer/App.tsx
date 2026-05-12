import { useState, useRef, useEffect, useCallback } from 'react';
import './styles/App.css';
import { AudioRecorder, AudioRecorderOptions, DEFAULT_SILENCE_DURATION_MS } from '../lib/audio';
import { transcribeAudio, TranscribeOptions, TranscriptionCancelledError } from '../lib/gemini';
import { classifyError, ClassifiedError } from '../lib/errors';
import { playStartSound, playSuccessSound, playErrorSound } from '../lib/sounds';
import { SettingsButton } from './components/Settings';
import { InfoButton } from './components/InfoButton';
import { HideButton } from './components/HideButton';
import { StatsButton } from './components/StatsButton';
import { AudioLevelRing } from './components/AudioLevelRing';
import type { AppSettings } from './types/electron';

const MESSAGE_TIMEOUT_MS = 2000;
const RETRY_MESSAGE_TIMEOUT_MS = 4000;
const SUCCESS_STATE_TIMEOUT_MS = 5000;
// Recordings shorter than this are treated as no-speech without round-tripping
// to Gemini — prevents the model from hallucinating a transcript out of very
// short / mostly-silent audio.
const MIN_TRANSCRIBE_DURATION_MS = 1000;
// Keywords baked into the default prompt — used by the renderer to detect
// when Gemini hallucinated one of them as the whole transcript for silent audio.
const DEFAULT_KEYWORD_TERMS = ['CLAUDE.md', 'Cloud MD', 'WIX', 'vix'];

// Generic English filler phrases that an offline STT (Parakeet) or the LLM
// polish step produces when the audio was effectively silent. We treat
// these as no-speech, with or without trailing punctuation.
const SILENCE_HALLUCINATION_PHRASES = [
  'thank you',
  'thanks',
  'bye',
  'goodbye',
  'hello',
  'okay',
  'ok',
  'mhm',
];

function isSilenceHallucination(value: string): boolean {
  // Strip trailing punctuation/whitespace, lowercase, and compare against
  // the known-bad list. Anything 1-2 word English filler in an otherwise
  // empty utterance is almost always a hallucination, never the user.
  const normalised = value.toLowerCase().replace(/[.!?,\s]+$/g, '').trim();
  return SILENCE_HALLUCINATION_PHRASES.includes(normalised);
}

function collectKeywordTerms(customKeywords: string | undefined): string[] {
  const terms = new Set<string>(DEFAULT_KEYWORD_TERMS);
  if (customKeywords) {
    for (const rawLine of customKeywords.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const delimiterMatch = line.match(/(=>|->|=)/);
      if (!delimiterMatch || delimiterMatch.index === undefined) {
        terms.add(line);
        continue;
      }
      const left = line.slice(0, delimiterMatch.index).trim();
      const right = line.slice(delimiterMatch.index + delimiterMatch[0].length).trim();
      if (left) terms.add(left);
      if (right) {
        for (const alias of right.split(/[,;|]/).map((a) => a.trim()).filter(Boolean)) {
          terms.add(alias);
        }
      }
    }
  }
  return [...terms];
}

// Audio level smoothing
const AUDIO_LEVEL_LERP_UP = 0.8;   // Very fast rise

// Format Electron accelerator to compact symbol form for hint display
function formatHotkeyCompact(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl\+/g, '⌘')
    .replace(/Command\+/g, '⌘')
    .replace(/Control\+/g, '⌃')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧')
    .replace(/\+/g, '');
}

function buildTranscribeOptions(settings: AppSettings, previousTranscripts?: string[]): TranscribeOptions {
  const options: TranscribeOptions = {};
  if (settings.languages && settings.languages.length > 0) {
    options.languages = settings.languages;
  }
  if (settings.speechDomain) {
    options.speechDomain = settings.speechDomain;
  }
  if (settings.customDomainHint) {
    options.customDomainHint = settings.customDomainHint;
  }
  if (settings.customKeywords) {
    options.customKeywords = settings.customKeywords;
  }
  options.clarificationEnabled = settings.clarificationEnabled ?? true;
  // Add previous transcripts as context if enabled and available
  if ((settings.previousTranscriptContextEnabled ?? true) && previousTranscripts && previousTranscripts.length > 0) {
    options.previousTranscripts = previousTranscripts;
  }
  return options;
}

function buildRecorderOptions(settings: AppSettings): AudioRecorderOptions {
  return {
    deviceId: settings.microphoneDeviceId || undefined,
    silenceDetectionEnabled: settings.silenceDetectionEnabled ?? true,
    silenceDurationMs: settings.silenceDurationMs || DEFAULT_SILENCE_DURATION_MS,
    // Local-Parakeet pipelines need a 16 kHz mono WAV. Keep PCM around so
    // recorder.getWavBase64() can produce one after stop().
    retainPcmForWav:
      settings.transcriptionMode === 'local-then-gemini' ||
      settings.transcriptionMode === 'local-only',
  };
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
};

type AppState = 'idle' | 'recording' | 'transcribing' | 'success';
type MessageType = 'success' | 'error';

interface FlashMessage {
  text: string;
  type: MessageType;
  isRetryable: boolean;
  hasErrorDetail: boolean;
}

export function App() {
  const [state, setState] = useState<AppState>('idle');
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [appVersion, setAppVersion] = useState<string>('');
  const [hotkey, setHotkey] = useState<string>('CommandOrControl+Shift+R');
  const [isDragOver, setIsDragOver] = useState(false);
  const audioLevelRef = useRef<number>(0); // For lerp smoothing
  const recorderRef = useRef<AudioRecorder | null>(null);
  const lastAudioRef = useRef<string | null>(null);
  // Held alongside lastAudioRef so the retry path declares the recorder's
  // real MIME (opus) instead of falling back to audio/wav.
  const lastAudioMimeTypeRef = useRef<string | undefined>(undefined);
  const lastRecordingDurationRef = useRef<number>(0); // For stats tracking
  const recordingStartTimeRef = useRef<number>(0); // For tracking recording duration
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const transcribeRequestIdRef = useRef(0);
  // While true, the hold-to-record key is still pressed — silence-detection
  // must not auto-stop recording.
  const isHoldKeyDownRef = useRef(false);
  // True when the in-flight transcription was started by the wake-word
  // detector. We use this to send Enter after auto-paste so the hands-free
  // flow fully submits without keyboard interaction.
  const wakeWordTriggeredRef = useRef(false);

  const showMessage = useCallback((text: string, type: MessageType = 'success', isRetryable = false, hasErrorDetail = false) => {
    // Clear any existing timeout
    if (messageTimeoutRef.current) {
      clearTimeout(messageTimeoutRef.current);
    }
    setMessage({ text, type, isRetryable, hasErrorDetail });
    // Error messages with retry or detail stay longer
    const duration = type === 'error' && (isRetryable || hasErrorDetail) ? RETRY_MESSAGE_TIMEOUT_MS : MESSAGE_TIMEOUT_MS;
    messageTimeoutRef.current = setTimeout(() => setMessage(null), duration);
  }, []);

  const lastErrorDetailRef = useRef<{ message: string; statusCode?: number; responseBody?: string } | null>(null);

  const showError = useCallback((error: unknown) => {
    const classified: ClassifiedError = classifyError(error);
    const hasDetail = Boolean(classified.responseBody);
    if (hasDetail) {
      lastErrorDetailRef.current = {
        message: classified.message,
        statusCode: classified.statusCode,
        responseBody: classified.responseBody,
      };
    } else {
      lastErrorDetailRef.current = null;
    }
    showMessage(classified.message, 'error', classified.isRetryable, hasDetail);
    return classified;
  }, [showMessage]);

  const transcribeWithRetry = useCallback(async (audioBase64: string, mimeType?: string, wavBase64?: string) => {
    // Increment first, atomically determine our ID
    transcribeRequestIdRef.current += 1;
    const requestId = transcribeRequestIdRef.current;

    // Cancel any existing transcription before starting new one
    if (transcribeAbortRef.current) {
      transcribeAbortRef.current.abort();
    }

    setState('transcribing');
    const controller = new AbortController();
    transcribeAbortRef.current = controller;

    // Track soundEnabled for use in both success and error paths
    let soundEnabled = true;

    try {
      // Get settings from main process
      const settings = await window.electronAPI.getSettings();
      soundEnabled = settings.soundEnabled ?? true;

      if (requestId !== transcribeRequestIdRef.current) {
        return;
      }

      // local-only doesn't talk to any LLM, so no API key is required. For
      // `local-then-gemini` the relevant key is the *polish* provider's key
      // (which may be Gemini, OpenAI, Anthropic, …); for direct `gemini`
      // mode it's the Gemini key. We only check that *some* key the
      // upcoming pipeline needs exists.
      const polishProvider = settings.polishProvider || 'google';
      const polishKeyForMode =
        settings.transcriptionMode === 'local-then-gemini'
          ? (polishProvider === 'google'
              ? settings.apiKey
              : settings.providerConfigs?.[polishProvider]?.apiKey ?? '')
          : settings.apiKey;
      if (!polishKeyForMode && settings.transcriptionMode !== 'local-only') {
        showMessage('Set API key in settings', 'error', true);
        window.electronAPI.openSettingsWindow();
        // Save audio for retry after setting API key
        lastAudioRef.current = audioBase64;
        lastAudioMimeTypeRef.current = mimeType;
        setState('idle');
        return;
      }

      // Get previous transcripts for context if enabled
      let previousTranscripts: string[] = [];
      if (settings.previousTranscriptContextEnabled ?? true) {
        previousTranscripts = await window.electronAPI.getRecentTranscripts();
      }

      const options = buildTranscribeOptions(settings, previousTranscripts);
      let transcript: string;
      if (
        settings.transcriptionMode === 'local-then-gemini' ||
        settings.transcriptionMode === 'local-only'
      ) {
        if (!wavBase64) {
          throw new Error(`${settings.transcriptionMode} mode requires WAV audio (retainPcmForWav)`);
        }
        if (!window.electronAPI.transcribeLocalStt) {
          throw new Error('Local STT IPC not available');
        }
        const localResult = await window.electronAPI.transcribeLocalStt(wavBase64);
        if (!localResult.ok) {
          throw new Error(`Local STT failed: ${localResult.error}`);
        }
        if (settings.transcriptionMode === 'local-only') {
          transcript = localResult.text;
        } else {
          // Polish via the user-selected provider (default: google).
          const provider = settings.polishProvider || 'google';
          const polishConfig = provider === 'google'
            ? { apiKey: settings.apiKey, model: settings.model }
            : settings.providerConfigs?.[provider] ?? { apiKey: '', model: '' };
          if (!polishConfig.apiKey) {
            throw new Error(`Polish provider "${provider}" has no API key set`);
          }
          if (!polishConfig.model) {
            throw new Error(`Polish provider "${provider}" has no model selected`);
          }
          if (!window.electronAPI.polishText) {
            throw new Error('Polish IPC not available');
          }
          const polishResult = await window.electronAPI.polishText(
            provider,
            polishConfig.apiKey,
            polishConfig.model,
            localResult.text,
            {
              languages: options.languages,
              customKeywords: options.customKeywords,
              previousTranscripts: options.previousTranscripts,
            },
          );
          if (!polishResult.ok) {
            throw new Error(`Polish failed: ${polishResult.error}`);
          }
          transcript = polishResult.text;
        }
      } else {
        transcript = await transcribeAudio(audioBase64, settings.apiKey, settings.model, {
          ...options,
          signal: controller.signal,
          ...(mimeType && { mimeType }),
        });
      }

      if (requestId !== transcribeRequestIdRef.current) {
        return;
      }

      console.log('[Transcript]', transcript);

      const trimmed = transcript.trim();
      // Treat as "no speech" when one of these holds:
      //   1. Truly empty / whitespace.
      //   2. Echoes a recent transcript verbatim — silent audio + a
      //      previous_transcripts context block makes Gemini fall back to
      //      repeating one of them.
      //   3. Hallucinated a single keyword from the prompt's correction
      //      dictionary — model picks a term it saw in the prompt when
      //      there's nothing to transcribe.
      //   4. A known generic English filler phrase ("Thank you.", "Bye.",
      //      etc.) — both Parakeet and the LLM polish are prone to
      //      spitting one of these out for silent audio.
      const echoesPrevious = trimmed.length > 0 && previousTranscripts.some(
        (prev) => prev.trim() === trimmed
      );
      const keywordTerms = collectKeywordTerms(settings.customKeywords);
      const echoesKeyword = trimmed.length > 0 && keywordTerms.some(
        (term) => term.toLowerCase() === trimmed.toLowerCase()
      );
      const isHallucination = trimmed.length > 0 && isSilenceHallucination(trimmed);
      if (trimmed.length === 0 || echoesPrevious || echoesKeyword || isHallucination) {
        if (echoesPrevious || echoesKeyword || isHallucination) {
          console.warn(
            `[Transcribe] Treating as empty (likely hallucination). echoesPrevious=${echoesPrevious}, echoesKeyword=${echoesKeyword}, isHallucination=${isHallucination}, value="${trimmed}"`
          );
        }
        showMessage('No speech detected', 'error', false);
        window.electronAPI.trackEvent('transcription_empty', {
          echoed_previous: echoesPrevious ? 1 : 0,
          echoed_keyword: echoesKeyword ? 1 : 0,
          hallucination: isHallucination ? 1 : 0,
        });
        if (soundEnabled) {
          playErrorSound();
        }
        lastAudioRef.current = null;
        lastAudioMimeTypeRef.current = undefined;
        // Hands-free flow aborted: don't carry the flag into the next session.
        wakeWordTriggeredRef.current = false;
        setState('idle');
        return;
      }

      // Copy to clipboard
      // autoPaste=true: dispatch ⌘V into the focused window so the
      // transcript appears at the cursor without keyboard interaction.
      // When this transcription was started by the wake-word detector AND
      // the user enabled `wakeWordPressEnter`, also press Enter so the
      // chat / form / prompt is submitted hands-free. Both keystrokes are
      // dispatched by main in a single osascript so V definitely lands
      // before Enter.
      const submitOnPaste =
        wakeWordTriggeredRef.current && (settings.wakeWordPressEnter ?? true);
      // Consume the wake-word flag so the next manual recording doesn't
      // inherit the auto-Enter behaviour.
      wakeWordTriggeredRef.current = false;
      // copyToClipboard now resolves only after the V keystroke has been
      // dispatched, so the success state below lights up only after the
      // paste actually lands in the target window.
      await window.electronAPI.copyToClipboard(transcript, true, submitOnPaste);
      if (requestId !== transcribeRequestIdRef.current) {
        return;
      }

      // Flip to success immediately. Side effects (sound, stats, analytics)
      // run in the background and must not delay the OK indicator.
      setState('success');
      showMessage('Copied to clipboard', 'success');
      if (soundEnabled) {
        playSuccessSound();
      }
      void window.electronAPI.trackEvent('transcription_success', { transcript_length: transcript.length });
      void window.electronAPI.recordTranscriptionStats(transcript, lastRecordingDurationRef.current);

      // Clear saved audio on success
      lastAudioRef.current = null;
      lastAudioMimeTypeRef.current = undefined;
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      successTimeoutRef.current = setTimeout(() => {
        setState('idle');
      }, SUCCESS_STATE_TIMEOUT_MS);
    } catch (error) {
      if (requestId !== transcribeRequestIdRef.current || error instanceof TranscriptionCancelledError) {
        return;
      }

      console.error('[Transcribe] Failed:', error);
      const classified = showError(error);
      console.error('[Transcribe] Classified error:', classified);
      window.electronAPI.trackEvent('transcription_error', { error_type: classified.type });

      // Auto-open error detail popup when API returns a response body
      if (classified.responseBody) {
        window.electronAPI.openErrorDetailWindow({
          message: classified.message,
          statusCode: classified.statusCode,
          responseBody: classified.responseBody,
        });
      }

      // Play error sound if enabled
      if (soundEnabled) {
        playErrorSound();
      }

      // Save audio for retry only if error is retryable
      if (classified.isRetryable) {
        lastAudioRef.current = audioBase64;
        lastAudioMimeTypeRef.current = mimeType;
      } else {
        lastAudioRef.current = null;
        lastAudioMimeTypeRef.current = undefined;
      }
      setState('idle');
    } finally {
      if (transcribeAbortRef.current === controller) {
        transcribeAbortRef.current = null;
      }
    }
  }, [showError, showMessage]);

  const handleRetry = useCallback(async () => {
    if (lastAudioRef.current && state === 'idle') {
      await transcribeWithRetry(lastAudioRef.current, lastAudioMimeTypeRef.current);
    }
  }, [state, transcribeWithRetry]);

  const handleShowErrorDetail = useCallback(() => {
    if (lastErrorDetailRef.current) {
      window.electronAPI.openErrorDetailWindow(lastErrorDetailRef.current);
    }
  }, []);

  const stopRecordingAndTranscribe = useCallback(async () => {
    // Use recorder's internal state to avoid stale closure issues
    if (!recorderRef.current || !recorderRef.current.getIsRecording()) return;

    // Reset audio level visualization
    audioLevelRef.current = 0;
    setAudioLevel(0);

    try {
      const audioBase64 = await recorderRef.current.stop();
      const recordingDuration = Date.now() - recordingStartTimeRef.current;
      lastRecordingDurationRef.current = recordingDuration; // Save for stats
      console.log('[Recording] Stopped');
      window.electronAPI.trackEvent('recording_stop', { duration_ms: recordingDuration });
      // Resume media playback immediately after recording stops (before transcription)
      window.electronAPI.resumeMedia();

      // Don't even round-trip to Gemini for tiny recordings — they're almost
      // always accidental key dribbles or silence and the model loves to
      // hallucinate something out of <1s of audio.
      if (recordingDuration < MIN_TRANSCRIBE_DURATION_MS) {
        console.log(`[Recording] Skipping transcription, duration ${recordingDuration}ms < ${MIN_TRANSCRIBE_DURATION_MS}ms`);
        window.electronAPI.trackEvent('recording_too_short', { duration_ms: recordingDuration });
        setState('idle');
        return;
      }

      // For local STT modes the recorder retained PCM — pull a 16 kHz WAV
      // out alongside the opus blob so the local pipeline has what it wants.
      const wavBase64 = recorderRef.current?.getWavBase64() ?? undefined;
      // Pass the actual recorder MIME ('audio/webm;codecs=opus') so the
      // Gemini-direct path declares the real format in the request body.
      // Without this we were sending opus bytes labelled as audio/wav.
      const audioMimeType = recorderRef.current?.getMimeType();
      await transcribeWithRetry(audioBase64, audioMimeType, wavBase64);
    } catch (error) {
      // Recording stop error (too short, etc.)
      showError(error);
      // Resume media playback on recording error
      window.electronAPI.resumeMedia();
      setState('idle');
    }
  }, [transcribeWithRetry, showError]);

  const cancelTranscription = useCallback(() => {
    if (state !== 'transcribing') return;

    const controller = transcribeAbortRef.current;
    transcribeAbortRef.current = null;
    transcribeRequestIdRef.current += 1;
    lastAudioRef.current = null;
    lastAudioMimeTypeRef.current = undefined;

    if (controller) {
      controller.abort();
    }

    console.log('[TEST] Transcription cancelled by user');
    setState('idle');
  }, [state]);

  // Start recording (extracted for hold-to-record)
  const startRecording = useCallback(async () => {
    if (state !== 'idle' && state !== 'success') return;

    // Clear any pending retry audio when starting new recording
    lastAudioRef.current = null;
    lastAudioMimeTypeRef.current = undefined;
    // Clear success timeout if transitioning from success state
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }

    // Pause any playing media
    window.electronAPI.pauseMedia();

    try {
      // Check and request microphone permission on macOS
      const permissionStatus = await window.electronAPI.getMicrophonePermissionStatus();
      console.log('[Permission] Microphone status:', permissionStatus);

      if (permissionStatus === 'denied' || permissionStatus === 'restricted') {
        showMessage('Microphone access denied. Enable in System Preferences.', 'error', false);
        window.electronAPI.resumeMedia();
        return;
      }

      if (permissionStatus === 'not-determined') {
        const granted = await window.electronAPI.requestMicrophonePermission();
        if (!granted) {
          showMessage('Microphone permission required', 'error', false);
          window.electronAPI.resumeMedia();
          return;
        }
      }

      // Get audio settings
      const settings = await window.electronAPI.getSettings();
      const recorderOptions = buildRecorderOptions(settings);
      recorderRef.current = new AudioRecorder(undefined, recorderOptions);
      // Set up silence detection callback for auto-stop. Skip while the
      // hold-to-record key is still held: the user wants the recording to
      // continue until they physically release the key.
      recorderRef.current.setOnSilenceStop(() => {
        if (isHoldKeyDownRef.current) {
          console.log('[Recording] Silence detected but hold-key still down — ignoring auto-stop');
          return;
        }
        stopRecordingAndTranscribe();
      });
      // Set up audio level callback for visualization with smoothing
      recorderRef.current.setOnAudioLevel((level) => {
        const current = audioLevelRef.current;
        let smoothed: number;

        if (level > current) {
          // Rising: simple lerp, fast
          smoothed = current + (level - current) * AUDIO_LEVEL_LERP_UP;
        } else {
          // Falling: easeOut - faster at start, slower at end
          const diff = current - level;
          const easeOutFactor = 0.3 + diff * 0.6; // 0.3 base + up to 0.6 more based on distance
          smoothed = current - diff * Math.min(easeOutFactor, 0.85);
        }

        audioLevelRef.current = smoothed;
        setAudioLevel(smoothed);
      });
      await recorderRef.current.start();
      console.log('[Recording] Started');
      recordingStartTimeRef.current = Date.now();
      // Audible confirmation that recording is actually live. Played from
      // Web Audio in the renderer, so it lands on the AudioContext clock
      // before the system-volume duck osascript completes — the blip stays
      // at full volume even after we lowered the master output.
      const settingsForSound = await window.electronAPI.getSettings();
      if (settingsForSound.soundEnabled ?? true) {
        playStartSound();
      }
      window.electronAPI.trackEvent('recording_start');
      setState('recording');
    } catch (error) {
      showError(error);
      window.electronAPI.resumeMedia();
    }
  }, [state, showError, showMessage, stopRecordingAndTranscribe]);

  const handleFileDrop = useCallback(async (filePath: string) => {
    console.log('[Drop] handleFileDrop called, state:', state, 'filePath:', filePath);
    if (state !== 'idle' && state !== 'success') {
      console.log('[Drop] Ignoring drop, state is:', state);
      return;
    }

    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    console.log('[Drop] Extension:', ext, 'isAudio:', !!AUDIO_EXTENSIONS[ext]);
    const audioMimeType = AUDIO_EXTENSIONS[ext];

    if (audioMimeType) {
      // Audio file: read and transcribe
      try {
        const audioBase64 = await window.electronAPI.readFileAsBase64(filePath);
        console.log('[Drop] Audio file:', filePath, 'MIME:', audioMimeType);
        window.electronAPI.trackEvent('file_drop_audio', { extension: ext });
        await transcribeWithRetry(audioBase64, audioMimeType);
      } catch (error) {
        showError(error);
      }
    } else {
      // Non-audio file: copy full path to clipboard
      console.log('[Drop] Non-audio file, copying path:', filePath);
      await window.electronAPI.copyToClipboard(filePath);
      showMessage('Path copied to clipboard', 'success');
      window.electronAPI.trackEvent('file_drop_path', { extension: ext });

      const settings = await window.electronAPI.getSettings();
      if (settings.soundEnabled ?? true) {
        playSuccessSound();
      }

      // Clear success timeout if transitioning from success state
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
      setState('success');
      successTimeoutRef.current = setTimeout(() => {
        setState('idle');
      }, SUCCESS_STATE_TIMEOUT_MS);
    }
  }, [state, transcribeWithRetry, showError, showMessage]);

  const widgetRef = useRef<HTMLDivElement>(null);

  const handleToggleRecording = useCallback(async () => {
    if (state === 'idle' || state === 'success') {
      await startRecording();
    } else if (state === 'recording') {
      await stopRecordingAndTranscribe();
    } else if (state === 'transcribing') {
      cancelTranscription();
    }
  }, [state, startRecording, stopRecordingAndTranscribe, cancelTranscription]);

  // Listen for global keyboard shortcut (toggle mode)
  useEffect(() => {
    const unsubscribe = window.electronAPI.onToggleRecording(() => {
      handleToggleRecording();
    });
    return () => {
      unsubscribe();
    };
  }, [handleToggleRecording, state]);

  // Hold-to-record: dedicated start / stop events from the keyboard hook.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onStartRecording(() => {
      startRecording();
    });
    return () => {
      unsubscribe();
    };
  }, [startRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onStopRecording(() => {
      if (recorderRef.current?.getIsRecording()) {
        stopRecordingAndTranscribe();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [stopRecordingAndTranscribe]);

  // Wake-word detection: main process emits wake-word-triggered just before
  // start-recording, so we set the ref first and the start handler picks it up.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onWakeWordTriggered?.(() => {
      wakeWordTriggeredRef.current = true;
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Track the hold-to-record key state so silence-detection can skip its
  // auto-stop while the user is still holding the key.
  useEffect(() => {
    const unsubDown = window.electronAPI.onHoldKeyDown?.(() => {
      isHoldKeyDownRef.current = true;
    });
    const unsubUp = window.electronAPI.onHoldKeyUp?.(() => {
      isHoldKeyDownRef.current = false;
    });
    return () => {
      unsubDown?.();
      unsubUp?.();
    };
  }, []);

  // Load app version on mount
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setAppVersion);
  }, []);

  // Load hotkey settings for hint display
  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setHotkey(settings.hotkey || 'CommandOrControl+Shift+R');
    });
  }, []);

  // Native DOM drag-and-drop handlers on the widget element.
  // Using native listeners (not React) because Electron's default drag-and-drop
  // behavior (file navigation) must be prevented at the DOM level before
  // React's delegated event system processes the event.
  useEffect(() => {
    const el = widgetRef.current;
    if (!el) {
      console.log('[Drop] widgetRef.current is null, skipping drag-and-drop setup');
      return;
    }
    console.log('[Drop] Setting up drag-and-drop listeners on widget element');

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      console.log('[Drop] Drop event fired');
      console.log('[Drop] dataTransfer:', e.dataTransfer);
      console.log('[Drop] dataTransfer.files.length:', e.dataTransfer?.files?.length);
      console.log('[Drop] dataTransfer.types:', e.dataTransfer?.types);

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        console.log('[Drop] file.name:', file.name, 'file.type:', file.type, 'file.size:', file.size);
        try {
          const filePath = window.electronAPI.getPathForFile(file);
          console.log('[Drop] filePath from webUtils:', filePath);
          if (filePath) {
            handleFileDrop(filePath);
          } else {
            console.log('[Drop] getPathForFile returned empty string');
          }
        } catch (err) {
          console.log('[Drop] getPathForFile error:', err);
        }
      } else {
        console.log('[Drop] No files in dataTransfer');
      }
    };

    // Prevent default on document level to stop Electron from navigating to dropped files
    const preventNavigation = (e: DragEvent) => {
      e.preventDefault();
    };

    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    document.addEventListener('dragover', preventNavigation);
    document.addEventListener('drop', preventNavigation);

    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      document.removeEventListener('dragover', preventNavigation);
      document.removeEventListener('drop', preventNavigation);
    };
  }, [handleFileDrop]);

  // Cleanup recorder on unmount or window close to release microphone
  useEffect(() => {
    const cleanup = () => {
      if (recorderRef.current?.getIsRecording()) {
        recorderRef.current.cancel();
        recorderRef.current = null;
      }
    };

    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      cleanup();
    };
  }, []);

  return (
    <div
      ref={widgetRef}
      className={`widget ${state}${isDragOver ? ' drag-over' : ''}`}
    >
      {appVersion && <span className="version-hint">{appVersion === 'dev' ? 'dev' : `v${appVersion}`}</span>}
      <StatsButton />
      <HideButton />
      <InfoButton />
      <SettingsButton />
      <div className="shortcut-hint-container">
        <span className="shortcut-hint">
          {formatHotkeyCompact(hotkey)}
        </span>
      </div>
      <div className="drag-handle">
        <span className="grip-dots"></span>
      </div>
      <div className="mic-button-container">
        {state === 'recording' && <AudioLevelRing level={audioLevel} />}
        <button
          className={`mic-button ${state}`}
          onClick={handleToggleRecording}
          aria-label={
            state === 'idle' || state === 'success'
              ? 'Start recording'
              : state === 'recording'
                ? 'Stop recording'
                : 'Cancel transcription'
          }
          title={state === 'transcribing' ? 'Click to cancel' : undefined}
        >
          {state === 'transcribing' ? (
            <>
              <span className="spinner" />
              <span className="cancel-icon" aria-hidden="true">✕</span>
            </>
          ) : state === 'success' ? (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              width="32"
              height="32"
              className="checkmark-icon"
            >
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              width="32"
              height="32"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
          )}
        </button>
      </div>
      {message && (
        <div
          className={`flash-message ${message.type}${message.isRetryable || message.hasErrorDetail ? ' clickable' : ''}`}
          onClick={message.hasErrorDetail ? handleShowErrorDetail : message.isRetryable ? handleRetry : undefined}
          role={message.isRetryable || message.hasErrorDetail ? 'button' : undefined}
          tabIndex={message.isRetryable || message.hasErrorDetail ? 0 : undefined}
          onKeyDown={
            message.hasErrorDetail
              ? (e) => e.key === 'Enter' && handleShowErrorDetail()
              : message.isRetryable
                ? (e) => e.key === 'Enter' && handleRetry()
                : undefined
          }
        >
          {message.text}
          {message.hasErrorDetail && <span className="detail-hint">(details)</span>}
          {!message.hasErrorDetail && message.isRetryable && <span className="retry-hint">(tap to retry)</span>}
        </div>
      )}
    </div>
  );
}
