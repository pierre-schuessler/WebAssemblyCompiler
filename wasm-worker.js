// wasm-worker.js — WASM execution context
//
// Shared-memory layout (set up by main thread via "init" message):
//
//   controlSAB  Int32Array[2]
//     [0]  signal   0 = worker waiting for input  |  1 = input is ready
//     [1]  dataLen  byte-length of the encoded string sitting in dataSAB
//
//   dataSAB  Uint8Array[4096]   — UTF-8 payload of one stdin line
//
// Stdin flow
//   1. Worker sets control[0] = 0, posts "input-request"
//   2. Worker calls Atomics.wait(control, 0, 0) → thread parks
//   3. Main thread calls window.prompt(), encodes result into dataSAB,
//      writes length into control[1], stores 1 into control[0],
//      calls Atomics.notify(control, 0)
//   4. Worker unblocks, reads dataBuf[0..dataLen-1]

"use strict";

let controlBuf  = null;   // Int32Array view of controlSAB
let dataBuf     = null;   // Uint8Array  view of dataSAB
let lastInstance = null;

// ─── stdout buffering ────────────────────────────────────────────────────────

let outBuf = "";

function flushOut() {
  if (outBuf) {
    self.postMessage({ type: "stdout", text: outBuf });
    outBuf = "";
  }
}

// Allow user-defined env bodies to write via self.stdout("…")
self.stdout = (text) => self.postMessage({ type: "stdout", text: String(text) });

// ─── blocking stdin ──────────────────────────────────────────────────────────

function blockForInput() {
  flushOut();                                  // flush pending output first
  Atomics.store(controlBuf, 0, 0);             // mark: waiting
  self.postMessage({ type: "input-request" }); // ask main thread for a line
  Atomics.wait(controlBuf, 0, 0);              // park until main notifies
}

// ─── env object ─────────────────────────────────────────────────────────────

function buildEnvObject(envImports) {
  const env      = {};
  const argNames = ["a", "b", "c", "d", "e", "f", "g", "h"];

  // ── built-ins ──────────────────────────────────────────────────────────────

  env.putchar = (charCode) => {
    const ch = String.fromCharCode(charCode);
    outBuf += ch;
    if (ch === "\n") flushOut();
  };

  env.readline = (addr, maxLen) => {
    blockForInput();
    const len = Atomics.load(controlBuf, 1);
    const mem = new Uint8Array(lastInstance.exports.memory.buffer);
    const n   = Math.min(len, Math.max(0, maxLen - 1));
    for (let i = 0; i < n; i++) mem[addr + i] = dataBuf[i];
    mem[addr + n] = 0;         // null-terminate
    return n;
  };

  // line-buffered getchar
  let _charBuf = [], _charPos = 0;
  env.getchar = () => {
    if (_charPos >= _charBuf.length) {
      blockForInput();
      const len = Atomics.load(controlBuf, 1);
      _charBuf  = Array.from(dataBuf.subarray(0, len));
      _charBuf.push(10);  // implicit '\n'
      _charPos  = 0;
    }
    return _charPos < _charBuf.length ? _charBuf[_charPos++] : -1;
  };

  // ── user-defined imports ──────────────────────────────────────────────────

  for (const imp of envImports) {
    if (imp.name in env) continue;   // built-ins win
    const arity = imp.sig.split("=>")[0].trim().split(/\s+/).filter(Boolean).length;
    const args  = argNames.slice(0, arity);
    try {
      env[imp.name] = new Function(...args, imp.body || "return 0;");
    } catch (err) {
      throw new Error(`env.${imp.name}: ${err.message}`);
    }
  }

  return env;
}

// ─── message handler ─────────────────────────────────────────────────────────

self.onmessage = async ({ data: msg }) => {
  switch (msg.type) {

    // ── init: receive shared buffers from main ──────────────────────────────
    case "init":
      controlBuf = new Int32Array(msg.controlSAB);
      dataBuf    = new Uint8Array(msg.dataSAB);
      break;

    // ── compile: instantiate a new WASM module ──────────────────────────────
    case "compile": {
      lastInstance = null;
      try {
        const wasmMod  = await WebAssembly.compile(msg.binary);
        const env      = buildEnvObject(msg.envImports);
        lastInstance   = await WebAssembly.instantiate(wasmMod, { env });
        self.lastInstance = lastInstance;

        const allExports  = Object.keys(lastInstance.exports);
        const funcExports = allExports.filter(
          k => typeof lastInstance.exports[k] === "function"
        );
        self.postMessage({ type: "compiled", allExports, funcExports });
      } catch (err) {
        self.postMessage({ type: "error", message: err.message });
      }
      break;
    }

    // ── run: call an exported function ─────────────────────────────────────
    case "run": {
      if (!lastInstance) {
        self.postMessage({ type: "error", message: "no compiled module — run compile first" });
        break;
      }
      const { fn, args } = msg;
      const func = lastInstance.exports[fn];
      if (typeof func !== "function") {
        self.postMessage({ type: "error", message: `no export "${fn}"` });
        break;
      }
      try {
        const result = func(...args);
        flushOut();
        self.postMessage({ type: "result", fn, args, result });
      } catch (err) {
        flushOut();
        self.postMessage({ type: "error", message: err.message });
      }
      break;
    }

    // ── input-response: main thread returns a stdin line ───────────────────
    case "input-response": {
      const encoded = new TextEncoder().encode(msg.value);
      const len     = Math.min(encoded.length, dataBuf.length);
      dataBuf.set(encoded.subarray(0, len));
      Atomics.store(controlBuf, 1, len);   // write length
      Atomics.store(controlBuf, 0, 1);     // signal ready
      Atomics.notify(controlBuf, 0);       // wake the worker
      break;
    }

    // ── terminate: reset state (used when main thread recreates worker) ────
    case "reset":
      lastInstance = null;
      outBuf       = "";
      _charBuf     = [];    // eslint-disable-line no-undef
      break;
  }
};