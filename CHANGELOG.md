# Changelog

## 2026-05-06 (diverru fork)

[2026-05-06] Audio — Switched the recorder output format from raw WAV PCM to opus (`audio/webm;codecs=opus`, 24 kbps) for ~10× smaller uploads to Gemini. Optional `retainPcmForWav` flag still produces a 16 kHz mono WAV for downstream local pipelines.

[2026-05-06] UX — Redesigned audio feedback: a new ascending blip on record start (600→900 Hz), a band-pass-filtered noise burst on success (subtle click), and a low double-blip square wave on error.

[2026-05-06] Tooling — Renderer-side `log()` calls are now forwarded to the main-process log file at `~/Library/Logs/Nerd Dictum/main.log` via `ipcRenderer.send('renderer-log', …)`. Diagnostics from React land in the same place as everything else.

## 2026-04-22

[2026-04-22] Bug — Fix `PROHIBITED_CONTENT` safety-filter false positives from Gemini: on safety block, automatically flush the `<previous_transcripts>` context and retry the request once without it before surfacing the error
[2026-04-22] Dev — Surface transcription failures: log every failed Gemini attempt with name/message/statusCode/responseBody (first 2000 chars) in renderer console, and log the final classified error in `App.tsx` — previously errors were silently swallowed between retries
[2026-04-22] Dev — Pass permissive `safetySettings` (`BLOCK_NONE` on all categories) in Gemini requests to reduce spurious safety blocks, and handle `promptFeedback.blockReason` / candidate `finishReason` in the response so blocks produce actionable error messages instead of "Empty response from API"

## 2026-03-29

[2026-03-29] Dev — Stop the CI Trivy PR comment from posting "no vulnerabilities found" noise; empty reports now skip PR comments and delete any stale Trivy comment instead
[2026-03-29] Revert — Remove Gemini Live transcription mode and restore the classic batch-only Gemini transcription flow; deletes live-specific settings, audio playback, and live session handling introduced on 2026-03-28

## 2026-03-27

[2026-03-27] Dev — Switch the macOS release job from a self-hosted runner to the standard GitHub-hosted `macos-15` runner now that the repository is public, and update release/auto-update GitHub config (`release.yml`, `package.json`, `dev-app-update.yml`, `main.ts`) from private to public
[2026-03-27] Dev — Change `bun run dev:mac:tmux` to keep the logs pane in a top/bottom tmux layout by using `split-window -v` with `select-layout even-vertical` instead of the side-by-side `even-horizontal` layout
[2026-03-27] Docs — Update `AGENTS.md` to require immediate commits for completed code/config/docs changes unless the user explicitly asks not to commit yet
[2026-03-27] Docs — Update `AGENTS.md` to require terminal-only Git editors during rebase/merge/commit flows; agents must avoid opening GUI editors and prefer non-interactive Git commands such as `-m`, `--no-edit`, or `GIT_EDITOR=true`
[2026-03-27] Dev — Add `LOCAL_DEV_BUILD` runtime mode for packaged local macOS builds: disables auto-updates, shows `dev` version label, and adds `bun run dev:mac` / `bun run dev:mac:build` workflow; `dev:mac` now launches via `open -W`, captures stdout/stderr to `.dev3/tmp`, stops an existing packaged dev instance before restart, and kills it again when the dev-server process exits, while `dev:mac:tmux` opens a split tmux pane for live logs; update `.dev3/config.json` to use the packaged dev app flow and stop deleting the committed `build/` directory during cleanup

## 2026-02-08

[2026-02-08] Feature — Drag-and-drop file support: drop MP3, WAV, or OGG files onto the widget to transcribe them via Gemini; drop any other file to copy its full path to clipboard with success feedback

## 2026-02-03

[2026-02-08] Security — Upgrade Electron from 33.4.11 to 35.7.5 to fix CVE-2025-55305 (ASAR Integrity Bypass via resource modification)
[2026-02-08] Feature — API error detail popup: when API returns an error (including HTML responses), clicking the error flash message opens a dedicated window showing the HTTP status code, error message, and full response body; HTML responses are rendered in a sandboxed iframe for readability
[2026-02-03] Bug — Fix crash on quit: remove call to undefined stopKeyboardHook() left over from uiohook-napi removal
[2026-02-03] Bug — Fix macOS microphone indicator staying active when opening Settings; properly release MediaStream after enumerating audio devices
[2026-02-03] Feature — Auto-lower volume during recording: lowers system volume to 10% when recording starts, restores original level after transcription completes (macOS only); works universally with any app playing audio
[2026-02-03] Feature — Add usage statistics: track total transcriptions, words, characters, recording time with 30-day activity graph; view stats via bar chart button (left of widget); includes streak counter, most active day, time saved estimate, and reset option

## 2026-02-01

[2026-02-01] Feature — Add hold-to-record mode: hold a modifier key (Right Command by default) to record, release to transcribe; works alongside the toggle hotkey (⌘⇧R); configurable in Settings > General with support for left/right variants of Command, Option, Control, and Shift keys
[2026-02-01] Feature — Add Google Analytics 4 integration for real-time usage tracking: app_start, recording_start, recording_stop, transcription_success, transcription_error events
[2026-02-01] Feature — Add "Forever" option to hide popup: hide widget permanently until manually shown via tray menu
[2026-02-01] Feature — Add "Hide widget permanently" setting in General tab: disable widget visibility persistently across restarts

## 2026-01-28

[2026-01-28] Feature — Expand conversation context: include last 3 transcripts (instead of 1) for better accuracy in ongoing conversations
[2026-01-28] Feature — Add customizable global hotkey: change the recording shortcut from default ⌘⇧R to any key combination; configure in Settings > General
[2026-01-28] Feature — Add hide button (eye icon) with popup menu to temporarily hide widget for 10 minutes, 1 hour, 3 hours, or until end of day; widget automatically reappears after selected duration

## 2026-01-27

[2026-01-27] Feature — Add sound feedback on transcription completion: success chime when text is copied to clipboard, error tone on failure; toggle in Settings > General

## 2026-01-25

[2026-01-25] Feature — Enforce single instance: prevent multiple app instances from running simultaneously; second launch focuses existing window instead
[2026-01-25] UX — Add explicit cancel indication during transcription: hover shows ✕ icon over spinner, tooltip "Click to cancel", improved accessibility with aria-label
[2026-01-25] UX — Split settings page into 4 tabs: General (API key, model, launch at startup), Languages, Appearance (theme), Advanced (speech domain, clarification, keywords, microphone, silence detection); improves navigation in large settings page
[2026-01-25] UX — Add confirmation dialog when canceling settings with unsaved changes; prevents accidental data loss via Cancel button or window close
[2026-01-25] UX — Improve language selection: add search field to filter languages, group by popularity (Popular first, then alphabetical), unified search+add UX for custom languages
[2026-01-25] Bug — Fix race condition in transcribeWithRetry: abort existing transcription before starting new one, ensure atomic request ID assignment to prevent duplicate API calls under rapid user interaction
[2026-01-25] Feature — Add "Use previous transcript as context" setting (enabled by default) to include the last transcription as context for Gemini API, improving accuracy for related speech
[2026-01-25] Performance — Move update check and microphone permission request to background; UI now appears instantly on startup instead of waiting for these operations
[2026-01-25] Feature — Add Clarification setting (enabled by default) to clean up speech disfluencies (uh, um, stutters, filler words) for clearer transcription output
[2026-01-25] Feature — Add custom language input and reorderable selected languages list; users can now add any language and arrange priority order
[2026-01-25] Feature — Rename onboarding screen to "Welcome"; add "Reset Welcome Screen" button in Settings to re-show it
[2026-01-25] Feature — Add clipboard history (20 entries): saves previous clipboard content (text/images) and transcriptions; access via tray menu "Previous Clipboard" (newest at bottom) or Cmd+Shift+V shortcut

