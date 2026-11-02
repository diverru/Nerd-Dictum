import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ErrorDetailPage } from './ErrorDetailPage';

interface ErrorDetail {
  message: string;
  statusCode?: number;
  responseBody?: string;
  audioFilePath?: string;
  audioFileName?: string;
  audioSizeBytes?: number;
}

const SAVED_ERROR: ErrorDetail = {
  message: 'API error - try again',
  statusCode: 503,
  responseBody: '<html><body>Service Unavailable</body></html>',
  audioFilePath: '/Users/test/Library/Application Support/Nerd Dictum/failed-recordings/recording-2026-08-29T14-32-05-123Z.wav',
  audioFileName: 'recording-2026-08-29T14-32-05-123Z.wav',
  audioSizeBytes: 2 * 1024 * 1024,
};

let originalElectronAPI: typeof window.electronAPI | undefined;

function mockAPI(detail: ErrorDetail, overrides: Record<string, unknown> = {}) {
  window.electronAPI = {
    getErrorDetail: mock(() => Promise.resolve(detail)),
    retryFailedRecording: mock(() => Promise.resolve(true)),
    showItemInFolder: mock(() => Promise.resolve(true)),
    ...overrides,
  } as unknown as typeof window.electronAPI;
}

beforeEach(() => {
  originalElectronAPI = window.electronAPI;
});

afterEach(() => {
  cleanup();
  if (originalElectronAPI !== undefined) {
    window.electronAPI = originalElectronAPI;
  }
});

describe('ErrorDetailPage — saved recording', () => {
  it('shows the saved file name, its size and a Retry button', async () => {
    mockAPI(SAVED_ERROR);

    await act(async () => {
      render(<ErrorDetailPage />);
    });

    await waitFor(() => {
      expect(screen.getByText(SAVED_ERROR.audioFileName!)).toBeDefined();
    });
    expect(screen.getByText('2.0 MB')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('asks the main process to retry with the saved file path', async () => {
    const retry = mock(() => Promise.resolve(true));
    mockAPI(SAVED_ERROR, { retryFailedRecording: retry });

    await act(async () => {
      render(<ErrorDetailPage />);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(retry).toHaveBeenCalledWith(SAVED_ERROR.audioFilePath);
  });

  it('re-enables Retry when the main process could not start it', async () => {
    mockAPI(SAVED_ERROR, { retryFailedRecording: mock(() => Promise.resolve(false)) });

    await act(async () => {
      render(<ErrorDetailPage />);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  it('reveals the recording in the file manager when the name is clicked', async () => {
    const reveal = mock(() => Promise.resolve(true));
    mockAPI(SAVED_ERROR, { showItemInFolder: reveal });

    await act(async () => {
      render(<ErrorDetailPage />);
    });

    await waitFor(() => {
      expect(screen.getByText(SAVED_ERROR.audioFileName!)).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByText(SAVED_ERROR.audioFileName!));
    });

    expect(reveal).toHaveBeenCalledWith(SAVED_ERROR.audioFilePath);
  });

  it('says so when the recording could not be saved, and offers no Retry', async () => {
    mockAPI({ message: 'Network error - check connection' });

    await act(async () => {
      render(<ErrorDetailPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('Recording could not be saved')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
