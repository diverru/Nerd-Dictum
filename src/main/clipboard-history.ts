import { clipboard, nativeImage, NativeImage } from 'electron';

export interface ClipboardEntry {
  id: number;
  text?: string;
  image?: NativeImage;
  timestamp: number;
  isTranscription?: boolean; // true if this entry is our transcribed text
}

const MAX_HISTORY_SIZE = 20;
let history: ClipboardEntry[] = [];
let nextId = 1;

/**
 * Captures current clipboard content before it gets overwritten.
 * Returns the saved entry or null if clipboard was empty.
 */
export function captureCurrentClipboard(): ClipboardEntry | null {
  const formats = clipboard.availableFormats();

  // Check if clipboard has any content
  if (formats.length === 0) {
    return null;
  }

  const entry: ClipboardEntry = {
    id: nextId++,
    timestamp: Date.now(),
  };

  // Capture text if available
  if (formats.some(f => f.includes('text'))) {
    const text = clipboard.readText();
    if (text) {
      entry.text = text;
    }
  }

  // Capture image if available
  if (formats.some(f => f.includes('image'))) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      entry.image = image;
    }
  }

  // Don't save empty entries
  if (!entry.text && !entry.image) {
    return null;
  }

  // Add to history (newest at end), remove oldest if at capacity
  history.push(entry);
  if (history.length > MAX_HISTORY_SIZE) {
    history.shift();
  }

  return entry;
}

/**
 * Adds a transcription result to history.
 * Called after we copy transcribed text to clipboard.
 */
export function addTranscriptionToHistory(text: string): ClipboardEntry {
  const entry: ClipboardEntry = {
    id: nextId++,
    text,
    timestamp: Date.now(),
    isTranscription: true,
  };

  // Add to history (newest at end), remove oldest if at capacity
  history.push(entry);
  if (history.length > MAX_HISTORY_SIZE) {
    history.shift();
  }

  return entry;
}

/**
 * Restores a clipboard entry back to the system clipboard.
 */
export function restoreClipboardEntry(id: number): boolean {
  const entry = history.find(e => e.id === id);
  if (!entry) {
    return false;
  }

  // Restore image if present (takes priority)
  if (entry.image && !entry.image.isEmpty()) {
    clipboard.writeImage(entry.image);
    // If there's also text, write it as well (some apps support both)
    if (entry.text) {
      // Use write() to set multiple formats at once
      clipboard.write({
        image: entry.image,
        text: entry.text,
      });
    }
  } else if (entry.text) {
    clipboard.writeText(entry.text);
  }

  return true;
}

/**
 * Returns the clipboard history for display in menus.
 */
export function getClipboardHistory(): ClipboardEntry[] {
  return [...history];
}

/**
 * Returns a display label for a clipboard entry.
 * Truncates long text and indicates images.
 * Transcriptions are marked with a microphone icon.
 */
export function getEntryLabel(entry: ClipboardEntry, maxLength = 40): string {
  const parts: string[] = [];

  // Mark our transcriptions
  if (entry.isTranscription) {
    parts.push('[Transcribed]');
  }

  if (entry.image && !entry.image.isEmpty()) {
    const size = entry.image.getSize();
    parts.push(`[Image ${size.width}x${size.height}]`);
  }

  if (entry.text) {
    let text = entry.text.replace(/\s+/g, ' ').trim();
    if (text.length > maxLength) {
      text = text.substring(0, maxLength - 3) + '...';
    }
    parts.push(text);
  }

  return parts.join(' ') || '[Empty]';
}

/**
 * Clears all clipboard history.
 */
export function clearClipboardHistory(): void {
  history = [];
}
