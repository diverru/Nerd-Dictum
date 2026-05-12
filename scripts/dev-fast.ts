#!/usr/bin/env bun
/**
 * Fast dev loop for the Electron app.
 *
 * Equivalent of `bun run dev` but with continuous bundle rebuilding and
 * automatic Electron restart on main/preload changes. Renderer changes go
 * through Vite HMR as before — no restart needed for React.
 *
 * Pipeline:
 *   1. One-time `build:swift` (Swift binary rarely changes, slow to rebuild).
 *   2. `bun build --watch` for main and preload — rebuilds in <100ms.
 *   3. `vite` dev server for the renderer (HMR).
 *   4. Wait for Vite, launch Electron.
 *   5. fs.watch dist/main/main.js + dist/preload/preload.js — on each
 *      bundle write, kill the running Electron and spawn a fresh one
 *      (debounced 200ms so a series of writes don't thrash).
 *
 * Ctrl-C cleans up every spawned child.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { watch, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITE_PORT = process.env.VITE_PORT ?? '12000';

const SHARED_BUILD_FLAGS = ['--target', 'node', '--external', 'electron'];
const MAIN_BUILD_FLAGS = [
  ...SHARED_BUILD_FLAGS,
  '--external', 'onnxruntime-node',
  '--external', '@picovoice/pvrecorder-node',
  '--external', 'undici',
];
const PRELOAD_BUILD_FLAGS = [...SHARED_BUILD_FLAGS, '--format', 'cjs'];

const children: ChildProcess[] = [];

function spawnChild(label: string, cmd: string, args: string[]): ChildProcess {
  console.log(`[dev-fast] start ${label}: ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.log(`[dev-fast] ${label} exited code=${code} signal=${signal}`);
  });
  children.push(child);
  return child;
}

function runOnce(label: string, cmd: string, args: string[]): void {
  console.log(`[dev-fast] one-shot ${label}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[dev-fast] ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

let electron: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let restartGen = 0;

function startElectron(): void {
  if (electron && electron.exitCode === null) {
    electron.removeAllListeners('exit');
    electron.kill('SIGTERM');
  }
  const gen = ++restartGen;
  electron = spawn('electron', ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  electron.on('exit', (code, signal) => {
    // Only log unexpected exits — explicit kill on restart sets generation.
    if (gen === restartGen) {
      console.log(`[dev-fast] electron exited code=${code} signal=${signal}`);
    }
  });
  console.log(`[dev-fast] electron started (gen=${gen}, pid=${electron.pid})`);
}

function scheduleRestart(reason: string): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[dev-fast] ${reason} → restarting electron`);
    startElectron();
  }, 200);
}

// 1) Initial swift build (cheap if .build cached, skipped on non-macOS).
runOnce('build:swift', 'bun', ['run', 'scripts/build-swift.ts']);

// 2) Watched main + preload bundles.
spawnChild('build:main(--watch)', 'bun', [
  'build',
  'src/main/main.ts',
  '--outdir', 'dist/main',
  ...MAIN_BUILD_FLAGS,
  '--watch',
]);

spawnChild('build:preload(--watch)', 'bun', [
  'build',
  'src/preload/preload.ts',
  '--outdir', 'dist/preload',
  ...PRELOAD_BUILD_FLAGS,
  '--watch',
]);

// 3) Vite dev server for the renderer.
spawnChild('vite', './node_modules/.bin/vite', []);

// 4) Wait for Vite + initial bundles to land before booting electron.
runOnce('wait-on', './node_modules/.bin/wait-on', [
  `http://localhost:${VITE_PORT}`,
  'file:dist/main/main.js',
  'file:dist/preload/preload.js',
]);

// 5) Watch bundle outputs and restart electron on change.
const mainBundle = resolve(root, 'dist/main/main.js');
const preloadBundle = resolve(root, 'dist/preload/preload.js');
if (!existsSync(mainBundle) || !existsSync(preloadBundle)) {
  console.error('[dev-fast] bundles missing after wait-on, aborting');
  process.exit(1);
}
watch(mainBundle, () => scheduleRestart('main bundle changed'));
watch(preloadBundle, () => scheduleRestart('preload bundle changed'));
console.log('[dev-fast] watching bundles for changes…');

startElectron();

// 6) Cleanup on shutdown.
function shutdown(signal: NodeJS.Signals): void {
  console.log(`[dev-fast] received ${signal}, cleaning up`);
  if (restartTimer) clearTimeout(restartTimer);
  if (electron && electron.exitCode === null) electron.kill('SIGTERM');
  for (const c of children) {
    if (c.exitCode === null) c.kill('SIGTERM');
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