## 2026-01-24

[2026-01-24] Bug — Fix macOS microphone indicator staying active after recording stops; add cleanup on component unmount and window close
[2026-01-24] Bug — Fix auto-updater not quitting app after user clicks "Restart Now"; add tray/window cleanup, proper quitAndInstall args, and 5-second force quit timeout

## 2026-01-23

[2026-01-23] Feature — Add GitHub Actions release workflow for cross-platform builds (macOS, Windows, Linux) without code signing
[2026-01-23] Bug — Fix quitAndInstall not working on macOS: properly close tray and windows before installing update

## 2026-01-22

[2026-01-22] Bug — Debounce silence/sound state logs to reduce console spam
[2026-01-22] Feature — Add custom keyword glossary to bias transcription with user-defined terms and aliases
[2026-01-22] Feature — Add onboarding screen with step-by-step instructions for getting Google Gemini API key; opens AI Studio link in user's browser via shell.openExternal
[2026-01-22] Feature — Add info button (i) in bottom-right corner opening separate window with usage instructions
[2026-01-22] Feature — Update retry logic: 30s timeout for first attempt, 2min timeout for retry (1 retry max)
[2026-01-22] Bug — Fix Settings and Info windows moving together with main widget when dragging (removed parent window dependency)
[2026-01-22] Feature — Add "Developer Tools" toggle in system tray menu; removed auto-open DevTools in dev mode
[2026-01-22] Feature — Settings and Info windows now appear in Cmd+Tab (dynamic dock visibility); dock hides when only widget is open
[2026-01-22] UI — Replace mic button tooltip with permanent "⌘⇧R" shortcut hint between settings/info buttons
[2026-01-22] Bug — Fix window titles to show "Nerd Dictum — Settings" and "Nerd Dictum — How to Use"
[2026-01-22] Bug — Fix dock icon not appearing correctly for Info window (await dock.show before setIcon)
[2026-01-22] Feature — Settings and Info windows now open on the same screen as the widget (multi-monitor support)
[2026-01-22] Feature — Add auto-update support via electron-updater with GitHub Releases; checks hourly and on startup; tray menu shows "Check for Updates" or "Install Update" when ready

## 2026-01-21

