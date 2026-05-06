import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { AppSettings, HoldToRecordKey } from '../../shared/types';

// Hold-to-record key options
const HOLD_TO_RECORD_KEYS: Array<{ value: HoldToRecordKey; label: string }> = [
  { value: 'LeftAlt', label: 'Left Option (⌥)' },
  { value: 'RightAlt', label: 'Right Option (⌥)' },
  { value: 'LeftMeta', label: 'Left Command (⌘)' },
  { value: 'RightMeta', label: 'Right Command (⌘)' },
  { value: 'LeftControl', label: 'Left Control (⌃)' },
  { value: 'RightControl', label: 'Right Control (⌃)' },
  { value: 'LeftShift', label: 'Left Shift (⇧)' },
  { value: 'RightShift', label: 'Right Shift (⇧)' },
];
import { useTheme, ThemeMode } from '../contexts/ThemeContext';
import { Welcome } from '../components/Welcome';
import { ApiKeyHelp } from '../components/ApiKeyHelp';
import { ConfirmDialog } from '../components/ConfirmDialog';
import './SettingsPage.css';

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+R';

// Popular languages shown first (top 10 by native speakers)
const POPULAR_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'zh', name: 'Chinese' },
  { code: 'es', name: 'Spanish' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
];

// Other languages in alphabetical order (top 50 total)
const OTHER_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'sq', name: 'Albanian' },
  { code: 'am', name: 'Amharic' },
  { code: 'hy', name: 'Armenian' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'bn', name: 'Bengali' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'my', name: 'Burmese' },
  { code: 'ca', name: 'Catalan' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'fi', name: 'Finnish' },
  { code: 'ka', name: 'Georgian' },
  { code: 'el', name: 'Greek' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'kn', name: 'Kannada' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'ms', name: 'Malay' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'mr', name: 'Marathi' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'ne', name: 'Nepali' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'ro', name: 'Romanian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'sw', name: 'Swahili' },
  { code: 'sv', name: 'Swedish' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'vi', name: 'Vietnamese' },
];

const AVAILABLE_LANGUAGES = [...POPULAR_LANGUAGES, ...OTHER_LANGUAGES];

// Helper to get language name by code
const getLanguageName = (code: string): string => {
  const lang = AVAILABLE_LANGUAGES.find((l) => l.code === code);
  return lang ? lang.name : code; // Return code as name for custom languages
};

const SPEECH_DOMAINS = [
  { id: 'programming', name: 'Programming', hint: 'Code, APIs, technical terms' },
  { id: 'general', name: 'General', hint: 'Everyday conversation' },
  { id: 'cooking', name: 'Cooking', hint: 'Recipes, ingredients, kitchen' },
  { id: 'medical', name: 'Medical', hint: 'Healthcare, symptoms, medications' },
  { id: 'legal', name: 'Legal', hint: 'Contracts, law terms' },
  { id: 'academic', name: 'Academic', hint: 'Research, citations, science' },
  { id: 'business', name: 'Business', hint: 'Meetings, finance, reports' },
  { id: 'creative', name: 'Creative Writing', hint: 'Stories, poetry, scripts' },
  { id: 'custom', name: 'Custom', hint: 'Enter your own domain hint below' },
];

const MAX_CUSTOM_HINT_LENGTH = 500;
const MAX_CUSTOM_KEYWORDS_LENGTH = 1000;

// Tab definitions
type SettingsTab = 'general' | 'languages' | 'appearance' | 'advanced';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'languages', label: 'Languages' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'advanced', label: 'Advanced' },
];

interface AudioDevice {
  deviceId: string;
  label: string;
}

