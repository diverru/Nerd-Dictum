/**
 * Sound feedback utilities using Web Audio API
 * Generates small notification sounds without requiring audio files
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Play a success sound — sharp UI "click" / "tick". A real click is a
 * burst of broadband noise, not a tone. We generate a short white-noise
 * buffer, run it through a band-pass filter to get a satisfying mid-
 * frequency tick (mouse-click-ish), and apply a near-instantaneous
 * attack + fast exponential decay.
 */
export function playSuccessSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // 30 ms of white noise — long enough for the filter to ring slightly,
    // short enough to feel percussive.
    const noiseDuration = 0.03;
    const bufferLength = Math.max(1, Math.floor(ctx.sampleRate * noiseDuration));
    const buffer = ctx.createBuffer(1, bufferLength, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferLength; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Band-pass around 1.8 kHz: kills the rumble and the hiss, leaves the
    // mid-frequency "tick" character.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.6, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start(now);
    source.stop(now + 0.06);
  } catch (error) {
    console.error('[Sound] Failed to play success sound:', error);
  }
}

/**
 * Play a recording-start sound — short rising blip, distinct from success.
 */
export function playStartSound(): void {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine';

    const now = ctx.currentTime;
    oscillator.frequency.setValueAtTime(600, now);
    oscillator.frequency.linearRampToValueAtTime(900, now + 0.08);

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.25, now + 0.015);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.12);

    oscillator.start(now);
    oscillator.stop(now + 0.15);
  } catch (error) {
    console.error('[Sound] Failed to play start sound:', error);
  }
}

/**
 * Play an error/no-speech sound — short low double-blip ("buh-buh"),
 * square wave for distinctiveness so it's clearly different from the
 * success / paste tones.
 */
export function playErrorSound(): void {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'square';

    const now = ctx.currentTime;
    oscillator.frequency.setValueAtTime(220, now);

    // First blip
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.18, now + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.1);
    // Brief silence
    gainNode.gain.setValueAtTime(0, now + 0.13);
    // Second blip
    gainNode.gain.linearRampToValueAtTime(0.18, now + 0.14);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.24);

    oscillator.start(now);
    oscillator.stop(now + 0.26);
  } catch (error) {
    console.error('[Sound] Failed to play error sound:', error);
  }
}
