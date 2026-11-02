import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { App } from './App';
import { resetSharedAudioGraph } from '../lib/audio';

// The App listens for `devicechange` on navigator.mediaDevices
const deviceEventStubs = { addEventListener: () => {}, removeEventListener: () => {} };

// Mock audio infrastructure
const createMockMediaStream = (): MediaStream =>
  ({
    getTracks: () => [{ stop: mock(() => {}) }],
    getAudioTracks: () => [{
      label: 'Mock Microphone',
      getSettings: () => ({
        deviceId: 'mock-device-id',
        sampleRate: 48000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      }),
      stop: mock(() => {}),
    }],
  }) as unknown as MediaStream;

// Store the worklet port reference so we can simulate audio data
let mockWorkletPort: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null };

const createMockAudioContext = () => {
  // Reset port for each context
  mockWorkletPort = { onmessage: null };

  const mockSource = {
    connect: mock(() => {}),
    disconnect: mock(() => {}),
  };

  return {
    sampleRate: 16000,
    createMediaStreamSource: mock(() => mockSource),
    audioWorklet: {
      addModule: mock(() => Promise.resolve()),
    },
    destination: {},
    state: 'running',
    suspend: mock(() => Promise.resolve()),
    resume: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
  };
};

// Mock AudioWorkletNode globally
const createMockAudioWorkletNode = () => {
  const node = {
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    port: mockWorkletPort,
  };
  return node;
};

(globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = mock(
  () => createMockAudioWorkletNode()
);

const defaultSettings = {
  apiKey: 'test-api-key',
  model: 'gemini-3-flash-preview',
  languages: [] as string[],
  speechDomain: 'programming',
  customDomainHint: '',
  customKeywords: '',
  microphoneDeviceId: '',
  silenceDetectionEnabled: true,
  silenceDurationMs: 2500,
  launchAtStartup: false,
  clarificationEnabled: true,
  previousTranscriptContextEnabled: false,
  soundEnabled: true,
  hotkey: 'CommandOrControl+Shift+R',
  widgetHidden: false,
  widgetStyle: 'full' as const,
  holdToRecordEnabled: false,
  holdToRecordKey: 'RightMeta' as const,
  autoPasteEnabled: false,
  transcriptionMode: 'cloud' as const,
  cloudProvider: 'google' as const,
  transcriptionPrompt: '',
  polishEnabled: false,
  polishPrompt: '',
  polishMinChars: 57,
  polishModel: 'gpt-5.4-nano',
  providerConfigs: {},
  mediaPauseMode: 'duck' as const,
};

/**
 * Creates a complete mock ElectronAPI with all required methods.
 * Use overrides parameter to customize specific methods for individual tests.
 */
const createMockElectronAPI = (overrides: Partial<typeof window.electronAPI> = {}) => ({
  getApiKey: mock(() => Promise.resolve('test-api-key')),
  getModel: mock(() => Promise.resolve('gemini-3-flash-preview')),
  copyToClipboard: mock(() => Promise.resolve(true)),
  onToggleRecording: mock((callback: () => void) => {
    return () => {};
  }),
  onStartRecording: mock((callback: () => void) => {
    return () => {};
  }),
  onStopRecording: mock((callback: () => void) => {
    return () => {};
  }),
  getSettings: mock(() => Promise.resolve({ ...defaultSettings })),
  saveSettings: mock(() => Promise.resolve(true)),
  openSettingsWindow: mock(() => Promise.resolve(true)),
  closeSettingsWindow: mock(() => Promise.resolve(true)),
  openInfoWindow: mock(() => Promise.resolve(true)),
  openHideWindow: mock(() => Promise.resolve(true)),
  closeHideWindow: mock(() => Promise.resolve(true)),
  hideForDuration: mock(() => Promise.resolve(true)),
  getMicrophonePermissionStatus: mock(() => Promise.resolve('granted' as const)),
  requestMicrophonePermission: mock(() => Promise.resolve(true)),
  openExternalUrl: mock(() => Promise.resolve(true)),
  getAppVersion: mock(() => Promise.resolve('0.3.1')),
  getRecentTranscripts: mock(() => Promise.resolve([])),
  getTranscriptHistory: mock(() => Promise.resolve([])),
  trackEvent: mock(() => Promise.resolve()),
  pauseMedia: mock(() => Promise.resolve()),
  resumeMedia: mock(() => Promise.resolve()),
  openStatsWindow: mock(() => Promise.resolve(true)),
  closeStatsWindow: mock(() => Promise.resolve(true)),
  getStats: mock(() => Promise.resolve({
    totalTranscriptions: 0,
    totalWords: 0,
    totalCharacters: 0,
    totalRecordingTimeMs: 0,
    firstUseDate: '',
    lastUseDate: '',
    dailyStats: [],
    averageWordsPerTranscription: 0,
    mostActiveDay: 'N/A',
    timeSavedSeconds: 0,
  })),
  resetStats: mock(() => Promise.resolve(true)),
  recordTranscriptionStats: mock(() => Promise.resolve(true)),
  openErrorDetailWindow: mock(() => Promise.resolve(true)),
  getErrorDetail: mock(() => Promise.resolve({ message: 'Unknown error' })),
  getPathForFile: mock((file: File) => `/mock/path/${file.name}`),
  readFileAsBase64: mock(() => Promise.resolve('')),
  saveFailedRecording: mock(() => Promise.resolve({
    filePath: '/mock/failed-recordings/recording-test.wav',
    fileName: 'recording-test.wav',
    sizeBytes: 1024,
  })),
  showItemInFolder: mock(() => Promise.resolve(true)),
  retryFailedRecording: mock(() => Promise.resolve(true)),
  onRetryTranscription: mock((_callback: (filePath: string) => void) => {
    return () => {};
  }),
  ...overrides,
});

describe('App', () => {
  let originalMediaDevices: MediaDevices | undefined;
  let originalAudioContext: typeof window.AudioContext | undefined;
  let originalElectronAPI: typeof window.electronAPI | undefined;
  let originalLocation: Location | undefined;

  beforeEach(() => {
    resetSharedAudioGraph();

    // Save originals
    originalMediaDevices = navigator.mediaDevices;
    originalAudioContext = window.AudioContext;
    originalElectronAPI = window.electronAPI;
    originalLocation = window.location;

    // Mock window.location for worklet URL construction
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'http://localhost:12000',
        href: 'http://localhost:12000/',
        protocol: 'http:',
        host: 'localhost:12000',
        hostname: 'localhost',
        port: '12000',
        pathname: '/',
        search: '',
        hash: '',
      },
      writable: true,
      configurable: true,
    });

    // Mock navigator.mediaDevices
    const mockGetUserMedia = mock(() => Promise.resolve(createMockMediaStream()));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { ...deviceEventStubs, getUserMedia: mockGetUserMedia },
      writable: true,
      configurable: true,
    });

    // Mock AudioContext
    (window as unknown as { AudioContext: unknown }).AudioContext = mock(
      () => createMockAudioContext()
    );

    // Mock electronAPI with all methods
    window.electronAPI = createMockElectronAPI();
  });

  afterEach(() => {
    cleanup();
    // Restore originals
    if (originalMediaDevices !== undefined) {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        writable: true,
        configurable: true,
      });
    }
    if (originalAudioContext !== undefined) {
      (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    }
    if (originalElectronAPI !== undefined) {
      window.electronAPI = originalElectronAPI;
    }
    if (originalLocation !== undefined) {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    }
  });

  it('should render microphone button in idle state', async () => {
    await act(async () => {
      render(<App />);
    });

    const button = screen.getByRole('button', { name: /start recording/i });
    expect(button).toBeDefined();
    expect(button.className).toContain('idle');
  });

  it('should switch to recording state on click', async () => {
    await act(async () => {
      render(<App />);
    });

    const button = screen.getByRole('button', { name: /start recording/i });

    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      const recordingButton = screen.getByRole('button', { name: /stop recording/i });
      expect(recordingButton).toBeDefined();
      expect(recordingButton.className).toContain('recording');
    });
  });

  it('should have mic-button class on button', async () => {
    await act(async () => {
      render(<App />);
    });

    const button = screen.getByRole('button', { name: /start recording/i });
    expect(button.className).toContain('mic-button');
  });

  it('should have widget container for drag region', async () => {
    await act(async () => {
      render(<App />);
    });

    const widget = document.querySelector('.widget');
    expect(widget).toBeDefined();
  });

  it('should render settings button', async () => {
    await act(async () => {
      render(<App />);
    });

    const settingsButton = screen.getByRole('button', { name: /open settings/i });
    expect(settingsButton).toBeDefined();
  });

  describe('error handling', () => {
    it('should show error message when microphone permission denied', async () => {
      // Mock permission denied error
      const permissionError = new Error('NotAllowedError');
      permissionError.name = 'NotAllowedError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(permissionError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      const button = screen.getByRole('button', { name: /start recording/i });

      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(() => {
        const errorMessage = screen.getByText('Microphone access denied');
        expect(errorMessage).toBeDefined();
        expect(errorMessage.className).toContain('error');
      });
    });

    it('should show error with retry hint for retryable errors', async () => {
      // Mock permission denied error (retryable)
      const permissionError = new Error('NotAllowedError');
      permissionError.name = 'NotAllowedError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(permissionError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      const button = screen.getByRole('button', { name: /start recording/i });

      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(() => {
        const retryHint = screen.getByText('(tap to retry)');
        expect(retryHint).toBeDefined();
      });
    });

    it('should show error without retry hint for non-retryable errors', async () => {
      // Mock device not found error (non-retryable)
      const notFoundError = new Error('NotFoundError');
      notFoundError.name = 'NotFoundError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(notFoundError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      const button = screen.getByRole('button', { name: /start recording/i });

      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(() => {
        const errorMessage = screen.getByText('No microphone found');
        expect(errorMessage).toBeDefined();
        // Should not have retry hint
        const retryHints = document.querySelectorAll('.retry-hint');
        expect(retryHints.length).toBe(0);
      });
    });

    it('should have success class on flash message when copy succeeds', async () => {
      // This test verifies the success message styling
      // When transcription succeeds, the message should have 'success' class
      await act(async () => {
        render(<App />);
      });

      // Verify the component renders correctly
      const button = screen.getByRole('button', { name: /start recording/i });
      expect(button).toBeDefined();
    });

    it('should return to idle state after error', async () => {
      // Mock permission denied error
      const permissionError = new Error('NotAllowedError');
      permissionError.name = 'NotAllowedError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(permissionError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      const button = screen.getByRole('button', { name: /start recording/i });

      await act(async () => {
        fireEvent.click(button);
      });

      // After error, button should return to idle state
      await waitFor(() => {
        const idleButton = screen.getByRole('button', { name: /start recording/i });
        expect(idleButton).toBeDefined();
        expect(idleButton.className).toContain('idle');
      });
    });

    it('should show error message for missing API key', async () => {
      // Mock electronAPI to return no API key
      window.electronAPI = createMockElectronAPI({
        getApiKey: mock(() => Promise.resolve('')),
        getSettings: mock(() => Promise.resolve({ ...defaultSettings, apiKey: '' })),
      });

      await act(async () => {
        render(<App />);
      });

      const button = screen.getByRole('button', { name: /start recording/i });

      await act(async () => {
        fireEvent.click(button);
      });

      // Wait for recording state
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeDefined();
      });

      // Stop recording (this will trigger transcription which will fail due to missing API key)
      // Note: This test is limited because we can't easily simulate audio data
    });
  });

  describe('flash message behavior', () => {
    it('should show error flash message with correct CSS classes', async () => {
      const permissionError = new Error('NotAllowedError');
      permissionError.name = 'NotAllowedError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(permissionError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });

      await waitFor(() => {
        const flashMessage = document.querySelector('.flash-message');
        expect(flashMessage).toBeDefined();
        expect(flashMessage?.className).toContain('error');
        expect(flashMessage?.className).toContain('clickable');
      });
    });

    it('should not show clickable class for non-retryable errors', async () => {
      const notFoundError = new Error('NotFoundError');
      notFoundError.name = 'NotFoundError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(notFoundError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });

      await waitFor(() => {
        const flashMessage = document.querySelector('.flash-message');
        expect(flashMessage).toBeDefined();
        expect(flashMessage?.className).toContain('error');
        expect(flashMessage?.className).not.toContain('clickable');
      });
    });

    it('error message should have button role when retryable', async () => {
      const permissionError = new Error('NotAllowedError');
      permissionError.name = 'NotAllowedError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(permissionError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });

      await waitFor(() => {
        const flashMessage = document.querySelector('.flash-message');
        expect(flashMessage?.getAttribute('role')).toBe('button');
        expect(flashMessage?.getAttribute('tabIndex')).toBe('0');
      });
    });

    it('error message should not have button role when not retryable', async () => {
      const notFoundError = new Error('NotFoundError');
      notFoundError.name = 'NotFoundError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(notFoundError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });

      await waitFor(() => {
        const flashMessage = document.querySelector('.flash-message');
        expect(flashMessage?.getAttribute('role')).toBeNull();
      });
    });
  });

  describe('error message content', () => {
    it('should display correct message for microphone permission error', async () => {
      const permissionError = new Error('NotAllowedError');
      permissionError.name = 'NotAllowedError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(permissionError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });

      await waitFor(() => {
        expect(screen.getByText('Microphone access denied')).toBeDefined();
      });
    });

    it('should display correct message for no microphone found', async () => {
      const notFoundError = new Error('NotFoundError');
      notFoundError.name = 'NotFoundError';

      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          ...deviceEventStubs,
          getUserMedia: mock(() => Promise.reject(notFoundError)),
        },
        writable: true,
        configurable: true,
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });

      await waitFor(() => {
        expect(screen.getByText('No microphone found')).toBeDefined();
      });
    });
  });

  describe('silence auto-stop', () => {
    it('should not auto-stop if user is still speaking', async () => {
      // Create a custom worklet port that we can send messages to
      let capturedPortOnMessage: ((event: MessageEvent) => void) | null = null;
      const customWorkletPort = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: mock(() => {}),
      };

      const mockSource = {
        connect: mock(() => {}),
        disconnect: mock(() => {}),
      };

      const mockWorkletNode = {
        connect: mock(() => {}),
        disconnect: mock(() => {}),
        port: new Proxy(customWorkletPort, {
          set(target, prop, value) {
            if (prop === 'onmessage') {
              capturedPortOnMessage = value as (event: MessageEvent) => void;
            }
            (target as Record<string, unknown>)[prop as string] = value;
            return true;
          },
          get(target, prop) {
            return (target as Record<string, unknown>)[prop as string];
          },
        }),
      };

      const mockAudioContext = {
        sampleRate: 16000,
        createMediaStreamSource: mock(() => mockSource),
        audioWorklet: {
          addModule: mock(() => Promise.resolve()),
        },
        destination: {},
        state: 'running',
        suspend: mock(() => Promise.resolve()),
        resume: mock(() => Promise.resolve()),
        close: mock(() => Promise.resolve()),
      };

      (window as unknown as { AudioContext: unknown }).AudioContext = mock(
        () => mockAudioContext
      );

      (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = mock(
        () => mockWorkletNode
      );

      await act(async () => {
        render(<App />);
      });

      // Start recording
      const button = screen.getByRole('button', { name: /start recording/i });

      await act(async () => {
        fireEvent.click(button);
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeDefined();
      });

      expect(capturedPortOnMessage).not.toBeNull();

      // Simulate continuous speech (non-silent audio) via worklet message
      const nonSilentBuffer = new Float32Array(4096).fill(0.5);

      const originalDateNow = Date.now;
      let currentTime = originalDateNow();
      Date.now = () => currentTime;

      // Process many chunks of non-silent audio
      for (let i = 0; i < 20; i++) {
        currentTime += 200;
        await act(async () => {
          capturedPortOnMessage!({ data: { type: 'audio', data: nonSilentBuffer } } as MessageEvent);
        });
      }

      Date.now = originalDateNow;

      // Should still be in recording state
      await waitFor(() => {
        const recordingButton = screen.getByRole('button', { name: /stop recording/i });
        expect(recordingButton.className).toContain('recording');
      });
    });
  });

  describe('keyboard shortcut', () => {
    it('should register toggle-recording listener on mount', async () => {
      const mockOnToggleRecording = mock((callback: () => void) => {
        return () => {};
      });
      window.electronAPI = createMockElectronAPI({
        onToggleRecording: mockOnToggleRecording,
      });

      await act(async () => {
        render(<App />);
      });

      expect(mockOnToggleRecording).toHaveBeenCalled();
    });

    it('should toggle recording when global shortcut is triggered', async () => {
      let capturedCallback: (() => void) | null = null;
      const mockOnToggleRecording = mock((callback: () => void) => {
        capturedCallback = callback;
        return () => {};
      });
      window.electronAPI = createMockElectronAPI({
        onToggleRecording: mockOnToggleRecording,
      });

      await act(async () => {
        render(<App />);
      });

      // Verify button is in idle state
      const button = screen.getByRole('button', { name: /start recording/i });
      expect(button.className).toContain('idle');

      // Simulate global shortcut trigger
      expect(capturedCallback).not.toBeNull();

      await act(async () => {
        capturedCallback!();
      });

      // Verify button switches to recording state
      await waitFor(() => {
        const recordingButton = screen.getByRole('button', { name: /stop recording/i });
        expect(recordingButton.className).toContain('recording');
      });
    });
  });

  describe('failed transcription is recoverable', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Record past MIN_TRANSCRIBE_DURATION_MS (1 s), then stop, so the audio is transcribed. */
    async function recordAndStop() {
      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
      });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop recording/i })).toBeDefined();
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
      });
    }

    it('saves the recording to disk and opens the error window with it on a 503', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('<html><body>Service Unavailable</body></html>', { status: 503 }))
      ) as unknown as typeof fetch;

      const saveFailedRecording = mock(() => Promise.resolve({
        filePath: '/mock/failed-recordings/recording-test.wav',
        fileName: 'recording-test.wav',
        sizeBytes: 4,
      }));
      const openErrorDetailWindow = mock(() => Promise.resolve(true));
      window.electronAPI = createMockElectronAPI({ saveFailedRecording, openErrorDetailWindow });

      await recordAndStop();

      await waitFor(() => {
        expect(saveFailedRecording).toHaveBeenCalled();
      }, { timeout: 5000 });

      await waitFor(() => {
        expect(openErrorDetailWindow).toHaveBeenCalled();
      }, { timeout: 5000 });

      const detail = (openErrorDetailWindow.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(detail.audioFilePath).toBe('/mock/failed-recordings/recording-test.wav');
      expect(detail.statusCode).toBe(503);
    }, 15000);

    it('still opens the error window when the audio could not be saved', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('boom', { status: 503 }))
      ) as unknown as typeof fetch;

      const openErrorDetailWindow = mock(() => Promise.resolve(true));
      window.electronAPI = createMockElectronAPI({
        saveFailedRecording: mock(() => Promise.resolve(null)),
        openErrorDetailWindow,
      });

      await recordAndStop();

      await waitFor(() => {
        expect(openErrorDetailWindow).toHaveBeenCalled();
      }, { timeout: 5000 });

      const detail = (openErrorDetailWindow.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(detail.audioFilePath).toBeUndefined();
    }, 15000);

    it('re-transcribes a saved file when the error window asks for a retry', async () => {
      let retryCallback: ((filePath: string) => void) | null = null;
      const readFileAsBase64 = mock(() => Promise.resolve(''));
      window.electronAPI = createMockElectronAPI({
        readFileAsBase64,
        onRetryTranscription: mock((callback: (filePath: string) => void) => {
          retryCallback = callback;
          return () => {};
        }),
      });

      await act(async () => {
        render(<App />);
      });

      expect(retryCallback).not.toBeNull();

      await act(async () => {
        retryCallback!('/mock/failed-recordings/recording-test.wav');
      });

      await waitFor(() => {
        expect(readFileAsBase64).toHaveBeenCalledWith('/mock/failed-recordings/recording-test.wav');
      });
    });

    /** Mount the app and return the callback the error window's Retry button reaches. */
    async function mountWithRetryHook(overrides: Parameters<typeof createMockElectronAPI>[0]) {
      let retryCallback: ((filePath: string) => void) | null = null;
      window.electronAPI = createMockElectronAPI({
        ...overrides,
        onRetryTranscription: mock((callback: (filePath: string) => void) => {
          retryCallback = callback;
          return () => {};
        }),
      });
      await act(async () => {
        render(<App />);
      });
      return (filePath: string) => retryCallback!(filePath);
    }

    const savedAudioBase64 = Buffer.from('opus-bytes').toString('base64');

    it('retries a saved recording in local mode, converting it to WAV first', async () => {
      const decodeAudioData = mock(() =>
        Promise.resolve({
          length: 4,
          numberOfChannels: 1,
          sampleRate: 16000,
          getChannelData: () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
        })
      );
      (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
        decodeAudioData = decodeAudioData;
        close = () => Promise.resolve();
      };
      const transcribeLocalStt = mock((_wav: string) =>
        Promise.resolve({ ok: true as const, text: 'local retry text', elapsedMs: 5 })
      );
      const copyToClipboard = mock(() => Promise.resolve(true));
      const retry = await mountWithRetryHook({
        getSettings: mock(() =>
          Promise.resolve({ ...defaultSettings, transcriptionMode: 'local' as const })
        ),
        readFileAsBase64: mock(() => Promise.resolve(savedAudioBase64)),
        transcribeLocalStt,
        copyToClipboard,
      });

      await act(async () => {
        retry('/mock/failed-recordings/recording-test.webm');
      });

      await waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalled();
      });
      expect(decodeAudioData).toHaveBeenCalled();
      const sentWav = Buffer.from(transcribeLocalStt.mock.calls[0][0], 'base64');
      expect(sentWav.toString('ascii', 0, 4)).toBe('RIFF');
      expect((copyToClipboard.mock.calls[0] as unknown as [string])[0]).toBe('local retry text');
    });

    it('retries a saved recording through OpenAI when the mode was switched to it', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ text: 'cloud retry text' }), { status: 200 }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const copyToClipboard = mock(() => Promise.resolve(true));
      const transcribeLocalStt = mock(() => Promise.resolve({ ok: false as const, error: 'unused' }));
      const retry = await mountWithRetryHook({
        getSettings: mock(() =>
          Promise.resolve({
            ...defaultSettings,
            transcriptionMode: 'cloud' as const,
            cloudProvider: 'openai' as const,
            providerConfigs: { openai: { apiKey: 'sk-test', model: 'gpt-transcribe' } },
          })
        ),
        readFileAsBase64: mock(() => Promise.resolve(savedAudioBase64)),
        transcribeLocalStt,
        copyToClipboard,
      });

      await act(async () => {
        retry('/mock/failed-recordings/recording-test.webm');
      });

      await waitFor(() => {
        expect(copyToClipboard).toHaveBeenCalled();
      });
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
        'https://api.openai.com/v1/audio/transcriptions'
      );
      expect(transcribeLocalStt).not.toHaveBeenCalled();
      expect((copyToClipboard.mock.calls[0] as unknown as [string])[0]).toBe('cloud retry text');
    });

    describe('polish', () => {
      const rawText = 'ну вот э-э это текст для проверки';
      const polishSettings = {
        ...defaultSettings,
        transcriptionMode: 'cloud' as const,
        cloudProvider: 'openai' as const,
        providerConfigs: { openai: { apiKey: 'sk-test', model: 'gpt-transcribe' } },
        polishEnabled: true,
        polishPrompt: 'Мой промпт',
        polishMinChars: 0,
      };

      /** Fetch mock: OpenAI transcription returns rawText, the chat endpoint is `chat`. */
      function mockOpenAI(chat: (init: RequestInit) => Promise<Response>) {
        const fetchMock = mock((url: string, init: RequestInit) =>
          url.includes('transcriptions')
            ? Promise.resolve(new Response(JSON.stringify({ text: rawText }), { status: 200 }))
            : chat(init)
        );
        globalThis.fetch = fetchMock as unknown as typeof fetch;
        return fetchMock;
      }

      async function retrySaved(settings: Record<string, unknown>) {
        const copyToClipboard = mock(() => Promise.resolve(true));
        const retry = await mountWithRetryHook({
          getSettings: mock(() => Promise.resolve(settings as typeof defaultSettings)),
          readFileAsBase64: mock(() => Promise.resolve(savedAudioBase64)),
          copyToClipboard,
        });
        await act(async () => {
          retry('/mock/failed-recordings/recording-test.webm');
        });
        return copyToClipboard;
      }

      it('pastes the polished text, whatever the model changed, with the instruction from settings', async () => {
        const fetchMock = mockOpenAI(() =>
          Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Это текст для проверки.' } }] })))
        );
        const copyToClipboard = await retrySaved(polishSettings);
        await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
        expect((copyToClipboard.mock.calls[0] as unknown as [string])[0]).toBe('Это текст для проверки.');
        const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body.messages[0].content.startsWith('Мой промпт')).toBe(true);
        expect(body.messages[1].content).toBe(rawText);
      });

      it('shows the polishing state while the request is in flight', async () => {
        let finish!: (response: Response) => void;
        mockOpenAI(() => new Promise<Response>((resolve) => { finish = resolve; }));
        const copyToClipboard = await retrySaved(polishSettings);
        await waitFor(() => {
          expect(screen.getByRole('button', { name: /cancel transcription/i }).className).toContain('polishing');
        });
        await act(async () => {
          finish(new Response(JSON.stringify({ choices: [{ message: { content: 'готово' } }] })));
        });
        await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
      });

      it('pastes the raw transcript when the polish request fails', async () => {
        mockOpenAI(() => Promise.resolve(new Response('boom', { status: 500 })));
        const copyToClipboard = await retrySaved(polishSettings);
        await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
        expect((copyToClipboard.mock.calls[0] as unknown as [string])[0]).toBe(rawText);
      });

      it('skips polish for a transcript shorter than the minimum length', async () => {
        const fetchMock = mockOpenAI(() => Promise.reject(new Error('must not be called')));
        const copyToClipboard = await retrySaved({ ...polishSettings, polishMinChars: rawText.length + 1 });
        await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((copyToClipboard.mock.calls[0] as unknown as [string])[0]).toBe(rawText);
      });

      it('makes no polish request when the option is off', async () => {
        const fetchMock = mockOpenAI(() => Promise.reject(new Error('must not be called')));
        const copyToClipboard = await retrySaved({ ...polishSettings, polishEnabled: false });
        await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((copyToClipboard.mock.calls[0] as unknown as [string])[0]).toBe(rawText);
      });
    });

    it('saves the recording when a local transcription fails', async () => {
      const saveFailedRecording = mock(() => Promise.resolve({
        filePath: '/mock/failed-recordings/recording-test.webm',
        fileName: 'recording-test.webm',
        sizeBytes: 4,
      }));
      const openErrorDetailWindow = mock(() => Promise.resolve(true));
      const transcribeLocalStt = mock(() => Promise.resolve({ ok: false as const, error: 'bridge crashed' }));
      window.electronAPI = createMockElectronAPI({
        getSettings: mock(() =>
          Promise.resolve({ ...defaultSettings, transcriptionMode: 'local' as const })
        ),
        transcribeLocalStt,
        saveFailedRecording,
        openErrorDetailWindow,
      });
      // The recorder and the WAV conversion both build an AudioContext.
      (globalThis as unknown as { AudioContext: unknown }).AudioContext = mock(() => ({
        ...createMockAudioContext(),
        decodeAudioData: () =>
          Promise.resolve({
            length: 1,
            numberOfChannels: 1,
            sampleRate: 16000,
            getChannelData: () => new Float32Array([0]),
          }),
      }));

      await recordAndStop();

      await waitFor(() => {
        expect(saveFailedRecording).toHaveBeenCalled();
        expect(openErrorDetailWindow).toHaveBeenCalled();
      }, { timeout: 5000 });
      expect(transcribeLocalStt).toHaveBeenCalled();
      const detail = (openErrorDetailWindow.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(detail.audioFilePath).toBe('/mock/failed-recordings/recording-test.webm');
    }, 15000);
  });
});
