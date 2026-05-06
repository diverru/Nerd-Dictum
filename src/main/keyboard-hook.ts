import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { HoldToRecordKey } from '../shared/types';

// Map our setting values to uiohook keycodes
const KEY_MAP: Record<HoldToRecordKey, number> = {
  LeftControl: UiohookKey.Ctrl, // 0x001D
  RightControl: 0x0e1d, // Right Control - not in UiohookKey enum
  LeftAlt: UiohookKey.Alt, // 0x0038
  RightAlt: 0x0e38, // Right Alt - not in UiohookKey enum
  LeftMeta: UiohookKey.Meta, // 0x0E5B
  RightMeta: 0x0e5c, // Right Meta - not in UiohookKey enum
  LeftShift: UiohookKey.Shift, // 0x002A
  RightShift: 0x0036, // Right Shift - not in UiohookKey enum
};

export interface KeyboardHookCallbacks {
  onKeyDown: () => void;
  onKeyUp: () => void;
}

let isRunning = false;
let targetKeycode: number | null = null;
let isKeyHeld = false;
let callbacks: KeyboardHookCallbacks | null = null;

function handleKeyDown(e: { keycode: number }) {
  if (targetKeycode !== null && e.keycode === targetKeycode && !isKeyHeld) {
    isKeyHeld = true;
    callbacks?.onKeyDown();
  }
}

function handleKeyUp(e: { keycode: number }) {
  if (targetKeycode !== null && e.keycode === targetKeycode && isKeyHeld) {
    isKeyHeld = false;
    callbacks?.onKeyUp();
  }
}

export function startKeyboardHook(
  key: HoldToRecordKey,
  cbs: KeyboardHookCallbacks
): boolean {
  if (isRunning) {
    stopKeyboardHook();
  }

  targetKeycode = KEY_MAP[key];
  if (targetKeycode === undefined) {
    console.error('[KeyboardHook] Unknown key:', key);
    return false;
  }

  callbacks = cbs;
  isKeyHeld = false;

  uIOhook.on('keydown', handleKeyDown);
  uIOhook.on('keyup', handleKeyUp);

  try {
    uIOhook.start();
    isRunning = true;
    return true;
  } catch (error) {
    console.error('[KeyboardHook] Failed to start:', error);
    uIOhook.off('keydown', handleKeyDown);
    uIOhook.off('keyup', handleKeyUp);
    return false;
  }
}

export function stopKeyboardHook(): void {
  if (!isRunning) return;

  uIOhook.off('keydown', handleKeyDown);
  uIOhook.off('keyup', handleKeyUp);

  try {
    uIOhook.stop();
  } catch {
    // Ignore errors on stop
  }

  isRunning = false;
  targetKeycode = null;
  isKeyHeld = false;
  callbacks = null;
}

export function updateTargetKey(key: HoldToRecordKey): void {
  targetKeycode = KEY_MAP[key];
  isKeyHeld = false; // Reset held state when key changes
}

export function isKeyboardHookRunning(): boolean {
  return isRunning;
}