export function SettingsPage() {
  const { theme, setTheme, systemTheme } = useTheme();
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-3-flash-preview');
  const [languages, setLanguages] = useState<string[]>([]);
  const [speechDomain, setSpeechDomain] = useState('programming');
  const [customDomainHint, setCustomDomainHint] = useState('');
  const [customKeywords, setCustomKeywords] = useState('');
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState('');
  const [silenceDetectionEnabled, setSilenceDetectionEnabled] = useState(true);
  const [silenceDurationMs, setSilenceDurationMs] = useState(2500);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [clarificationEnabled, setClarificationEnabled] = useState(true);
  const [previousTranscriptContextEnabled, setPreviousTranscriptContextEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);
  const [widgetHidden, setWidgetHidden] = useState(false);
  const [holdToRecordEnabled, setHoldToRecordEnabled] = useState(true);
  const [holdToRecordKey, setHoldToRecordKey] = useState<HoldToRecordKey>('LeftAlt');
  const [autoPasteEnabled, setAutoPasteEnabled] = useState(true);
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [languageSearch, setLanguageSearch] = useState('');
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [showWelcome, setShowWelcome] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const isClosingRef = useRef(false);
  const hotkeyInputRef = useRef<HTMLButtonElement>(null);

  // Store initial settings for comparison
  const initialSettingsRef = useRef<{
    apiKey: string;
    model: string;
    languages: string[];
    speechDomain: string;
    customDomainHint: string;
    customKeywords: string;
    microphoneDeviceId: string;
    silenceDetectionEnabled: boolean;
    silenceDurationMs: number;
    launchAtStartup: boolean;
    clarificationEnabled: boolean;
    previousTranscriptContextEnabled: boolean;
    soundEnabled: boolean;
    hotkey: string;
    widgetHidden: boolean;
    holdToRecordEnabled: boolean;
    holdToRecordKey: HoldToRecordKey;
    autoPasteEnabled: boolean;
  } | null>(null);

  const themeOptions: Array<{ value: ThemeMode; label: string; previewTheme: 'dark' | 'light' }> = [
    { value: 'light', label: 'Light', previewTheme: 'light' },
    { value: 'dark', label: 'Dark', previewTheme: 'dark' },
    { value: 'system', label: 'System', previewTheme: systemTheme },
  ];

  // Check if there are unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (!initialSettingsRef.current) return false;
    const initial = initialSettingsRef.current;
    return (
      apiKey !== initial.apiKey ||
      model !== initial.model ||
      JSON.stringify(languages) !== JSON.stringify(initial.languages) ||
      speechDomain !== initial.speechDomain ||
      customDomainHint !== initial.customDomainHint ||
      customKeywords !== initial.customKeywords ||
      microphoneDeviceId !== initial.microphoneDeviceId ||
      silenceDetectionEnabled !== initial.silenceDetectionEnabled ||
      silenceDurationMs !== initial.silenceDurationMs ||
      launchAtStartup !== initial.launchAtStartup ||
      clarificationEnabled !== initial.clarificationEnabled ||
      previousTranscriptContextEnabled !== initial.previousTranscriptContextEnabled ||
      soundEnabled !== initial.soundEnabled ||
      hotkey !== initial.hotkey ||
      widgetHidden !== initial.widgetHidden ||
      holdToRecordEnabled !== initial.holdToRecordEnabled ||
      holdToRecordKey !== initial.holdToRecordKey ||
      autoPasteEnabled !== initial.autoPasteEnabled
    );
  }, [
    apiKey,
    model,
    languages,
    speechDomain,
    customDomainHint,
    customKeywords,
    microphoneDeviceId,
    silenceDetectionEnabled,
    silenceDurationMs,
    launchAtStartup,
    clarificationEnabled,
    previousTranscriptContextEnabled,
    soundEnabled,
    hotkey,
    widgetHidden,
    holdToRecordEnabled,
    holdToRecordKey,
    autoPasteEnabled,
  ]);

  // Load audio devices
  useEffect(() => {
    async function loadAudioDevices() {
      try {
        // Request permission first to get device labels
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Stop all tracks immediately to release the microphone
        stream.getTracks().forEach(track => track.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const microphones = devices
          .filter((device) => device.kind === 'audioinput')
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          }));
        setAudioDevices(microphones);
      } catch (error) {
        console.error('[Settings] Failed to load audio devices:', error);
      }
    }
    loadAudioDevices();
  }, []);

  // Load settings on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        const settings = await window.electronAPI.getSettings();
        const loadedApiKey = settings.apiKey;
        const loadedModel = settings.model;
        const loadedSpeechDomain = settings.speechDomain || 'programming';
        const loadedCustomDomainHint = settings.customDomainHint || '';
        const loadedCustomKeywords = settings.customKeywords || '';
        const loadedLanguages = settings.languages || [];
        const loadedMicrophoneDeviceId = settings.microphoneDeviceId || '';
        const loadedSilenceDetectionEnabled = settings.silenceDetectionEnabled ?? true;
        const loadedSilenceDurationMs = settings.silenceDurationMs || 2500;
        const loadedLaunchAtStartup = settings.launchAtStartup ?? false;
        const loadedClarificationEnabled = settings.clarificationEnabled ?? true;
        const loadedPreviousTranscriptContextEnabled = settings.previousTranscriptContextEnabled ?? true;
        const loadedSoundEnabled = settings.soundEnabled ?? true;
        const loadedHotkey = settings.hotkey || DEFAULT_HOTKEY;
        const loadedWidgetHidden = settings.widgetHidden ?? false;
        const loadedHoldToRecordEnabled = settings.holdToRecordEnabled ?? true;
        const loadedHoldToRecordKey = (settings.holdToRecordKey as HoldToRecordKey) || 'LeftAlt';
        const loadedAutoPasteEnabled = settings.autoPasteEnabled ?? true;

        setApiKey(loadedApiKey);
        setModel(loadedModel);
        setSpeechDomain(loadedSpeechDomain);
        setCustomDomainHint(loadedCustomDomainHint);
        setCustomKeywords(loadedCustomKeywords);
        setLanguages(loadedLanguages);
        setMicrophoneDeviceId(loadedMicrophoneDeviceId);
        setSilenceDetectionEnabled(loadedSilenceDetectionEnabled);
        setSilenceDurationMs(loadedSilenceDurationMs);
        setLaunchAtStartup(loadedLaunchAtStartup);
        setClarificationEnabled(loadedClarificationEnabled);
        setPreviousTranscriptContextEnabled(loadedPreviousTranscriptContextEnabled);
        setSoundEnabled(loadedSoundEnabled);
        setHotkey(loadedHotkey);
        setWidgetHidden(loadedWidgetHidden);
        setHoldToRecordEnabled(loadedHoldToRecordEnabled);
        setHoldToRecordKey(loadedHoldToRecordKey);
        setAutoPasteEnabled(loadedAutoPasteEnabled);

        // Store initial settings for unsaved changes comparison
        initialSettingsRef.current = {
          apiKey: loadedApiKey,
          model: loadedModel,
          languages: [...loadedLanguages],
          speechDomain: loadedSpeechDomain,
          customDomainHint: loadedCustomDomainHint,
          customKeywords: loadedCustomKeywords,
          microphoneDeviceId: loadedMicrophoneDeviceId,
          silenceDetectionEnabled: loadedSilenceDetectionEnabled,
          silenceDurationMs: loadedSilenceDurationMs,
          launchAtStartup: loadedLaunchAtStartup,
          clarificationEnabled: loadedClarificationEnabled,
          previousTranscriptContextEnabled: loadedPreviousTranscriptContextEnabled,
          soundEnabled: loadedSoundEnabled,
          hotkey: loadedHotkey,
          widgetHidden: loadedWidgetHidden,
          holdToRecordEnabled: loadedHoldToRecordEnabled,
          holdToRecordKey: loadedHoldToRecordKey,
          autoPasteEnabled: loadedAutoPasteEnabled,
        };
      } catch (error) {
        console.error('[Settings] Failed to load:', error);
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, []);

  const handleLanguageToggle = (code: string) => {
    setLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code]
    );
  };

  const handleAddCustomLanguage = () => {
    const trimmed = languageSearch.trim();
    if (trimmed && !languages.includes(trimmed)) {
      setLanguages((prev) => [...prev, trimmed]);
      setLanguageSearch('');
    }
  };

  // Filter languages based on search
  const filterLanguages = (langList: typeof AVAILABLE_LANGUAGES) => {
    if (!languageSearch.trim()) return langList;
    const search = languageSearch.toLowerCase();
    return langList.filter((lang) => lang.name.toLowerCase().includes(search));
  };

  const filteredPopular = filterLanguages(POPULAR_LANGUAGES);
  const filteredOther = filterLanguages(OTHER_LANGUAGES);
  const hasSearchResults = filteredPopular.length > 0 || filteredOther.length > 0;

  // Check if search term could be a custom language
  const searchTrimmed = languageSearch.trim();
  const isCustomLanguageCandidate = searchTrimmed.length > 0 &&
    !hasSearchResults &&
    !languages.includes(searchTrimmed);

  const handleRemoveLanguage = (code: string) => {
    setLanguages((prev) => prev.filter((l) => l !== code));
  };

  const handleMoveLanguage = (index: number, direction: 'up' | 'down') => {
    setLanguages((prev) => {
      const newList = [...prev];
      const newIndex = direction === 'up' ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= newList.length) return prev;
      [newList[index], newList[newIndex]] = [newList[newIndex], newList[index]];
      return newList;
    });
  };

  const handleCustomHintChange = (value: string) => {
    if (value.length <= MAX_CUSTOM_HINT_LENGTH) {
      setCustomDomainHint(value);
    }
  };

  const handleCustomKeywordsChange = (value: string) => {
    if (value.length <= MAX_CUSTOM_KEYWORDS_LENGTH) {
      setCustomKeywords(value);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage('');

    try {
      const success = await window.electronAPI.saveSettings({
        apiKey,
        model,
        languages,
        speechDomain,
        customDomainHint: customDomainHint.trim(),
        customKeywords: customKeywords.trim(),
        microphoneDeviceId,
        silenceDetectionEnabled,
        silenceDurationMs,
        launchAtStartup,
        clarificationEnabled,
        previousTranscriptContextEnabled,
        soundEnabled,
        hotkey,
        widgetHidden,
        holdToRecordEnabled,
        holdToRecordKey,
        autoPasteEnabled,
      });
      if (success) {
        // Update initial settings so hasUnsavedChanges becomes false
        initialSettingsRef.current = {
          apiKey,
          model,
          languages: [...languages],
          speechDomain,
          customDomainHint: customDomainHint.trim(),
          customKeywords: customKeywords.trim(),
          microphoneDeviceId,
          silenceDetectionEnabled,
          silenceDurationMs,
          launchAtStartup,
          clarificationEnabled,
          previousTranscriptContextEnabled,
          soundEnabled,
          hotkey,
          widgetHidden,
          holdToRecordEnabled,
          holdToRecordKey,
          autoPasteEnabled,
        };
        setSaveMessage('Saved!');
        setTimeout(() => {
          isClosingRef.current = true;
          window.electronAPI.closeSettingsWindow();
        }, 500);
      } else {
        setSaveMessage('Failed to save');
      }
    } catch (error) {
      setSaveMessage('Failed to save');
    }

    setIsSaving(false);
  };

  const handleCancel = () => {
    if (hasUnsavedChanges) {
      setShowCancelDialog(true);
    } else {
      window.electronAPI.closeSettingsWindow();
    }
  };

  const handleConfirmCancel = () => {
    isClosingRef.current = true;
    setShowCancelDialog(false);
    window.electronAPI.closeSettingsWindow();
  };

  const handleCancelDialogClose = () => {
    setShowCancelDialog(false);
  };

  // Handle window close (beforeunload) with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges && !isClosingRef.current) {
        e.preventDefault();
        // Show custom dialog instead of browser default
        setShowCancelDialog(true);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Show onboarding if no API key is set
  const handleApiKeySubmit = (newApiKey: string) => {
    setApiKey(newApiKey);
    setShowWelcome(false);
  };

  const handleResetWelcome = () => {
    setShowWelcome(true);
  };

  // Convert Electron accelerator to human-readable format
  const formatHotkeyForDisplay = (accelerator: string): string => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    return accelerator
      .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
      .replace(/Command/g, '⌘')
      .replace(/Control/g, isMac ? '⌃' : 'Ctrl')
      .replace(/Alt/g, isMac ? '⌥' : 'Alt')
      .replace(/Shift/g, isMac ? '⇧' : 'Shift')
      .replace(/\+/g, ' + ');
  };

  // Handle hotkey recording
  const handleHotkeyKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isRecordingHotkey) return;

    e.preventDefault();
    e.stopPropagation();

    // Ignore modifier-only presses
    if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) {
      return;
    }

    // Build accelerator string
    const parts: string[] = [];

    if (e.metaKey || e.ctrlKey) {
      parts.push('CommandOrControl');
    }
    if (e.altKey) {
      parts.push('Alt');
    }
    if (e.shiftKey) {
      parts.push('Shift');
    }

    // Get key name
    let key = e.key;
    if (key.length === 1) {
      key = key.toUpperCase();
    } else if (key === 'Escape') {
      // Cancel recording on Escape
      setIsRecordingHotkey(false);
      return;
    } else {
      // Map special keys to Electron accelerator names
      const keyMap: Record<string, string> = {
        'ArrowUp': 'Up',
        'ArrowDown': 'Down',
        'ArrowLeft': 'Left',
        'ArrowRight': 'Right',
        ' ': 'Space',
        'Backspace': 'Backspace',
        'Delete': 'Delete',
        'Enter': 'Return',
        'Home': 'Home',
        'End': 'End',
        'PageUp': 'PageUp',
        'PageDown': 'PageDown',
        'Insert': 'Insert',
      };
      key = keyMap[key] || key;
    }

    parts.push(key);

    // Require at least one modifier
    if (parts.length < 2) {
      return;
    }

    const newHotkey = parts.join('+');
    setHotkey(newHotkey);
    setIsRecordingHotkey(false);
  }, [isRecordingHotkey]);

  const startRecordingHotkey = () => {
    setIsRecordingHotkey(true);
    // Focus the button to capture key events
    hotkeyInputRef.current?.focus();
  };

  const resetHotkey = () => {
    setHotkey(DEFAULT_HOTKEY);
    setIsRecordingHotkey(false);
  };

  if (isLoading) {
    return (
      <div className="settings-page">
        <div className="settings-loading">Loading...</div>
      </div>
    );
  }

  // Show Welcome screen if no API key or if explicitly requested
  if (!apiKey || showWelcome) {
    return <Welcome onApiKeySubmit={handleApiKeySubmit} initialApiKey={apiKey} />;
  }

  return (
    <div className="settings-page">
      {/* Tab Navigation */}
      <div className="settings-tabs" role="tablist">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`settings-tab${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="settings-content">
        {/* General Tab */}
        {activeTab === 'general' && (
          <>
            <div className="settings-field">
              <label htmlFor="api-key">Gemini API Key</label>
              <input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API key"
                autoComplete="off"
              />
              <ApiKeyHelp />
            </div>

            <div className="settings-field">
              <label htmlFor="model">Model</label>
              <input
                id="model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gemini-3-flash-preview"
              />
              <span className="settings-hint">Default: gemini-3-flash-preview</span>
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={launchAtStartup}
                  onChange={(e) => setLaunchAtStartup(e.target.checked)}
                />
                <span>Launch at startup</span>
              </label>
              <span className="settings-hint">
                Automatically start the app when you log in
              </span>
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={(e) => setSoundEnabled(e.target.checked)}
                />
                <span>Sound feedback</span>
              </label>
              <span className="settings-hint">
                Play a sound when transcription completes or fails
              </span>
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={widgetHidden}
                  onChange={(e) => setWidgetHidden(e.target.checked)}
                />
                <span>Hide widget permanently</span>
              </label>
              <span className="settings-hint">
                The widget will be hidden. Use tray menu to show it.
              </span>
            </div>

            <div className="settings-field">
              <label>Global Hotkey</label>
              <div className="hotkey-input-container">
                <button
                  ref={hotkeyInputRef}
                  type="button"
                  className={`hotkey-input${isRecordingHotkey ? ' is-recording' : ''}`}
                  onClick={startRecordingHotkey}
                  onKeyDown={handleHotkeyKeyDown}
                  onBlur={() => setIsRecordingHotkey(false)}
                >
                  {isRecordingHotkey
                    ? 'Press a key combination...'
                    : formatHotkeyForDisplay(hotkey)}
                </button>
                {hotkey !== DEFAULT_HOTKEY && (
                  <button
                    type="button"
                    className="hotkey-reset-btn"
                    onClick={resetHotkey}
                    title="Reset to default"
                  >
                    Reset
                  </button>
                )}
              </div>
              <span className="settings-hint">
                Click to change. Use Cmd/Ctrl + other keys. Escape to cancel.
              </span>
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={holdToRecordEnabled}
                  onChange={(e) => setHoldToRecordEnabled(e.target.checked)}
                />
                <span>Hold-to-record</span>
              </label>
              <span className="settings-hint">
                Hold a key to record, release to transcribe. Works alongside the toggle hotkey.
              </span>
            </div>

            {holdToRecordEnabled && (
              <div className="settings-field">
                <label>Hold Key</label>
                <select
                  value={holdToRecordKey}
                  onChange={(e) => setHoldToRecordKey(e.target.value as HoldToRecordKey)}
                  className="settings-select"
                >
                  {HOLD_TO_RECORD_KEYS.map((key) => (
                    <option key={key.value} value={key.value}>
                      {key.label}
                    </option>
                  ))}
                </select>
                <span className="settings-hint">
                  Note: Globe / Fn key cannot be detected by any application.
                </span>
              </div>
            )}

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoPasteEnabled}
                  onChange={(e) => setAutoPasteEnabled(e.target.checked)}
                />
                <span>Auto-paste transcript</span>
              </label>
              <span className="settings-hint">
                After transcription, simulate ⌘V / Ctrl+V into the active window. Requires Accessibility permission on macOS.
              </span>
            </div>

            <div className="settings-field">
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleResetWelcome}
                type="button"
              >
                Reset Welcome Screen
              </button>
              <span className="settings-hint">
                Show the initial setup screen again
              </span>
            </div>
          </>
        )}

        {/* Languages Tab */}
        {activeTab === 'languages' && (
          <>
            <div className="settings-field">
              <label>Primary Languages</label>

              {/* Selected languages with reordering */}
              {languages.length > 0 && (
                <div className="selected-languages">
                  <span className="selected-languages-label">Selected (first is primary):</span>
                  <div className="selected-languages-list">
                    {languages.map((code, index) => (
                      <div key={code} className="selected-language-item">
                        <span className="selected-language-name">{getLanguageName(code)}</span>
                        <div className="selected-language-controls">
                          <button
                            type="button"
                            className="language-move-btn"
                            onClick={() => handleMoveLanguage(index, 'up')}
                            disabled={index === 0}
                            title="Move up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="language-move-btn"
                            onClick={() => handleMoveLanguage(index, 'down')}
                            disabled={index === languages.length - 1}
                            title="Move down"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="language-remove-btn"
                            onClick={() => handleRemoveLanguage(code)}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Search input */}
              <div className="language-search">
                <input
                  type="text"
                  value={languageSearch}
                  onChange={(e) => setLanguageSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isCustomLanguageCandidate) {
                      e.preventDefault();
                      handleAddCustomLanguage();
                    }
                  }}
                  placeholder="Search languages..."
                />
              </div>

              {/* Language groups */}
              <div className="language-groups">
                {/* Popular languages */}
                {filteredPopular.length > 0 && (
                  <div className="language-group">
                    {!languageSearch.trim() && (
                      <span className="language-group-label">Popular</span>
                    )}
                    <div className="language-grid">
                      {filteredPopular.map((lang) => (
                        <label key={lang.code} className="language-option">
                          <input
                            type="checkbox"
                            checked={languages.includes(lang.code)}
                            onChange={() => handleLanguageToggle(lang.code)}
                          />
                          <span>{lang.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Other languages */}
                {filteredOther.length > 0 && (
                  <div className="language-group">
                    {!languageSearch.trim() && (
                      <span className="language-group-label">More</span>
                    )}
                    <div className="language-grid">
                      {filteredOther.map((lang) => (
                        <label key={lang.code} className="language-option">
                          <input
                            type="checkbox"
                            checked={languages.includes(lang.code)}
                            onChange={() => handleLanguageToggle(lang.code)}
                          />
                          <span>{lang.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* No results - offer to add custom */}
                {isCustomLanguageCandidate && (
                  <div className="language-no-results">
                    <span>No language found for "{searchTrimmed}"</span>
                    <button
                      type="button"
                      className="add-custom-language-btn"
                      onClick={handleAddCustomLanguage}
                    >
                      Add "{searchTrimmed}" as custom language
                    </button>
                  </div>
                )}
              </div>

              <span className="settings-hint">
                Search to filter, or type a custom language name and press Enter to add.
              </span>
            </div>
          </>
        )}

        {/* Appearance Tab */}
        {activeTab === 'appearance' && (
          <>
            <div className="settings-field">
              <label>Theme</label>
              <div className="settings-theme-options" role="radiogroup" aria-label="Theme">
                {themeOptions.map((option) => (
                  <label
                    key={option.value}
                    className={`settings-theme-option${theme === option.value ? ' is-selected' : ''}`}
                  >
                    <span className="settings-theme-label">
                      <input
                        type="radio"
                        name="theme"
                        value={option.value}
                        checked={theme === option.value}
                        onChange={() => setTheme(option.value)}
                      />
                      <span>{option.label}</span>
                    </span>
                    <span className="settings-theme-preview" data-theme={option.previewTheme} aria-hidden="true">
                      <span className="settings-theme-swatch settings-theme-swatch--bg" />
                      <span className="settings-theme-swatch settings-theme-swatch--surface" />
                      <span className="settings-theme-swatch settings-theme-swatch--text">Aa</span>
                    </span>
                  </label>
                ))}
              </div>
              <span className="settings-hint">System follows your OS appearance.</span>
            </div>
          </>
        )}

        {/* Advanced Tab */}
        {activeTab === 'advanced' && (
          <>
            <div className="settings-field">
              <label htmlFor="speech-domain">Speech Domain</label>
              <select
                id="speech-domain"
                value={speechDomain}
                onChange={(e) => setSpeechDomain(e.target.value)}
              >
                {SPEECH_DOMAINS.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name}
                  </option>
                ))}
              </select>
              <span className="settings-hint">
                {SPEECH_DOMAINS.find((d) => d.id === speechDomain)?.hint || 'Select domain for better accuracy'}
              </span>
              {speechDomain === 'custom' && (
                <>
                  <input
                    id="custom-domain-hint"
                    type="text"
                    value={customDomainHint}
                    onChange={(e) => handleCustomHintChange(e.target.value)}
                    placeholder="e.g., gardening terms, music production, sports commentary..."
                    style={{ marginTop: '8px' }}
                  />
                  <span className="settings-hint">
                    {customDomainHint.length}/{MAX_CUSTOM_HINT_LENGTH} characters
                  </span>
                </>
              )}
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={clarificationEnabled}
                  onChange={(e) => setClarificationEnabled(e.target.checked)}
                />
                <span>Clarification</span>
              </label>
              <span className="settings-hint">
                Clean up speech disfluencies (uh, um, stutters, filler words) for clearer text
              </span>
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={previousTranscriptContextEnabled}
                  onChange={(e) => setPreviousTranscriptContextEnabled(e.target.checked)}
                />
                <span>Use previous transcript as context</span>
              </label>
              <span className="settings-hint">
                Include the previous transcription to improve accuracy for related speech
              </span>
            </div>

            <div className="settings-field">
              <label htmlFor="custom-keywords">Custom Keywords</label>
              <textarea
                id="custom-keywords"
                value={customKeywords}
                onChange={(e) => handleCustomKeywordsChange(e.target.value)}
                placeholder={`Default keywords (always included):\nCLAUDE.md = Cloud MD\nWIX = vix\n\nAdd your own below...`}
                rows={4}
              />
              <span className="settings-hint">
                One per line. Use "Target = alias1, alias2" for corrections.
              </span>
              <span className="settings-hint">
                {customKeywords.length}/{MAX_CUSTOM_KEYWORDS_LENGTH} characters
              </span>
            </div>

            <div className="settings-field">
              <label htmlFor="microphone">Microphone</label>
              <select
                id="microphone"
                value={microphoneDeviceId}
                onChange={(e) => setMicrophoneDeviceId(e.target.value)}
              >
                <option value="">System Default</option>
                {audioDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <span className="settings-hint">
                Select audio input device
              </span>
            </div>

            <div className="settings-field">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={silenceDetectionEnabled}
                  onChange={(e) => setSilenceDetectionEnabled(e.target.checked)}
                />
                <span>Auto-stop on silence</span>
              </label>
              {silenceDetectionEnabled && (
                <div className="slider-container">
                  <input
                    type="range"
                    min="1000"
                    max="10000"
                    step="500"
                    value={silenceDurationMs}
                    onChange={(e) => setSilenceDurationMs(Number(e.target.value))}
                  />
                  <span className="slider-value">{(silenceDurationMs / 1000).toFixed(1)}s</span>
                </div>
              )}
              <span className="settings-hint">
                Automatically stop recording after a period of silence
              </span>
            </div>
          </>
        )}
      </div>

      <div className="settings-footer">
        {saveMessage && <span className="settings-message">{saveMessage}</span>}
        <button className="settings-btn settings-btn-secondary" onClick={handleCancel}>
          Cancel
        </button>
        <button
          className="settings-btn settings-btn-primary"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>

      <ConfirmDialog
        isOpen={showCancelDialog}
        title="Unsaved Changes"
        message="Are you sure? All changes will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        onConfirm={handleConfirmCancel}
        onCancel={handleCancelDialogClose}
      />
    </div>
  );
}
