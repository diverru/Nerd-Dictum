import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import { ThemeProvider } from '../contexts/ThemeContext';

const defaultSettings = {
  apiKey: 'test-api-key',
  model: 'gemini-3-flash-preview',
  languages: ['en'],
  speechDomain: 'programming',
  customDomainHint: '',
  customKeywords: '',
  microphoneDeviceId: '',
  silenceDetectionEnabled: true,
  silenceDurationMs: 2500,
  launchAtStartup: false,
  clarificationEnabled: true,
  previousTranscriptContextEnabled: true,
};

const createMockElectronAPI = (overrides: Partial<typeof window.electronAPI> = {}) => ({
  getSettings: mock(() => Promise.resolve({ ...defaultSettings })),
  saveSettings: mock(() => Promise.resolve(true)),
  closeSettingsWindow: mock(() => Promise.resolve()),
  openExternalUrl: mock(() => Promise.resolve(true)),
  // These are required by the interface but not used in SettingsPage tests
  getApiKey: mock(() => Promise.resolve('test-api-key')),
  getModel: mock(() => Promise.resolve('gemini-3-flash-preview')),
  copyToClipboard: mock(() => Promise.resolve(true)),
  onToggleRecording: mock(() => () => {}),
  onStartRecording: mock(() => () => {}),
  onStopRecording: mock(() => () => {}),
  openSettingsWindow: mock(() => Promise.resolve(true)),
  openInfoWindow: mock(() => Promise.resolve(true)),
  getMicrophonePermissionStatus: mock(() => Promise.resolve('granted' as const)),
  requestMicrophonePermission: mock(() => Promise.resolve(true)),
  getAppVersion: mock(() => Promise.resolve('1.0.0')),
  getRecentTranscripts: mock(() => Promise.resolve([])),
  ...overrides,
});

// Mock navigator.mediaDevices
const mockMediaDevices = {
  getUserMedia: mock(() => Promise.resolve({ getTracks: () => [] })),
  enumerateDevices: mock(() => Promise.resolve([])),
};

function renderSettingsPage(electronAPI = createMockElectronAPI()) {
  window.electronAPI = electronAPI as typeof window.electronAPI;
  return render(
    <ThemeProvider>
      <SettingsPage />
    </ThemeProvider>
  );
}