[2026-01-21] Feature — Add success state with green checkmark icon (pop animation) that fades to idle over 5 seconds after transcription
[2026-01-21] Feature — Expand settings: speech domain selector (programming, cooking, medical, etc.), microphone device picker, silence detection toggle with adjustable duration slider (1-10s)
[2026-01-21] Refactor — Replace system prompt field with custom domain hint (max 500 chars); add "Custom" option to speech domain selector for free-text domain hints
[2026-01-21] Feature — Add "Launch at startup" option in Settings; uses Electron's setLoginItemSettings API for macOS/Windows auto-launch
[2026-01-21] Refactor — Centralize window-position validation, reuse WAV encoding helpers, and simplify transcription/options helpers
[2026-01-21] Feature — Add theme selector (light/dark/system) with preview swatches, cross-window sync, and a softer light palette
[2026-01-21] Feature — Add real-time audio level visualization as tachometer arc around mic button (7-to-5 o'clock), with theme support and easeOut smoothing
[2026-01-21] Feature — Allow canceling in-progress transcription from the widget button
[2026-01-21] Refactor — Replace deprecated ScriptProcessorNode with AudioWorkletNode for audio capture

## 2026-01-20

[2026-01-20] Feature — Initial project skeleton with Electron + React + Vite setup
[2026-01-20] Bug — Fix invisible window by adding background color to widget container
[2026-01-20] Feature — Implement audio recording with Web Audio API (WAV, PCM 16-bit mono 16kHz)
[2026-01-20] Feature — Add WAV encoding utility with base64 support for Gemini API
[2026-01-20] Bug — Fix window dragging by applying -webkit-app-region to visible widget instead of transparent body
[2026-01-20] Bug — Increase widget padding to 20px for larger drag region around button
[2026-01-20] Refactor — Remove widget padding/border, implement manual drag via IPC on button with click/drag detection
[2026-01-20] Bug — Fix drag using global window events, add CSS fallbacks for button styling
[2026-01-20] Bug — Fix dragging and styling: circular widget with CSS drag region, hardcoded dark colors, button with no-drag
[2026-01-20] Bug — Disable transparent window, use dark background, full-size circular button for recording
[2026-01-20] Feature — Add draggable "Voice" title bar above mic button, window resized to 100x120
[2026-01-20] Refactor — Replace text title with grip dots drag handle for better UX
[2026-01-20] Bug — Fix widget to fill window, remove side borders, resize window to 80x100
[2026-01-20] Feature — Integrate audio recording with transcription API, copy result to clipboard
[2026-01-20] Feature — Add audio validation (min 250ms, max 15 minutes) with user-facing error messages
[2026-01-20] Feature — Add error handling with user-friendly messages, error/success flash styling, and retry capability for transient errors
[2026-01-20] Test — Add comprehensive unit tests (errors.test.ts, App.test.tsx) and E2E tests (voice-widget.spec.ts) for error handling feature
[2026-01-20] Feature — Add global keyboard shortcut (Cmd/Ctrl+Shift+R) to toggle recording
[2026-01-20] Feature — Add settings UI with gear icon to configure Gemini API key and model, persisted to disk
[2026-01-20] Bug — Fix settings to open in separate window instead of inside tiny widget, fix gear icon clickable area
[2026-01-20] Feature — Add custom system prompt and multi-language selection in settings for better transcription
[2026-01-20] Feature — Add system tray integration with Show/Hide, Settings, Quit menu; app runs in tray when window closed
[2026-01-20] Feature — Remember window position across restarts (ignores saved position if monitor configuration changed)
[2026-01-20] Feature — Auto-stop recording after 1.5 seconds of silence (silence detection)
[2026-01-20] Bug — Fix silence callback firing multiple times
[2026-01-20] Feature — Change silence duration from 1.5s to 2.5s for more natural pauses
[2026-01-20] Bug — Fix silence auto-stop not working (stale closure issue with state); add unit tests for silence detection
[2026-01-25 12:00] Feature — Add clipboard history: saves previous clipboard content (text and images) before overwriting; access via tray menu "Previous Clipboard" submenu or Cmd+Shift+V shortcut
[2026-01-25 12:00] Feature — Add clipboard history (20 entries): saves previous clipboard content (text/images) and transcriptions; access via tray menu "Previous Clipboard" (newest at bottom) or Cmd+Shift+V shortcut
[2026-01-24 21:30] Bug — Fix macOS microphone indicator staying active after recording stops; add cleanup on component unmount and window close
[2026-01-24 00:25] Bug — Fix auto-updater not quitting app after user clicks "Restart Now"; add tray/window cleanup, proper quitAndInstall args, and 5-second force quit timeout
[2026-01-20 12:40] Feature — Initial project skeleton with Electron + React + Vite setup
[2026-01-20 12:45] Bug — Fix invisible window by adding background color to widget container
[2026-01-20 14:25] Feature — Implement audio recording with Web Audio API (WAV, PCM 16-bit mono 16kHz)
[2026-01-20 13:15] Feature — Add WAV encoding utility with base64 support for Gemini API
[2026-01-20 13:15] Bug — Fix window dragging by applying -webkit-app-region to visible widget instead of transparent body
[2026-01-20 13:18] Bug — Increase widget padding to 20px for larger drag region around button
[2026-01-20 13:25] Refactor — Remove widget padding/border, implement manual drag via IPC on button with click/drag detection
[2026-01-20 13:30] Bug — Fix drag using global window events, add CSS fallbacks for button styling
[2026-01-20 13:35] Bug — Fix dragging and styling: circular widget with CSS drag region, hardcoded dark colors, button with no-drag
[2026-01-20 13:40] Bug — Disable transparent window, use dark background, full-size circular button for recording
[2026-01-20 15:40] Feature — Add draggable "Voice" title bar above mic button, window resized to 100x120
[2026-01-20 15:45] Refactor — Replace text title with grip dots drag handle for better UX
[2026-01-20 15:50] Bug — Fix widget to fill window, remove side borders, resize window to 80x100
[2026-01-20 16:05] Feature — Integrate audio recording with transcription API, copy result to clipboard
[2026-01-20 17:15] Feature — Add audio validation (min 250ms, max 15 minutes) with user-facing error messages
[2026-01-20 16:55] Feature — Add error handling with user-friendly messages, error/success flash styling, and retry capability for transient errors
[2026-01-20 17:35] Test — Add comprehensive unit tests (errors.test.ts, App.test.tsx) and E2E tests (voice-widget.spec.ts) for error handling feature
[2026-01-20 16:30] Feature — Add global keyboard shortcut (Cmd/Ctrl+Shift+R) to toggle recording
[2026-01-20 18:30] Feature — Add settings UI with gear icon to configure Gemini API key and model, persisted to disk
[2026-01-20 19:30] Bug — Fix settings to open in separate window instead of inside tiny widget, fix gear icon clickable area
[2026-01-20 19:34] Feature — Add custom system prompt and multi-language selection in settings for better transcription
[2026-01-20 19:29] Feature — Add system tray integration with Show/Hide, Settings, Quit menu; app runs in tray when window closed
[2026-01-20 21:05] Feature — Remember window position across restarts (ignores saved position if monitor configuration changed)
[2026-01-20 20:15] Feature — Auto-stop recording after 1.5 seconds of silence (silence detection)
[2026-01-20 20:30] Bug — Fix silence callback firing multiple times
[2026-01-20 20:45] Feature — Change silence duration from 1.5s to 2.5s for more natural pauses
[2026-01-20 21:00] Bug — Fix silence auto-stop not working (stale closure issue with state); add unit tests for silence detection
[2026-01-21 14:20] Feature — Add success state with green checkmark icon (pop animation) that fades to idle over 5 seconds after transcription
[2026-01-21 14:30] Feature — Expand settings: speech domain selector (programming, cooking, medical, etc.), microphone device picker, silence detection toggle with adjustable duration slider (1-10s)
[2026-01-21 15:00] Refactor — Replace system prompt field with custom domain hint (max 500 chars); add "Custom" option to speech domain selector for free-text domain hints
[2026-01-21 16:30] Feature — Add "Launch at startup" option in Settings; uses Electron's setLoginItemSettings API for macOS/Windows auto-launch
[2026-01-21 20:39] Refactor — Centralize window-position validation, reuse WAV encoding helpers, and simplify transcription/options helpers
[2026-01-21 21:27] Feature — Add theme selector (light/dark/system) with preview swatches, cross-window sync, and a softer light palette
[2026-01-21 21:07] Feature — Add real-time audio level visualization as tachometer arc around mic button (7-to-5 o'clock), with theme support and easeOut smoothing
[2026-01-21 21:31] Feature — Allow canceling in-progress transcription from the widget button
[2026-01-21 21:37] Feature — Allow canceling in-progress transcription from the widget button (log cancellation)
[2026-01-21 21:54] Refactor — Replace deprecated ScriptProcessorNode with AudioWorkletNode for audio capture
[2026-01-22 14:47] Bug — Debounce silence/sound state logs to reduce console spam
[2026-01-22 18:35] Feature — Update retry logic: 30s timeout for first attempt, 2min timeout for retry (1 retry max)
[2026-01-22 14:54] Feature — Add custom keyword glossary to bias transcription with user-defined terms and aliases
[2026-01-22 16:55] Feature — Add onboarding screen with step-by-step instructions for getting Google Gemini API key; opens AI Studio link in user's browser via shell.openExternal
[2026-01-22 17:05] Feature — Add info button (i) with popup explaining how to use the app
[2026-01-22 17:05] Feature — Add info button (i) in bottom-right corner opening separate window with usage instructions
[2026-01-22 22:35] Bug — Fix Settings and Info windows moving together with main widget when dragging (removed parent window dependency)
[2026-01-22 22:15] Feature — Add "Developer Tools" toggle in system tray menu; removed auto-open DevTools in dev mode
[2026-01-22 19:45] Feature — Settings and Info windows now appear in Cmd+Tab (dynamic dock visibility); dock hides when only widget is open
[2026-01-22 19:45] UI — Replace mic button tooltip with permanent "⌘⇧R" shortcut hint between settings/info buttons
[2026-01-22 19:45] Bug — Fix window titles to show "Nerd Dictum — Settings" and "Nerd Dictum — How to Use"
[2026-01-22 19:45] Bug — Fix dock icon not appearing correctly for Info window (await dock.show before setIcon)
[2026-01-22 23:10] Feature — Settings and Info windows now open on the same screen as the widget (multi-monitor support)
[2026-01-22 23:45] Feature — Add auto-update support via electron-updater with GitHub Releases; checks hourly and on startup; tray menu shows "Check for Updates" or "Install Update" when ready
[2026-01-23 21:30] Bug — Fix quitAndInstall not working on macOS: properly close tray and windows before installing update
[2026-01-23 23:45] Feature — Add GitHub Actions release workflow for cross-platform builds (macOS, Windows, Linux) without code signing
## 2026-02-03

[2026-02-08] Feature — API error detail popup: when API returns an error (including HTML responses), clicking the error flash message opens a dedicated window showing the HTTP status code, error message, and full response body; HTML responses are rendered in a sandboxed iframe for readability
[2026-02-03] Bug — Fix crash on quit: remove call to undefined stopKeyboardHook() left over from uiohook-napi removal
[2026-02-03] Bug — Fix macOS microphone indicator staying active when opening Settings; properly release MediaStream after enumerating audio devices
[2026-02-03] Feature — Auto-lower volume during recording: lowers system volume to 10% when recording starts, restores original level after transcription completes (macOS only); works universally with any app playing audio
[2026-02-03] Feature — Add usage statistics: track total transcriptions, words, characters, recording time with 30-day activity graph; view stats via bar chart button (left of widget); includes streak counter, most active day, time saved estimate, and reset option

## 2026-02-01

[2026-02-01] Feature — Add hold-to-record mode: hold a modifier key (Right Command by default) to record, release to transcribe; works alongside the toggle hotkey (⌘⇧R); configurable in Settings > General with support for left/right variants of Command, Option, Control, and Shift keys
[2026-02-01] Feature — Add Google Analytics 4 integration for real-time usage tracking: app_start, recording_start, recording_stop, transcription_success, transcription_error events
[2026-02-01] Feature — Add "Forever" option to hide popup: hide widget permanently until manually shown via tray menu
[2026-02-01] Feature — Add "Hide widget permanently" setting in General tab: disable widget visibility persistently across restarts

## 2026-01-28

[2026-01-28] Feature — Expand conversation context: include last 3 transcripts (instead of 1) for better accuracy in ongoing conversations
[2026-01-28] Feature — Add customizable global hotkey: change the recording shortcut from default ⌘⇧R to any key combination; configure in Settings > General
[2026-01-28] Feature — Add hide button (eye icon) with popup menu to temporarily hide widget for 10 minutes, 1 hour, 3 hours, or until end of day; widget automatically reappears after selected duration

## 2026-01-27

[2026-01-27] Feature — Add sound feedback on transcription completion: success chime when text is copied to clipboard, error tone on failure; toggle in Settings > General

## 2026-01-25

[2026-01-25] Feature — Enforce single instance: prevent multiple app instances from running simultaneously; second launch focuses existing window instead
[2026-01-25] UX — Add explicit cancel indication during transcription: hover shows ✕ icon over spinner, tooltip "Click to cancel", improved accessibility with aria-label
[2026-01-25] UX — Split settings page into 4 tabs: General (API key, model, launch at startup), Languages, Appearance (theme), Advanced (speech domain, clarification, keywords, microphone, silence detection); improves navigation in large settings page
[2026-01-25] UX — Add confirmation dialog when canceling settings with unsaved changes; prevents accidental data loss via Cancel button or window close
[2026-01-25] UX — Improve language selection: add search field to filter languages, group by popularity (Popular first, then alphabetical), unified search+add UX for custom languages
[2026-01-25] Bug — Fix race condition in transcribeWithRetry: abort existing transcription before starting new one, ensure atomic request ID assignment to prevent duplicate API calls under rapid user interaction
[2026-01-25] Feature — Add "Use previous transcript as context" setting (enabled by default) to include the last transcription as context for Gemini API, improving accuracy for related speech
[2026-01-25] Performance — Move update check and microphone permission request to background; UI now appears instantly on startup instead of waiting for these operations
[2026-01-25] Feature — Add Clarification setting (enabled by default) to clean up speech disfluencies (uh, um, stutters, filler words) for clearer transcription output
[2026-01-25] Feature — Add custom language input and reorderable selected languages list; users can now add any language and arrange priority order
[2026-01-25] Feature — Rename onboarding screen to "Welcome"; add "Reset Welcome Screen" button in Settings to re-show it
[2026-01-25] Feature — Add clipboard history (20 entries): saves previous clipboard content (text/images) and transcriptions; access via tray menu "Previous Clipboard" (newest at bottom) or Cmd+Shift+V shortcut

## 2026-01-24

[2026-01-24] Bug — Fix macOS microphone indicator staying active after recording stops; add cleanup on component unmount and window close
[2026-01-24] Bug — Fix auto-updater not quitting app after user clicks "Restart Now"; add tray/window cleanup, proper quitAndInstall args, and 5-second force quit timeout

## 2026-01-23

[2026-01-23] Feature — Add GitHub Actions release workflow for cross-platform builds (macOS, Windows, Linux) without code signing
[2026-01-23] Bug — Fix quitAndInstall not working on macOS: properly close tray and windows before installing update

## 2026-01-22

[2026-01-22] Bug — Debounce silence/sound state logs to reduce console spam
[2026-01-22] Feature — Add custom keyword glossary to bias transcription with user-defined terms and aliases
[2026-01-22] Feature — Add onboarding screen with step-by-step instructions for getting Google Gemini API key; opens AI Studio link in user's browser via shell.openExternal
[2026-01-22] Feature — Add info button (i) in bottom-right corner opening separate window with usage instructions
[2026-01-22] Feature — Update retry logic: 30s timeout for first attempt, 2min timeout for retry (1 retry max)
[2026-01-22] Bug — Fix Settings and Info windows moving together with main widget when dragging (removed parent window dependency)
[2026-01-22] Feature — Add "Developer Tools" toggle in system tray menu; removed auto-open DevTools in dev mode
[2026-01-22] Feature — Settings and Info windows now appear in Cmd+Tab (dynamic dock visibility); dock hides when only widget is open
[2026-01-22] UI — Replace mic button tooltip with permanent "⌘⇧R" shortcut hint between settings/info buttons
[2026-01-22] Bug — Fix window titles to show "Nerd Dictum — Settings" and "Nerd Dictum — How to Use"
[2026-01-22] Bug — Fix dock icon not appearing correctly for Info window (await dock.show before setIcon)
[2026-01-22] Feature — Settings and Info windows now open on the same screen as the widget (multi-monitor support)
[2026-01-22] Feature — Add auto-update support via electron-updater with GitHub Releases; checks hourly and on startup; tray menu shows "Check for Updates" or "Install Update" when ready

## 2026-01-21

[2026-01-21] Feature — Add success state with green checkmark icon (pop animation) that fades to idle over 5 seconds after transcription
[2026-01-21] Feature — Expand settings: speech domain selector (programming, cooking, medical, etc.), microphone device picker, silence detection toggle with adjustable duration slider (1-10s)
[2026-01-21] Refactor — Replace system prompt field with custom domain hint (max 500 chars); add "Custom" option to speech domain selector for free-text domain hints
[2026-01-21] Feature — Add "Launch at startup" option in Settings; uses Electron's setLoginItemSettings API for macOS/Windows auto-launch
[2026-01-21] Refactor — Centralize window-position validation, reuse WAV encoding helpers, and simplify transcription/options helpers
[2026-01-21] Feature — Add theme selector (light/dark/system) with preview swatches, cross-window sync, and a softer light palette
[2026-01-21] Feature — Add real-time audio level visualization as tachometer arc around mic button (7-to-5 o'clock), with theme support and easeOut smoothing
[2026-01-21] Feature — Allow canceling in-progress transcription from the widget button
[2026-01-21] Refactor — Replace deprecated ScriptProcessorNode with AudioWorkletNode for audio capture

## 2026-01-20

[2026-01-20] Feature — Initial project skeleton with Electron + React + Vite setup
[2026-01-20] Bug — Fix invisible window by adding background color to widget container
[2026-01-20] Feature — Implement audio recording with Web Audio API (WAV, PCM 16-bit mono 16kHz)
[2026-01-20] Feature — Add WAV encoding utility with base64 support for Gemini API
[2026-01-20] Bug — Fix window dragging by applying -webkit-app-region to visible widget instead of transparent body
[2026-01-20] Bug — Increase widget padding to 20px for larger drag region around button
[2026-01-20] Refactor — Remove widget padding/border, implement manual drag via IPC on button with click/drag detection
[2026-01-20] Bug — Fix drag using global window events, add CSS fallbacks for button styling
[2026-01-20] Bug — Fix dragging and styling: circular widget with CSS drag region, hardcoded dark colors, button with no-drag
[2026-01-20] Bug — Disable transparent window, use dark background, full-size circular button for recording
[2026-01-20] Feature — Add draggable "Voice" title bar above mic button, window resized to 100x120
[2026-01-20] Refactor — Replace text title with grip dots drag handle for better UX
[2026-01-20] Bug — Fix widget to fill window, remove side borders, resize window to 80x100
[2026-01-20] Feature — Integrate audio recording with transcription API, copy result to clipboard
[2026-01-20] Feature — Add audio validation (min 250ms, max 15 minutes) with user-facing error messages
[2026-01-20] Feature — Add error handling with user-friendly messages, error/success flash styling, and retry capability for transient errors
[2026-01-20] Test — Add comprehensive unit tests (errors.test.ts, App.test.tsx) and E2E tests (voice-widget.spec.ts) for error handling feature
[2026-01-20] Feature — Add global keyboard shortcut (Cmd/Ctrl+Shift+R) to toggle recording
[2026-01-20] Feature — Add settings UI with gear icon to configure Gemini API key and model, persisted to disk
[2026-01-20] Bug — Fix settings to open in separate window instead of inside tiny widget, fix gear icon clickable area
[2026-01-20] Feature — Add custom system prompt and multi-language selection in settings for better transcription
[2026-01-20] Feature — Add system tray integration with Show/Hide, Settings, Quit menu; app runs in tray when window closed
[2026-01-20] Feature — Remember window position across restarts (ignores saved position if monitor configuration changed)
[2026-01-20] Feature — Auto-stop recording after 1.5 seconds of silence (silence detection)
[2026-01-20] Bug — Fix silence callback firing multiple times
[2026-01-20] Feature — Change silence duration from 1.5s to 2.5s for more natural pauses
[2026-01-20] Bug — Fix silence auto-stop not working (stale closure issue with state); add unit tests for silence detection
[2026-01-25 12:00] Feature — Add clipboard history: saves previous clipboard content (text and images) before overwriting; access via tray menu "Previous Clipboard" submenu or Cmd+Shift+V shortcut
[2026-01-25 12:00] Feature — Add clipboard history (20 entries): saves previous clipboard content (text/images) and transcriptions; access via tray menu "Previous Clipboard" (newest at bottom) or Cmd+Shift+V shortcut
[2026-01-24 21:30] Bug — Fix macOS microphone indicator staying active after recording stops; add cleanup on component unmount and window close
[2026-01-24 00:25] Bug — Fix auto-updater not quitting app after user clicks "Restart Now"; add tray/window cleanup, proper quitAndInstall args, and 5-second force quit timeout
[2026-01-20 12:40] Feature — Initial project skeleton with Electron + React + Vite setup
[2026-01-20 12:45] Bug — Fix invisible window by adding background color to widget container
[2026-01-20 14:25] Feature — Implement audio recording with Web Audio API (WAV, PCM 16-bit mono 16kHz)
[2026-01-20 13:15] Feature — Add WAV encoding utility with base64 support for Gemini API
[2026-01-20 13:15] Bug — Fix window dragging by applying -webkit-app-region to visible widget instead of transparent body
[2026-01-20 13:18] Bug — Increase widget padding to 20px for larger drag region around button
[2026-01-20 13:25] Refactor — Remove widget padding/border, implement manual drag via IPC on button with click/drag detection
[2026-01-20 13:30] Bug — Fix drag using global window events, add CSS fallbacks for button styling
[2026-01-20 13:35] Bug — Fix dragging and styling: circular widget with CSS drag region, hardcoded dark colors, button with no-drag
[2026-01-20 13:40] Bug — Disable transparent window, use dark background, full-size circular button for recording
[2026-01-20 15:40] Feature — Add draggable "Voice" title bar above mic button, window resized to 100x120
[2026-01-20 15:45] Refactor — Replace text title with grip dots drag handle for better UX
[2026-01-20 15:50] Bug — Fix widget to fill window, remove side borders, resize window to 80x100
[2026-01-20 16:05] Feature — Integrate audio recording with transcription API, copy result to clipboard
[2026-01-20 17:15] Feature — Add audio validation (min 250ms, max 15 minutes) with user-facing error messages
[2026-01-20 16:55] Feature — Add error handling with user-friendly messages, error/success flash styling, and retry capability for transient errors
[2026-01-20 17:35] Test — Add comprehensive unit tests (errors.test.ts, App.test.tsx) and E2E tests (voice-widget.spec.ts) for error handling feature
[2026-01-20 16:30] Feature — Add global keyboard shortcut (Cmd/Ctrl+Shift+R) to toggle recording
[2026-01-20 18:30] Feature — Add settings UI with gear icon to configure Gemini API key and model, persisted to disk
[2026-01-20 19:30] Bug — Fix settings to open in separate window instead of inside tiny widget, fix gear icon clickable area
[2026-01-20 19:34] Feature — Add custom system prompt and multi-language selection in settings for better transcription
[2026-01-20 19:29] Feature — Add system tray integration with Show/Hide, Settings, Quit menu; app runs in tray when window closed
[2026-01-20 21:05] Feature — Remember window position across restarts (ignores saved position if monitor configuration changed)
[2026-01-20 20:15] Feature — Auto-stop recording after 1.5 seconds of silence (silence detection)
[2026-01-20 20:30] Bug — Fix silence callback firing multiple times
[2026-01-20 20:45] Feature — Change silence duration from 1.5s to 2.5s for more natural pauses
[2026-01-20 21:00] Bug — Fix silence auto-stop not working (stale closure issue with state); add unit tests for silence detection
[2026-01-21 14:20] Feature — Add success state with green checkmark icon (pop animation) that fades to idle over 5 seconds after transcription
[2026-01-21 14:30] Feature — Expand settings: speech domain selector (programming, cooking, medical, etc.), microphone device picker, silence detection toggle with adjustable duration slider (1-10s)
[2026-01-21 15:00] Refactor — Replace system prompt field with custom domain hint (max 500 chars); add "Custom" option to speech domain selector for free-text domain hints
[2026-01-21 16:30] Feature — Add "Launch at startup" option in Settings; uses Electron's setLoginItemSettings API for macOS/Windows auto-launch
[2026-01-21 20:39] Refactor — Centralize window-position validation, reuse WAV encoding helpers, and simplify transcription/options helpers
[2026-01-21 21:27] Feature — Add theme selector (light/dark/system) with preview swatches, cross-window sync, and a softer light palette
[2026-01-21 21:07] Feature — Add real-time audio level visualization as tachometer arc around mic button (7-to-5 o'clock), with theme support and easeOut smoothing
[2026-01-21 21:31] Feature — Allow canceling in-progress transcription from the widget button
[2026-01-21 21:37] Feature — Allow canceling in-progress transcription from the widget button (log cancellation)
[2026-01-21 21:54] Refactor — Replace deprecated ScriptProcessorNode with AudioWorkletNode for audio capture
[2026-01-22 14:47] Bug — Debounce silence/sound state logs to reduce console spam
[2026-01-22 18:35] Feature — Update retry logic: 30s timeout for first attempt, 2min timeout for retry (1 retry max)
[2026-01-22 14:54] Feature — Add custom keyword glossary to bias transcription with user-defined terms and aliases
[2026-01-22 16:55] Feature — Add onboarding screen with step-by-step instructions for getting Google Gemini API key; opens AI Studio link in user's browser via shell.openExternal
[2026-01-22 17:05] Feature — Add info button (i) with popup explaining how to use the app
[2026-01-22 17:05] Feature — Add info button (i) in bottom-right corner opening separate window with usage instructions
[2026-01-22 22:35] Bug — Fix Settings and Info windows moving together with main widget when dragging (removed parent window dependency)
[2026-01-22 22:15] Feature — Add "Developer Tools" toggle in system tray menu; removed auto-open DevTools in dev mode
[2026-01-22 19:45] Feature — Settings and Info windows now appear in Cmd+Tab (dynamic dock visibility); dock hides when only widget is open
[2026-01-22 19:45] UI — Replace mic button tooltip with permanent "⌘⇧R" shortcut hint between settings/info buttons
[2026-01-22 19:45] Bug — Fix window titles to show "Nerd Dictum — Settings" and "Nerd Dictum — How to Use"
[2026-01-22 19:45] Bug — Fix dock icon not appearing correctly for Info window (await dock.show before setIcon)
[2026-01-22 23:10] Feature — Settings and Info windows now open on the same screen as the widget (multi-monitor support)
[2026-01-22 23:45] Feature — Add auto-update support via electron-updater with GitHub Releases; checks hourly and on startup; tray menu shows "Check for Updates" or "Install Update" when ready
[2026-01-23 21:30] Bug — Fix quitAndInstall not working on macOS: properly close tray and windows before installing update
[2026-01-23 23:45] Feature — Add GitHub Actions release workflow for cross-platform builds (macOS, Windows, Linux) without code signing
## 2026-02-03

[2026-02-03] Bug — Fix crash on quit: remove call to undefined stopKeyboardHook() left over from uiohook-napi removal
[2026-02-03] Bug — Fix macOS microphone indicator staying active when opening Settings; properly release MediaStream after enumerating audio devices
[2026-02-03] Feature — Auto-lower volume during recording: lowers system volume to 10% when recording starts, restores original level after transcription completes (macOS only); works universally with any app playing audio
[2026-02-03] Feature — Add usage statistics: track total transcriptions, words, characters, recording time with 30-day activity graph; view stats via bar chart button (left of widget); includes streak counter, most active day, time saved estimate, and reset option

## 2026-02-01

[2026-02-01] Feature — Add hold-to-record mode: hold a modifier key (Right Command by default) to record, release to transcribe; works alongside the toggle hotkey (⌘⇧R); configurable in Settings > General with support for left/right variants of Command, Option, Control, and Shift keys
[2026-02-01] Feature — Add Google Analytics 4 integration for real-time usage tracking: app_start, recording_start, recording_stop, transcription_success, transcription_error events
[2026-02-01] Feature — Add "Forever" option to hide popup: hide widget permanently until manually shown via tray menu
[2026-02-01] Feature — Add "Hide widget permanently" setting in General tab: disable widget visibility persistently across restarts

## 2026-01-28

[2026-01-28] Feature — Expand conversation context: include last 3 transcripts (instead of 1) for better accuracy in ongoing conversations
[2026-01-28] Feature — Add customizable global hotkey: change the recording shortcut from default ⌘⇧R to any key combination; configure in Settings > General
[2026-01-28] Feature — Add hide button (eye icon) with popup menu to temporarily hide widget for 10 minutes, 1 hour, 3 hours, or until end of day; widget automatically reappears after selected duration

## 2026-01-27

[2026-01-27] Feature — Add sound feedback on transcription completion: success chime when text is copied to clipboard, error tone on failure; toggle in Settings > General

## 2026-01-25

[2026-01-25] Feature — Enforce single instance: prevent multiple app instances from running simultaneously; second launch focuses existing window instead
[2026-01-25] UX — Add explicit cancel indication during transcription: hover shows ✕ icon over spinner, tooltip "Click to cancel", improved accessibility with aria-label
[2026-01-25] UX — Split settings page into 4 tabs: General (API key, model, launch at startup), Languages, Appearance (theme), Advanced (speech domain, clarification, keywords, microphone, silence detection); improves navigation in large settings page
[2026-01-25] UX — Add confirmation dialog when canceling settings with unsaved changes; prevents accidental data loss via Cancel button or window close
[2026-01-25] UX — Improve language selection: add search field to filter languages, group by popularity (Popular first, then alphabetical), unified search+add UX for custom languages
[2026-01-25] Bug — Fix race condition in transcribeWithRetry: abort existing transcription before starting new one, ensure atomic request ID assignment to prevent duplicate API calls under rapid user interaction
[2026-01-25] Feature — Add "Use previous transcript as context" setting (enabled by default) to include the last transcription as context for Gemini API, improving accuracy for related speech
[2026-01-25] Performance — Move update check and microphone permission request to background; UI now appears instantly on startup instead of waiting for these operations
[2026-01-25] Feature — Add Clarification setting (enabled by default) to clean up speech disfluencies (uh, um, stutters, filler words) for clearer transcription output
[2026-01-25] Feature — Add custom language input and reorderable selected languages list; users can now add any language and arrange priority order
[2026-01-25] Feature — Rename onboarding screen to "Welcome"; add "Reset Welcome Screen" button in Settings to re-show it
[2026-01-25] Feature — Add clipboard history (20 entries): saves previous clipboard content (text/images) and transcriptions; access via tray menu "Previous Clipboard" (newest at bottom) or Cmd+Shift+V shortcut

## 2026-01-24

[2026-01-24] Bug — Fix macOS microphone indicator staying active after recording stops; add cleanup on component unmount and window close
[2026-01-24] Bug — Fix auto-updater not quitting app after user clicks "Restart Now"; add tray/window cleanup, proper quitAndInstall args, and 5-second force quit timeout

## 2026-01-23

[2026-01-23] Feature — Add GitHub Actions release workflow for cross-platform builds (macOS, Windows, Linux) without code signing
[2026-01-23] Bug — Fix quitAndInstall not working on macOS: properly close tray and windows before installing update

## 2026-01-22

[2026-01-22] Bug — Debounce silence/sound state logs to reduce console spam
[2026-01-22] Feature — Add custom keyword glossary to bias transcription with user-defined terms and aliases
[2026-01-22] Feature — Add onboarding screen with step-by-step instructions for getting Google Gemini API key; opens AI Studio link in user's browser via shell.openExternal
[2026-01-22] Feature — Add info button (i) in bottom-right corner opening separate window with usage instructions
[2026-01-22] Feature — Update retry logic: 30s timeout for first attempt, 2min timeout for retry (1 retry max)
[2026-01-22] Bug — Fix Settings and Info windows moving together with main widget when dragging (removed parent window dependency)
[2026-01-22] Feature — Add "Developer Tools" toggle in system tray menu; removed auto-open DevTools in dev mode
[2026-01-22] Feature — Settings and Info windows now appear in Cmd+Tab (dynamic dock visibility); dock hides when only widget is open
[2026-01-22] UI — Replace mic button tooltip with permanent "⌘⇧R" shortcut hint between settings/info buttons
[2026-01-22] Bug — Fix window titles to show "Nerd Dictum — Settings" and "Nerd Dictum — How to Use"
[2026-01-22] Bug — Fix dock icon not appearing correctly for Info window (await dock.show before setIcon)
[2026-01-22] Feature — Settings and Info windows now open on the same screen as the widget (multi-monitor support)
[2026-01-22] Feature — Add auto-update support via electron-updater with GitHub Releases; checks hourly and on startup; tray menu shows "Check for Updates" or "Install Update" when ready

## 2026-01-21

[2026-01-21] Feature — Add success state with green checkmark icon (pop animation) that fades to idle over 5 seconds after transcription
[2026-01-21] Feature — Expand settings: speech domain selector (programming, cooking, medical, etc.), microphone device picker, silence detection toggle with adjustable duration slider (1-10s)
[2026-01-21] Refactor — Replace system prompt field with custom domain hint (max 500 chars); add "Custom" option to speech domain selector for free-text domain hints
[2026-01-21] Feature — Add "Launch at startup" option in Settings; uses Electron's setLoginItemSettings API for macOS/Windows auto-launch
[2026-01-21] Refactor — Centralize window-position validation, reuse WAV encoding helpers, and simplify transcription/options helpers
[2026-01-21] Feature — Add theme selector (light/dark/system) with preview swatches, cross-window sync, and a softer light palette
[2026-01-21] Feature — Add real-time audio level visualization as tachometer arc around mic button (7-to-5 o'clock), with theme support and easeOut smoothing
[2026-01-21] Feature — Allow canceling in-progress transcription from the widget button
[2026-01-21] Refactor — Replace deprecated ScriptProcessorNode with AudioWorkletNode for audio capture

## 2026-01-20

[2026-01-20] Feature — Initial project skeleton with Electron + React + Vite setup
[2026-01-20] Bug — Fix invisible window by adding background color to widget container
[2026-01-20] Feature — Implement audio recording with Web Audio API (WAV, PCM 16-bit mono 16kHz)
[2026-01-20] Feature — Add WAV encoding utility with base64 support for Gemini API
[2026-01-20] Bug — Fix window dragging by applying -webkit-app-region to visible widget instead of transparent body
[2026-01-20] Bug — Increase widget padding to 20px for larger drag region around button
[2026-01-20] Refactor — Remove widget padding/border, implement manual drag via IPC on button with click/drag detection
[2026-01-20] Bug — Fix drag using global window events, add CSS fallbacks for button styling
[2026-01-20] Bug — Fix dragging and styling: circular widget with CSS drag region, hardcoded dark colors, button with no-drag
[2026-01-20] Bug — Disable transparent window, use dark background, full-size circular button for recording
[2026-01-20] Feature — Add draggable "Voice" title bar above mic button, window resized to 100x120
[2026-01-20] Refactor — Replace text title with grip dots drag handle for better UX
[2026-01-20] Bug — Fix widget to fill window, remove side borders, resize window to 80x100
[2026-01-20] Feature — Integrate audio recording with transcription API, copy result to clipboard
[2026-01-20] Feature — Add audio validation (min 250ms, max 15 minutes) with user-facing error messages
[2026-01-20] Feature — Add error handling with user-friendly messages, error/success flash styling, and retry capability for transient errors
[2026-01-20] Test — Add comprehensive unit tests (errors.test.ts, App.test.tsx) and E2E tests (voice-widget.spec.ts) for error handling feature
[2026-01-20] Feature — Add global keyboard shortcut (Cmd/Ctrl+Shift+R) to toggle recording
[2026-01-20] Feature — Add settings UI with gear icon to configure Gemini API key and model, persisted to disk
[2026-01-20] Bug — Fix settings to open in separate window instead of inside tiny widget, fix gear icon clickable area
[2026-01-20] Feature — Add custom system prompt and multi-language selection in settings for better transcription
[2026-01-20] Feature — Add system tray integration with Show/Hide, Settings, Quit menu; app runs in tray when window closed
[2026-01-20] Feature — Remember window position across restarts (ignores saved position if monitor configuration changed)
[2026-01-20] Feature — Auto-stop recording after 1.5 seconds of silence (silence detection)
[2026-01-20] Bug — Fix silence callback firing multiple times
[2026-01-20] Feature — Change silence duration from 1.5s to 2.5s for more natural pauses
[2026-01-20] Bug — Fix silence auto-stop not working (stale closure issue with state); add unit tests for silence detection
- Feature — Add hold-to-record mode: hold a modifier key (Right Command by default) to record, release to transcribe; configurable in Settings > General
- Feature — Add Google Analytics 4 integration for usage tracking: app_start, recording_start, recording_stop, transcription_success, transcription_error events
- Feature — Add "Forever" option to hide popup: hide widget permanently until manually shown via tray menu
- Feature — Add "Hide widget permanently" setting in General tab

## 2026-01-28

[2026-01-28] Feature — Expand conversation context: include last 3 transcripts (instead of 1) for better accuracy in ongoing conversations
[2026-01-28] Feature — Add customizable global hotkey: change the recording shortcut from default ⌘⇧R to any key combination; configure in Settings > General
[2026-01-28] Feature — Add hide button (eye icon) with popup menu to temporarily hide widget for 10 minutes, 1 hour, 3 hours, or until end of day; widget automatically reappears after selected duration

## 2026-01-27

[2026-01-27] Feature — Add sound feedback on transcription completion: success chime when text is copied to clipboard, error tone on failure; toggle in Settings > General

## 2026-01-25

[2026-01-25] Feature — Enforce single instance: prevent multiple app instances from running simultaneously; second launch focuses existing window instead
[2026-01-25] UX — Add explicit cancel indication during transcription: hover shows ✕ icon over spinner, tooltip "Click to cancel", improved accessibility with aria-label
[2026-01-25] UX — Split settings page into 4 tabs: General (API key, model, launch at startup), Languages, Appearance (theme), Advanced (speech domain, clarification, keywords, microphone, silence detection); improves navigation in large settings page
[2026-01-25] UX — Add confirmation dialog when canceling settings with unsaved changes; prevents accidental data loss via Cancel button or window close
[2026-01-25] UX — Improve language selection: add search field to filter languages, group by popularity (Popular first, then alphabetical), unified search+add UX for custom languages
[2026-01-25] Bug — Fix race condition in transcribeWithRetry: abort existing transcription before starting new one, ensure atomic request ID assignment to prevent duplicate API calls under rapid user interaction
[2026-01-25] Feature — Add "Use previous transcript as context" setting (enabled by default) to include the last transcription as context for Gemini API, improving accuracy for related speech
[2026-01-25] Performance — Move update check and microphone permission request to background; UI now appears instantly on startup instead of waiting for these operations
[2026-01-25] Feature — Add Clarification setting (enabled by default) to clean up speech disfluencies (uh, um, stutters, filler words) for clearer transcription output
[2026-01-25] Feature — Add custom language input and reorderable selected languages list; users can now add any language and arrange priority order
[2026-01-25] Feature — Rename onboarding screen to "Welcome"; add "Reset Welcome Screen" button in Settings to re-show it
[2026-01-25] Feature — Add clipboard history (20 entries): saves previous clipboard content (text/images) and transcriptions; access via tray menu "Previous Clipboard" (newest at bottom) or Cmd+Shift+V shortcut

## 2026-01-24

[2026-01-24] Bug — Fix macOS microphone indicator staying active after recording stops; add cleanup on component unmount and window close
[2026-01-24] Bug — Fix auto-updater not quitting app after user clicks "Restart Now"; add tray/window cleanup, proper quitAndInstall args, and 5-second force quit timeout

## 2026-01-23

[2026-01-23] Feature — Add GitHub Actions release workflow for cross-platform builds (macOS, Windows, Linux) without code signing
[2026-01-23] Bug — Fix quitAndInstall not working on macOS: properly close tray and windows before installing update

## 2026-01-22

[2026-01-22] Bug — Debounce silence/sound state logs to reduce console spam
[2026-01-22] Feature — Add custom keyword glossary to bias transcription with user-defined terms and aliases
[2026-01-22] Feature — Add onboarding screen with step-by-step instructions for getting Google Gemini API key; opens AI Studio link in user's browser via shell.openExternal
[2026-01-22] Feature — Add info button (i) in bottom-right corner opening separate window with usage instructions
[2026-01-22] Feature — Update retry logic: 30s timeout for first attempt, 2min timeout for retry (1 retry max)
[2026-01-22] Bug — Fix Settings and Info windows moving together with main widget when dragging (removed parent window dependency)
[2026-01-22] Feature — Add "Developer Tools" toggle in system tray menu; removed auto-open DevTools in dev mode
[2026-01-22] Feature — Settings and Info windows now appear in Cmd+Tab (dynamic dock visibility); dock hides when only widget is open
[2026-01-22] UI — Replace mic button tooltip with permanent "⌘⇧R" shortcut hint between settings/info buttons
[2026-01-22] Bug — Fix window titles to show "Nerd Dictum — Settings" and "Nerd Dictum — How to Use"
[2026-01-22] Bug — Fix dock icon not appearing correctly for Info window (await dock.show before setIcon)
[2026-01-22] Feature — Settings and Info windows now open on the same screen as the widget (multi-monitor support)
[2026-01-22] Feature — Add auto-update support via electron-updater with GitHub Releases; checks hourly and on startup; tray menu shows "Check for Updates" or "Install Update" when ready

## 2026-01-21

[2026-01-21] Feature — Add success state with green checkmark icon (pop animation) that fades to idle over 5 seconds after transcription
[2026-01-21] Feature — Expand settings: speech domain selector (programming, cooking, medical, etc.), microphone device picker, silence detection toggle with adjustable duration slider (1-10s)
[2026-01-21] Refactor — Replace system prompt field with custom domain hint (max 500 chars); add "Custom" option to speech domain selector for free-text domain hints
[2026-01-21] Feature — Add "Launch at startup" option in Settings; uses Electron's setLoginItemSettings API for macOS/Windows auto-launch
[2026-01-21] Refactor — Centralize window-position validation, reuse WAV encoding helpers, and simplify transcription/options helpers
[2026-01-21] Feature — Add theme selector (light/dark/system) with preview swatches, cross-window sync, and a softer light palette
[2026-01-21] Feature — Add real-time audio level visualization as tachometer arc around mic button (7-to-5 o'clock), with theme support and easeOut smoothing
[2026-01-21] Feature — Allow canceling in-progress transcription from the widget button
[2026-01-21] Refactor — Replace deprecated ScriptProcessorNode with AudioWorkletNode for audio capture

## 2026-01-20

[2026-01-20] Feature — Initial project skeleton with Electron + React + Vite setup
[2026-01-20] Bug — Fix invisible window by adding background color to widget container
[2026-01-20] Feature — Implement audio recording with Web Audio API (WAV, PCM 16-bit mono 16kHz)
[2026-01-20] Feature — Add WAV encoding utility with base64 support for Gemini API
[2026-01-20] Bug — Fix window dragging by applying -webkit-app-region to visible widget instead of transparent body
[2026-01-20] Bug — Increase widget padding to 20px for larger drag region around button
[2026-01-20] Refactor — Remove widget padding/border, implement manual drag via IPC on button with click/drag detection
[2026-01-20] Bug — Fix drag using global window events, add CSS fallbacks for button styling
[2026-01-20] Bug — Fix dragging and styling: circular widget with CSS drag region, hardcoded dark colors, button with no-drag
[2026-01-20] Bug — Disable transparent window, use dark background, full-size circular button for recording
[2026-01-20] Feature — Add draggable "Voice" title bar above mic button, window resized to 100x120
[2026-01-20] Refactor — Replace text title with grip dots drag handle for better UX
[2026-01-20] Bug — Fix widget to fill window, remove side borders, resize window to 80x100
[2026-01-20] Feature — Integrate audio recording with transcription API, copy result to clipboard
[2026-01-20] Feature — Add audio validation (min 250ms, max 15 minutes) with user-facing error messages
[2026-01-20] Feature — Add error handling with user-friendly messages, error/success flash styling, and retry capability for transient errors
[2026-01-20] Test — Add comprehensive unit tests (errors.test.ts, App.test.tsx) and E2E tests (voice-widget.spec.ts) for error handling feature
[2026-01-20] Feature — Add global keyboard shortcut (Cmd/Ctrl+Shift+R) to toggle recording
[2026-01-20] Feature — Add settings UI with gear icon to configure Gemini API key and model, persisted to disk
[2026-01-20] Bug — Fix settings to open in separate window instead of inside tiny widget, fix gear icon clickable area
[2026-01-20] Feature — Add custom system prompt and multi-language selection in settings for better transcription
[2026-01-20] Feature — Add system tray integration with Show/Hide, Settings, Quit menu; app runs in tray when window closed
[2026-01-20] Feature — Remember window position across restarts (ignores saved position if monitor configuration changed)
[2026-01-20] Feature — Auto-stop recording after 1.5 seconds of silence (silence detection)
[2026-01-20] Bug — Fix silence callback firing multiple times
[2026-01-20] Feature — Change silence duration from 1.5s to 2.5s for more natural pauses
[2026-01-20] Bug — Fix silence auto-stop not working (stale closure issue with state); add unit tests for silence detection
