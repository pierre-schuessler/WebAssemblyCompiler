// wasm-worker.js
// Runs WebAssembly in a dedicated thread so Atomics.wait() can block
// for stdin without freezing the UI.

import { compile } from './compiler.js';

// ── Shared buffers (initialised by main thread via 'init' message) ────────────
let ctrl;   // Int32Array[1]  — 0 = idle, 1 = worker waiting, 2 = input ready
let data;   // Uint8Array[4096] — raw bytes of the line typed by the user
let dlen;   // Int32Array[1]  — number of valid bytes in `data`

// ── Runtime state ─────────────────────────────────────────────────────────────
let inst      = null;   // WebAssembly instance
let meta      = {};     // fn-name → arg count (from binary.meta)
let outBuf    = '';     // stdout accumulator (flushed on \n or function return)
let charQueue = [];     // leftover bytes for getchar() between lines

// ── Message dispatch ──────────────────────────────────────────────────────────
self.onmessage = async ({ data: msg }) => {

  // ── init: receive the three SharedArrayBuffers ──────────────────────────
  if (msg.type === 'init') {
    ctrl = new Int32Array(msg.ctrl);
    data = new Uint8Array(msg.data);
    dlen = new Int32Array(msg.dlen);
    return;
  }

  // ── compile ──────────────────────────────────────────────────────────────
  if (msg.type === 'compile') {
    try {
      const bin = compile(msg.code, msg.libs);
      if (!bin) throw new Error('compile() returned null');

      meta       = bin.meta || {};
      const mod  = await WebAssembly.compile(bin);
      inst       = await WebAssembly.instantiate(mod, { env: buildEnv(msg.envImports) });

      flush();
      self.postMessage({
        type:    'compiled',
        bytes:   bin.length,
        hex:     hexPreview(bin),
        exports: Object.keys(inst.exports),
        meta,
        // send full binary so main thread can still run 'hex' command
        binary:  Array.from(bin),
      });
    } catch (e) {
      flush();
      self.postMessage({ type: 'compile_error', msg: e.message });
    }
    return;
  }

  // ── run ───────────────────────────────────────────────────────────────────
  if (msg.type === 'run') {
    if (!inst) {
      self.postMessage({ type: 'run_error', msg: 'not compiled' });
      return;
    }
    const f = inst.exports[msg.fn];
    if (typeof f !== 'function') {
      self.postMessage({ type: 'run_error', msg: `no export "${msg.fn}"` });
      return;
    }
    try {
      const result = f(...(msg.args || []));
      flush();
      self.postMessage({ type: 'run_result', fn: msg.fn, args: msg.args, result });
    } catch (e) {
      flush();
      self.postMessage({ type: 'run_error', msg: e.message });
    }
  }
};

// ── Env builder ───────────────────────────────────────────────────────────────
function buildEnv(imports = []) {
  const env = {};

  // ── putchar(c: i32) ───────────────────────────────────────────────────────
  env.putchar = (c) => {
    const ch = String.fromCharCode(c & 0xff);
    outBuf += ch;
    if (ch === '\n') flush();
  };

  // ── readline(addr: i32, maxLen: i32) → i32 ────────────────────────────────
  // Blocks until the user presses Enter in the terminal.
  // Writes the line (including '\n') into WASM memory at `addr`,
  // null-terminates it, and returns the number of bytes written.
  env.readline = (addr, maxLen) => {
    waitForLine();

    const len = Atomics.load(dlen, 0);
    const n   = Math.min(len, Math.max(0, maxLen - 1));  // leave room for '\0'
    const mem = new Uint8Array(inst.exports.memory.buffer);
    mem.set(data.subarray(0, n), addr);
    mem[addr + n] = 0;   // null-terminate

    Atomics.store(ctrl, 0, 0);   // reset to idle
    return n;
  };

  // ── getchar() → i32 ──────────────────────────────────────────────────────
  // Returns one byte at a time; requests a new line whenever the
  // internal queue is empty.  Returns -1 on EOF (empty line submitted).
  env.getchar = () => {
    if (charQueue.length === 0) {
      waitForLine();

      const len = Atomics.load(dlen, 0);
      for (let i = 0; i < len; i++) charQueue.push(data[i]);
      Atomics.store(ctrl, 0, 0);
    }
    return charQueue.length ? charQueue.shift() : -1;
  };

  // ── User-defined env imports (from the Env panel) ─────────────────────────
  const ARGNAMES = ['a','b','c','d','e','f','g','h'];
  for (const imp of imports) {
    if (imp.name in env) continue;   // never override built-ins

    const arity = (imp.sig || '').split('=>')[0]
                    .trim().split(/\s+/).filter(Boolean).length;

    // Redirect console.stdout() calls to the worker's stdout buffer
    const body = (imp.body || 'return 0;')
                   .replace(/console\.stdout\s*\(/g, '__out(');
    try {
      env[imp.name] = new Function('__out', ...ARGNAMES.slice(0, arity), body)
                        .bind(null, (s) => { outBuf += s; });
    } catch { /* skip malformed bodies */ }
  }

  return env;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Block the worker until the main thread delivers a line of input.
 * Flow:
 *   1. Store 1 in ctrl  →  signals "worker is waiting"
 *   2. postMessage      →  tells the UI to enter stdin mode
 *   3. Atomics.wait     →  sleeps here until ctrl[0] is no longer 1
 *      (main thread stores 2 and calls Atomics.notify after getting input)
 */
function waitForLine() {
  Atomics.store(ctrl, 0, 1);
  self.postMessage({ type: 'stdin_want' });
  Atomics.wait(ctrl, 0, 1);   // wakes when main stores 2 (≠ 1)
}

function flush() {
  if (!outBuf) return;
  self.postMessage({ type: 'stdout', text: outBuf });
  outBuf = '';
}

function hexPreview(bin) {
  const n = Math.min(bin.length, 48);
  let s = '';
  for (let i = 0; i < n; i++)
    s += bin[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
  return s;
}