// ═══════════════════════════════════════════════════════════════════════════
// PATCH 1 — Add this block near the top of main.js, after the imports
//           and after initEditor / makeResizable calls.
//           Replace the old:   let lastBinary = null, lastInstance = null, lastMeta = {};
// ═══════════════════════════════════════════════════════════════════════════

// ── Shared buffers for worker ↔ main stdin handshake ─────────────────────────
const ctrlSAB = new SharedArrayBuffer(4);      // Int32  — handshake flag
const dataSAB = new SharedArrayBuffer(4096);   // Uint8  — input bytes
const dlenSAB = new SharedArrayBuffer(4);      // Int32  — byte count
const ctrlArr = new Int32Array(ctrlSAB);
const dataArr = new Uint8Array(dataSAB);
const dlenArr = new Int32Array(dlenSAB);

// ── Worker state ──────────────────────────────────────────────────────────────
let wasmWorker       = null;
let workerReady      = false;       // true after first successful compile
let lastMeta         = {};
let lastBinary       = null;        // Uint8Array — kept for the 'hex' command
let pendingResolve   = null;        // resolves the current workerDo() promise
let stdinMode        = false;       // true while waiting for user stdin input

function initWorker() {
  wasmWorker = new Worker('./wasm-worker.js', { type: 'module' });
  wasmWorker.postMessage({ type: 'init', ctrl: ctrlSAB, data: dataSAB, dlen: dlenSAB });

  wasmWorker.onmessage = ({ data: msg }) => {
    switch (msg.type) {

      case 'stdout':
        appendToPrint(msg.text);
        break;

      // Worker is blocking on Atomics.wait — flip the terminal into stdin mode
      case 'stdin_want':
        enterStdinMode();
        break;

      case 'compiled':
        workerReady = true;
        lastMeta    = msg.meta;
        lastBinary  = new Uint8Array(msg.binary);
        print(`<span class="c-ok">✓ ${msg.bytes} bytes</span>`);
        {
          const extra = msg.bytes > 48
            ? `<span class="c-muted"> … +${msg.bytes - 48}</span>` : '';
          print(`<span class="c-hex">${msg.hex}${extra}</span>`);
        }
        print(`<span class="c-muted">exports: </span><span class="c-ok">${msg.exports.map(esc).join(', ')}</span>`);
        settle(msg);
        break;

      case 'compile_error':
        print(`<span class="c-err">✗ ${esc(msg.msg)}</span>`);
        settle(null);
        break;

      case 'run_result':
        print(`<span class="c-muted">  ${esc(msg.fn)}(${msg.args.join(', ')}) → </span><span class="c-ok">${msg.result}</span>`);
        settle(msg);
        break;

      case 'run_error':
        print(`<span class="c-err">✗ ${esc(msg.msg)}</span>`);
        settle(null);
        break;
    }
  };
}

/** Resolve the in-flight workerDo() promise. */
function settle(value) {
  if (pendingResolve) { pendingResolve(value); pendingResolve = null; }
}

/** Send a message to the worker and await its terminal response. */
function workerDo(message) {
  return new Promise(resolve => {
    pendingResolve = resolve;
    wasmWorker.postMessage(message);
  });
}

/** Switch the terminal input into stdin-feed mode. */
function enterStdinMode() {
  stdinMode = true;
  termInput.placeholder = 'stdin — press Enter to send…';
  termInput.classList.add('stdin-mode');
  print(`<span class="c-stdin">▷ stdin:</span>`);
  termInput.focus();
}
function exitStdinMode() {
  stdinMode = false;
  termInput.placeholder = '';
  termInput.classList.remove('stdin-mode');
}

initWorker();   // ← call this once during setup


// ═══════════════════════════════════════════════════════════════════════════
// PATCH 2 — Remove buildEnvObject() entirely (it now lives in the worker).
//           Delete the whole function.
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// PATCH 3 — Replace the entire runCommand() function with this version.
// ═══════════════════════════════════════════════════════════════════════════