describe('SettingsPage - Unsaved Changes Dialog', () => {
  let originalMediaDevices: MediaDevices;

  beforeEach(() => {
    originalMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: mockMediaDevices,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    });
  });

  it('should NOT show dialog when Cancel is clicked with no changes', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Click Cancel without making any changes
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    // Dialog should NOT appear
    expect(screen.queryByText('Unsaved Changes')).toBeNull();

    // Window should close immediately
    expect(mockAPI.closeSettingsWindow).toHaveBeenCalled();
  });

  it('should show dialog when Cancel is clicked with unsaved changes', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change to the model field
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Click Cancel
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    // Dialog should appear
    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    expect(screen.getByText('Are you sure? All changes will be lost.')).toBeTruthy();

    // Window should NOT close yet
    expect(mockAPI.closeSettingsWindow).not.toHaveBeenCalled();
  });

  it('should close window when Discard is clicked in dialog', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Click Cancel to show dialog
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    // Click Discard
    const discardButton = screen.getByRole('button', { name: 'Discard' });
    fireEvent.click(discardButton);

    // Window should close
    expect(mockAPI.closeSettingsWindow).toHaveBeenCalled();

    // Dialog should be hidden
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
  });

  it('should hide dialog and stay when Stay is clicked', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Click Cancel to show dialog
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    // Verify dialog is shown
    expect(screen.getByText('Unsaved Changes')).toBeTruthy();

    // Click Stay
    const stayButton = screen.getByRole('button', { name: 'Stay' });
    fireEvent.click(stayButton);

    // Dialog should be hidden
    expect(screen.queryByText('Unsaved Changes')).toBeNull();

    // Window should NOT close
    expect(mockAPI.closeSettingsWindow).not.toHaveBeenCalled();

    // Settings page should still be visible with changes intact
    expect((screen.getByLabelText('Google (Gemini) model') as HTMLInputElement).value).toBe('new-model');
  });

  it('should NOT show dialog after successful Save', async () => {
    // This test reproduces the bug where Save shows the "Unsaved Changes" dialog.
    // The bug occurs because:
    // 1. User makes changes (hasUnsavedChanges = true)
    // 2. User clicks Save
    // 3. Save succeeds, initialSettingsRef is updated
    // 4. After 500ms, closeSettingsWindow() is called
    // 5. closeSettingsWindow triggers beforeunload
    // 6. beforeunload handler checks hasUnsavedChanges - should be false now

    // Create mock that triggers beforeunload when closeSettingsWindow is called
    // (simulating what Electron does when closing a window)
    const mockAPI = createMockElectronAPI({
      closeSettingsWindow: mock(() => {
        window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
        return Promise.resolve(true);
      }),
    });
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Click Save
    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    // Wait for save to complete
    await waitFor(() => {
      expect(mockAPI.saveSettings).toHaveBeenCalled();
    });

    // Wait for the 500ms timeout that triggers closeSettingsWindow
    await waitFor(() => {
      expect(mockAPI.closeSettingsWindow).toHaveBeenCalled();
    }, { timeout: 1000 });

    // Dialog should NOT appear because initialSettingsRef was updated before close
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
  });

  it('should detect changes to various fields', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Test checkbox change (Launch at startup) - on General tab by default
    const launchCheckbox = screen.getByLabelText('Launch at startup');
    fireEvent.click(launchCheckbox);

    // Click Cancel - should show dialog
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
  });

  it('should detect changes to language selection', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Switch to Languages tab first
    const languagesTab = screen.getByRole('tab', { name: 'Languages' });
    fireEvent.click(languagesTab);

    // Toggle a language
    const russianCheckbox = screen.getByLabelText('Russian');
    fireEvent.click(russianCheckbox);

    // Click Cancel - should show dialog
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
  });

  it('should NOT show dialog when changes are reverted to initial state', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    const originalValue = (modelInput as HTMLInputElement).value;
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Revert the change
    fireEvent.change(modelInput, { target: { value: originalValue } });

    // Click Cancel - should NOT show dialog
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    expect(screen.queryByText('Unsaved Changes')).toBeNull();
    expect(mockAPI.closeSettingsWindow).toHaveBeenCalled();
  });

  it('should handle beforeunload event with unsaved changes', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Simulate beforeunload event
    const beforeUnloadEvent = new Event('beforeunload', { cancelable: true });
    const preventDefaultSpy = spyOn(beforeUnloadEvent, 'preventDefault');
    window.dispatchEvent(beforeUnloadEvent);

    // preventDefault should have been called
    expect(preventDefaultSpy).toHaveBeenCalled();

    // Dialog should appear (need to wait for state update)
    await waitFor(() => {
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });
  });

  it('should NOT trigger beforeunload dialog after Discard was clicked', async () => {
    const mockAPI = createMockElectronAPI();
    renderSettingsPage(mockAPI);

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    // Make a change
    const modelInput = screen.getByLabelText('Google (Gemini) model');
    fireEvent.change(modelInput, { target: { value: 'new-model' } });

    // Click Cancel to show dialog
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    // Click Discard - this sets isClosingRef to true
    const discardButton = screen.getByRole('button', { name: 'Discard' });
    fireEvent.click(discardButton);

    // Now simulate beforeunload (which would happen when window actually closes)
    const beforeUnloadEvent = new Event('beforeunload', { cancelable: true });
    const preventDefaultSpy = spyOn(beforeUnloadEvent, 'preventDefault');
    window.dispatchEvent(beforeUnloadEvent);

    // preventDefault should NOT have been called because isClosingRef is true
    expect(preventDefaultSpy).not.toHaveBeenCalled();

    // Dialog should NOT reappear
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
  });
});
