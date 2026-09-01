#!/usr/bin/env bun
/**
 * Build the parakeet-bridge Swift executable.
 *
 * - macOS: invokes `swift build -c release` inside swift/. Result is the
 *   binary at swift/.build/release/parakeet-bridge which is bundled by
 *   electron-builder via extraResources, and which parakeet-service.ts
 *   spawns at runtime for ANE-accelerated inference.
 * - Other platforms / no Swift toolchain: skipped silently. Local STT mode
 *   simply isn't available; hold-to-record / wake-word / Gemini-only
 *   transcription continue to work.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const swiftDir = resolve(projectRoot, 'swift');

if (process.platform !== 'darwin') {
  console.log(`[build:swift] platform=${process.platform} — skipping (Swift bridge is macOS-only)`);
  process.exit(0);
}

if (!existsSync(swiftDir)) {
  console.log('[build:swift] swift/ directory missing — skipping');
  process.exit(0);
}

const swiftCheck = spawnSync('swift', ['--version'], { stdio: 'ignore' });
if (swiftCheck.status !== 0) {
  console.warn('[build:swift] `swift` not found in PATH — skipping. Local STT mode will be unavailable until the binary is built.');
  process.exit(0);
}

console.log('[build:swift] swift build -c release …');
const t0 = Date.now();
// FluidAudio only compiles for arm64 (Float16 does not exist on x86_64).
// A Rosetta shell (e.g. an x86_64 tmux/terminal on Apple Silicon) makes
// `swift build` target x86_64 and fail — force the native arch there.
const translated = spawnSync('sysctl', ['-n', 'sysctl.proc_translated']).stdout?.toString().trim() === '1';
const [cmd, args] = translated
  ? ['arch', ['-arm64', 'swift', 'build', '-c', 'release']]
  : ['swift', ['build', '-c', 'release']];
const build = spawnSync(cmd, args as string[], {
  cwd: swiftDir,
  stdio: 'inherit',
});

if (build.status !== 0) {
  console.error(`[build:swift] swift build failed (exit ${build.status})`);
  process.exit(build.status ?? 1);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[build:swift] OK in ${elapsed}s — swift/.build/release/parakeet-bridge`);