async function runCommand(raw, isInternal = false) {
  const cmd = raw.trim();
  if (!cmd) return;

  if (!isInternal) {
    cmdHistory.unshift(cmd);
    histIdx = -1;
    print(`<span class="c-prompt">$ </span>${esc(cmd)}`);
  }

  const parts = cmd.split(/\s+/), verb = parts[0].toLowerCase();

  // ── help ──────────────────────────────────────────────────────────────────
  if (verb === 'help') {
    print(`<span class="c-muted">  compile         — compile only</span>`);
    print(`<span class="c-muted">  run fn [args]   — call exported function</span>`);
    print(`<span class="c-muted">  make [args]     — compile &amp; test all exports</span>`);
    print(`<span class="c-muted">  boot [args]     — compile &amp; run "main"</span>`);
    print(`<span class="c-muted">  hex             — full hex dump of binary</span>`);
    print(`<span class="c-muted">  clear           — clear terminal</span>`);
  }

  // ── clear ─────────────────────────────────────────────────────────────────
  else if (verb === 'clear') {
    termOutput.innerHTML = '';
  }

  // ── compile ───────────────────────────────────────────────────────────────
  else if (verb === 'compile') {
    const code = document.getElementById('code').value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }
    print(`<span class="c-muted">compiling…</span>`);
    try {
      const libs    = await gatherLibs(code);
      await workerDo({ type: 'compile', code, libs, envImports });
    } catch (e) {
      print(`<span class="c-err">✗ ${esc(e.message)}</span>`);
    }
  }

  // ── make ──────────────────────────────────────────────────────────────────
  else if (verb === 'make') {
    const code = document.getElementById('code').value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }
    print(`<span class="c-muted">compiling…</span>`);
    try {
      const libs     = await gatherLibs(code);
      const compiled = await workerDo({ type: 'compile', code, libs, envImports });
      if (!compiled) return;
      print('');

      const supplied = parts.slice(1).map(Number);
      for (const fn of compiled.exports) {
        const needed = compiled.meta[fn] ?? supplied.length;
        const args   = Array.from({ length: needed }, (_, i) =>
          i < supplied.length ? supplied[i] : 0);
        print(`<span class="c-muted">Running function ${esc(fn)}(${args.join(', ')})</span>`);
        print('');
        await workerDo({ type: 'run', fn, args });
      }
    } catch (e) {
      print(`<span class="c-err">✗ ${esc(e.message)}</span>`);
    }
  }

  // ── run ───────────────────────────────────────────────────────────────────
  else if (verb === 'run') {
    if (!workerReady) { print(`<span class="c-warn">⚠ run compile/make first</span>`); return; }
    const fn = parts[1], args = parts.slice(2).map(Number);
    if (!fn) { print(`<span class="c-err">usage: run &lt;fn&gt; [args]</span>`); return; }
    print(`<span class="c-muted">Running function ${esc(fn)}(${args.join(', ')})</span>`);
    print('');
    await workerDo({ type: 'run', fn, args });
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  else if (verb === 'boot') {
    const code = document.getElementById('code').value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }
    print(`<span class="c-muted">compiling…</span>`);
    try {
      const libs     = await gatherLibs(code);
      const compiled = await workerDo({ type: 'compile', code, libs, envImports });
      if (!compiled) return;
      print('');
      const supplied = parts.slice(1).map(Number);
      const needed   = compiled.meta['main'] ?? supplied.length;
      const args     = Array.from({ length: needed }, (_, i) =>
        i < supplied.length ? supplied[i] : 0);
      print(`<span class="c-muted">Running function main(${args.join(', ')})</span>`);
      print('');
      await workerDo({ type: 'run', fn: 'main', args });
    } catch (e) {
      print(`<span class="c-err">✗ ${esc(e.message)}</span>`);
    }
  }

  // ── hex ───────────────────────────────────────────────────────────────────
  else if (verb === 'hex') {
    if (!lastBinary) { print(`<span class="c-warn">⚠ run compile first</span>`); return; }
    let row = '';
    for (let i = 0; i < lastBinary.length; i++)
      row += lastBinary[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
    if (row) print(`<span class="c-hex">${row}</span>`);
  }

  // ── test (passthrough) ───────────────────────────────────────────────────
  else if (verb === 'test') {
    print(test(...parts.slice(1)));
  }

  else {
    print(`<span class="c-err">✗ unknown command: ${esc(verb)}</span>`);
  }

  if (!isInternal) print('');
}


// ═══════════════════════════════════════════════════════════════════════════
// PATCH 4 — Replace the termInput keydown listener with this version.
//           Find the old one (it starts with termInput.addEventListener)
//           and swap it out entirely.
// ═══════════════════════════════════════════════════════════════════════════

termInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = termInput.value;
    termInput.value = "";

    if (stdinMode) {
      // ── Feed input to the blocked worker ──────────────────────────────────
      // Echo what the user typed so the terminal shows it
      const last = termOutput.lastElementChild;
      if (last) last.innerHTML += `<span class="c-ok"> ${esc(v)}</span>`;

      // Encode and write into the shared buffer
      const encoded = new TextEncoder().encode(v + '\n');
      const n       = Math.min(encoded.length, dataArr.length);
      dataArr.set(encoded.subarray(0, n));
      Atomics.store(dlenArr, 0, n);
      Atomics.store(ctrlArr, 0, 2);   // mark as ready (≠ 1  →  unblocks wait)
      Atomics.notify(ctrlArr, 0, 1);  // wake the worker

      exitStdinMode();
      return;
    }

    // Normal terminal command
    runCommand(v);

  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (histIdx < cmdHistory.length - 1) {
      histIdx++;
      termInput.value = cmdHistory[histIdx];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx > 0) { histIdx--; termInput.value = cmdHistory[histIdx]; }
    else { histIdx = -1; termInput.value = ""; }
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// PATCH 5 — Add this CSS to your stylesheet (or a <style> block).
//           Gives the terminal a visual cue when in stdin mode.
// ═══════════════════════════════════════════════════════════════════════════
/*

*/