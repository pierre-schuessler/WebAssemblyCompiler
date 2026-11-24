// ─── Source registry ────────────────────────────────────────────────────────

const COMPILER_SOURCES = [
  { id: "lang_1",  label: "Language v1", path: "./compilers/lang_1.js" },
  { id: "lang_2",  label: "Language v2", path: "./compilers/lang_2.js" },
];

const EDITOR_SOURCES = [
  { id: "lang_1",  label: "Language v1", path: "./editors/lang_1.js" },
  { id: "lang_2",  label: "Language v2", path: "./editors/lang_2.js" },
];

// ─── Active source state ─────────────────────────────────────────────────────

let activeCompilerId = localStorage.getItem("wasm-compiler-src") || COMPILER_SOURCES[0].id;
let activeEditorId   = localStorage.getItem("wasm-editor-src")   || EDITOR_SOURCES[0].id;

let compile    = null;   // (code, libs) => Uint8Array | Promise<Uint8Array>
let initEditor = null;
let editor     = null;

// ─── Versions store ──────────────────────────────────────────────────────────
// NOTE: must stay above bootstrap() — loadCompiler() reads it synchronously.
//
// { [progName]: [ { id, n, ts, label, code, binary(b64), size,
//                   compiler: { id, label } } ] }

const VERSIONS_KEY = "wasm-versions";
let versions = {};
try { versions = JSON.parse(localStorage.getItem(VERSIONS_KEY) || "{}"); } catch {}

// A binary is only trustworthy if it was built from exactly the version's current
// code. `hash` is the hash of the code that produced `binary`.
function hashCode(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return s.length + ":" + (h >>> 0).toString(16);
}
function isStale(ver) { return ver.hash !== hashCode(ver.code); }

// versions saved before `hash` existed were in sync by construction
for (const list of Object.values(versions))
  for (const v of list) v.hash ??= hashCode(v.code);

// Rebuilds a version's binary with the active compiler whenever its code changed.
// Never rejects: on failure the version stays stale and `error` says why.
const verChain  = new Map();   // id → promise (serialises rebuilds per version)
const verTimers = new Map();   // id → debounce timer

function scheduleVersionSync(id) {
  clearTimeout(verTimers.get(id));
  verTimers.set(id, setTimeout(() => syncVersion(id), 800));
}

function syncVersion(id) {
  clearTimeout(verTimers.get(id));
  verTimers.delete(id);
  const run = async () => {
    const hit = findVersion(id);
    if (!hit || !isStale(hit.ver)) { persistVersions(); return; }
    const ver = hit.ver, code = ver.code;
    try {
      const binary = await compile(code, await gatherLibs(code));
      if (!binary) throw new Error("compile() returned null");
      ver.binary   = toB64(binary);
      ver.size     = binary.length;
      ver.hash     = hashCode(code);            // hash of the code actually compiled
      ver.compiler = { id: activeCompilerId, label: compilerLabel(activeCompilerId) };
      delete ver.error;
      if (activeCompilerId === "boot:" + id)
        print(`<span class="c-muted">note: ${esc(compilerLabel(activeCompilerId))} was rebuilt — re-select it as compiler to load the new binary</span>`);
    } catch (err) {
      ver.error = err.message;
    }
    persistVersions();
    renderProgList();
  };
  const p = (verChain.get(id) ?? Promise.resolve()).then(run);
  verChain.set(id, p);
  return p;
}

window.addEventListener("beforeunload", () => persistVersions());

function persistVersions() {
  try {
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions));
    return true;
  } catch (err) {
    print(`<span class="c-err">✗ could not store versions (storage full?): ${esc(err.message)}</span>`);
    return false;
  }
}

function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function findVersion(id) {
  for (const [prog, list] of Object.entries(versions)) {
    const ver = list.find(v => v.id === id);
    if (ver) return { prog, ver };
  }
  return null;
}

/** Built-in compilers + every saved version (id "boot:<versionId>"). */
function allCompilerSources() {
  const saved = [];
  for (const [prog, list] of Object.entries(versions))
    for (const v of list)
      saved.push({
        id:    "boot:" + v.id,
        label: `${prog} v${v.n}`,
        path:  `bootstrapped · built by ${v.compiler.label}`,
      });
  return [...COMPILER_SOURCES, ...saved];
}

function compilerLabel(id) {
  return allCompilerSources().find(s => s.id === id)?.label ?? id;
}

// ─── Bootstrapped compiler (a compiled version used as the compiler) ─────────
//
// Protocol for a program that acts as a compiler:
//   • must export `compiler.main` and `memory`
//   • compiler.main() calls get_code(addr) to read the source, then compiles it to memory.
//   • RETURN PROTOCOL:
//     Option A (i32): Return the memory address. The host will read a 32-bit integer
//                     (the length) from that address, and read the binary starting at address + 4.
//     Option B (i64): Return a 64-bit integer combining length and address
//                     ((length << 32) | address).

const COMPILER_ENTRY = "compiler.main";

async function makeBootstrappedCompiler(ver) {
  const module  = await WebAssembly.compile(fromB64(ver.binary));
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module).map(e => e.name);
  
  if (!exports.includes(COMPILER_ENTRY))
    throw new Error(`version has no exported '${COMPILER_ENTRY}'`);
  if (!exports.includes("memory")) 
    throw new Error("version has no exported 'memory'");

  return async function compileBootstrapped(code /*, libs */) {
    let instance = null;

    const host = {
      // putchar is left intact to prevent import errors if older versions still use it, 
      // or if your new compiler wants to print debug logs to the terminal.
      putchar(c) { console.log("compiler stdout:", c); return c; },
      
      get_code(addr) {
        addr >>>= 0;
        const bytes = new TextEncoder().encode(code);
        const mem   = instance.exports.memory;
        const need  = addr + bytes.length + 1;
        if (need > mem.buffer.byteLength)
          mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
        const view = new Uint8Array(mem.buffer);
        view.set(bytes, addr);
        view[addr + bytes.length] = 0;      // null terminator
        return bytes.length;
      },
      log(a)    { console.log(a); return a; },
      pow(a, b) { return Math.pow(a, b) | 0; },
    };

    const env = {};
    for (const imp of imports) {
      if (imp.module !== "env" || imp.kind !== "function" || !(imp.name in host))
        throw new Error(`bootstrapped compiler imports unsupported ${imp.module}.${imp.name}`);
      env[imp.name] = host[imp.name];
    }

    instance = await WebAssembly.instantiate(module, { env });

    // Execute the compiler entry point
    const result = instance.exports[COMPILER_ENTRY]();
    const memBuffer = instance.exports.memory.buffer;

    let binLength, binStart;

    if (typeof result === "bigint") {
      // Option B: i64 return type (Length in high 32 bits, Address in low 32 bits)
      binStart  = Number(result & 0xFFFFFFFFn);
      binLength = Number(result >> 32n);
    } else {
      // Option A: i32 return type (Address returned; Length is stored at Address)
      const addr = Number(result);
      const dataView = new DataView(memBuffer);
      binLength = dataView.getUint32(addr, true); // Read 4-byte length (little-endian)
      binStart  = addr + 4;                       // Binary data starts immediately after
    }

    if (binStart + binLength > memBuffer.byteLength) {
       throw new Error("Compiler returned an address and length that exceed allocated memory bounds.");
    }

    // Copy the binary out of WASM memory (using .slice() to create a detached copy)
    const bin = new Uint8Array(memBuffer, binStart, binLength).slice();

    const isWasm = bin.length >= 4 &&
      bin[0] === 0x00 && bin[1] === 0x61 && bin[2] === 0x73 && bin[3] === 0x6D;

    if (!isWasm) {
      // If it doesn't start with \0asm, assume it's a compiler error string
      const msg = new TextDecoder().decode(bin).trim();
      throw new Error(msg || "bootstrapped compiler produced no valid wasm output");
    }

    return bin;
  };
}

// ─── Dynamic loader ──────────────────────────────────────────────────────────

async function loadCompiler(id) {
  if (id.startsWith("boot:")) {
    const vid = id.slice(5);
    const hit = findVersion(vid);
    if (!hit) throw new Error("saved version not found");
    if (isStale(hit.ver) && compile) await syncVersion(vid);   // rebuild first
    if (isStale(hit.ver))
      throw new Error(hit.ver.error
        ? `binary is out of sync with its code, and the code does not compile: ${hit.ver.error}`
        : "binary is out of sync with its code");
    compile = await makeBootstrappedCompiler(hit.ver);
    activeCompilerId = id;
  } else {
    const src = COMPILER_SOURCES.find(s => s.id === id) ?? COMPILER_SOURCES[0];
    const mod = await import(src.path);
    compile   = mod.compile;
    activeCompilerId = src.id;
  }
  localStorage.setItem("wasm-compiler-src", activeCompilerId);
}

async function loadEditor(id) {
  const src    = EDITOR_SOURCES.find(s => s.id === id) ?? EDITOR_SOURCES[0];
  const mod    = await import(src.path);
  initEditor   = mod.initEditor;
  activeEditorId = src.id;
  localStorage.setItem("wasm-editor-src", src.id);
}

async function bootstrap() {
  await Promise.all([
    // fall back to the first built-in if a saved bootstrapped version is gone / broken
    loadCompiler(activeCompilerId).catch(() => loadCompiler(COMPILER_SOURCES[0].id)),
    loadEditor(activeEditorId),
  ]);

  editor = initEditor(
    document.getElementById("code"),
    document.getElementById("editorWrap")
  );

  renderSourcesPanel();
  initApp();
}

bootstrap();

// ─── Source-switcher panel ────────────────────────────────────────────────────

function toggleSourcesPanel() {
  const panel = document.getElementById("sourcesPanel");
  const btn   = document.getElementById("activitySources");
  const open  = panel.classList.toggle("collapsed") === false;
  btn.classList.toggle("active", open);
  if (open) renderSourcesPanel();
}

async function switchCompiler(id) {
  if (id === activeCompilerId) return;
  print(`<span class="c-muted">switching compiler → </span><span class="c-ok">${esc(compilerLabel(id))}</span>`);
  try {
    await loadCompiler(id);
    renderSourcesPanel();
    renderProgList();
    print(`<span class="c-ok">✓ compiler loaded: ${esc(compilerLabel(id))}</span>`);
  } catch (err) {
    print(`<span class="c-err">✗ failed to load compiler "${esc(compilerLabel(id))}": ${esc(err.message)}</span>`);
  }
  print("");
}

function renderSourcesPanel() {
  renderSourceGroup(
    "srcCompilerList",
    allCompilerSources(),
    activeCompilerId,
    switchCompiler
  );

  renderSourceGroup(
    "srcEditorList",
    EDITOR_SOURCES,
    activeEditorId,
    async (id) => {
      if (id === activeEditorId) return;
      print(`<span class="c-muted">switching editor → </span><span class="c-ok">${esc(id)}</span>`);
      try {
        await loadEditor(id);
        editor = initEditor(
          document.getElementById("code"),
          document.getElementById("editorWrap")
        );
        renderSourcesPanel();
        updateLineNumbers();
        print(`<span class="c-ok">✓ editor loaded: ${esc(id)}</span>`);
      } catch (err) {
        print(`<span class="c-err">✗ failed to load editor "${esc(id)}": ${esc(err.message)}</span>`);
      }
      print("");
    }
  );
}

function renderSourceGroup(listId, sources, activeId, onSelect) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = sources.map(src => `
    <div class="src-item${src.id === activeId ? " active" : ""}" data-id="${esc(src.id)}">
      <span class="src-item-dot"></span>
      <span class="src-item-label">${esc(src.label)}</span>
      <span class="src-item-path">${esc(src.path)}</span>
    </div>
  `).join("");
  list.querySelectorAll(".src-item").forEach(el => {
    el.addEventListener("click", () => onSelect(el.dataset.id));
  });
}

// ─── The rest of the original app ────────────────────────────────────────────

function initApp() {
  makeResizable("resizeEnv",     "sidePanel",    140, 520, "wasm-env-panel-w");
  makeResizable("resizeDocs",    "docsPanel",    140, 520, "wasm-docs-panel-w");
  makeResizable("resizeProg",    "progPanel",    140, 520, "wasm-prog-panel-w");
  makeResizable("resizeSources", "sourcesPanel", 140, 520, "wasm-sources-panel-w");

  renderEnvList();
  updateLineNumbers();
  initWorker();

  for (const list of Object.values(versions))
    for (const v of list) if (isStale(v)) syncVersion(v.id);

  print(`<span class="c-info">WASM Compiler ready.</span>`);
  print(`<span class="c-muted">compile · run &lt;fn&gt; [args] · make · save · versions · compiler · hex · wat · clear · help</span>`);
  print("");
}

function makeResizable(handleId, panelId, minW, maxW, storageKey) {
  const handle = document.getElementById(handleId);
  const panel  = document.getElementById(panelId);
  if (!handle || !panel) return;

  let startX, startW, dragging = false;

  const saved = localStorage.getItem(storageKey);
  if (saved) panel.style.width = saved + "px";

  handle.classList.toggle("hidden-handle", panel.classList.contains("collapsed"));

  handle.addEventListener("mousedown", (e) => {
    if (panel.classList.contains("collapsed")) return;
    dragging = true;
    startX   = e.clientX;
    startW   = panel.offsetWidth;
    handle.classList.add("dragging");
    document.body.classList.add("dragging-panel");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW  = Math.max(minW, Math.min(maxW, startW + delta));
    panel.style.width = newW + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("dragging-panel");
    localStorage.setItem(storageKey, panel.offsetWidth);
  });
}


// ─── Web Worker & SharedArrayBuffer ──────────────────────────────────────────
//
// SharedArrayBuffer requires Cross-Origin-Isolation headers on the page:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// Without them, new SharedArrayBuffer() throws. We detect this below and
// fall back to a warning rather than crashing silently.
//
// Shared-memory layout
//   controlSAB  Int32Array[2]
//     [0]  signal   0 = worker blocked waiting  |  1 = input ready
//     [1]  dataLen  byte-length written into dataSAB
//   dataSAB  Uint8Array[4096]  — UTF-8 bytes of one stdin line

let wasmWorker     = null;
let controlSAB     = null;
let dataSAB        = null;

// Single-slot promise bridge (only one worker call in-flight at a time)
let _workerResolve = null;
let _workerReject  = null;

function initWorker() {
  if (!crossOriginIsolated) {
    print(`<span class="c-warn">⚠ SharedArrayBuffer unavailable: page is not cross-origin isolated.</span>`);
    print(`<span class="c-muted">  Add COOP/COEP headers or use a COOP-aware dev server (e.g. vite --https).</span>`);
    print(`<span class="c-muted">  stdin (readline / getchar) will not work until this is resolved.</span>`);
    print("");
  }

  // Allocate shared buffers (may throw if !crossOriginIsolated on some browsers)
  try {
    controlSAB = new SharedArrayBuffer(8);     // Int32Array[2]
    dataSAB    = new SharedArrayBuffer(4096);  // Uint8Array[4096]
  } catch {
    // graceful degradation: worker will start but stdin will not block correctly
    controlSAB = null;
    dataSAB    = null;
  }

  _spawnWorker();
}

function _spawnWorker() {
  if (wasmWorker) wasmWorker.terminate();

  wasmWorker = new Worker("./wasm-worker.js");

  wasmWorker.onmessage = ({ data: msg }) => {
    switch (msg.type) {

      // ── output from WASM (buffered by line inside worker) ─────────────────
      case "stdout":
        appendToPrint(msg.text);
        break;

      // ── worker is blocked on Atomics.wait, needs a line of stdin ──────────
      case "input-request": {
        termInput.disabled = true;

        const row = document.createElement("div");
        row.className = "term-line";
        row.innerHTML = `<span class="c-muted">stdin › </span><input class="term-stdin" type="text" autocomplete="off" spellcheck="false">`;
        termOutput.appendChild(row);
        termOutput.scrollTop = termOutput.scrollHeight;

        const field = row.querySelector(".term-stdin");
        field.focus();

        field.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          const value = field.value;
          row.innerHTML = `<span class="c-muted">stdin › </span><span class="c-ok">${esc(value)}</span>`;
          termInput.disabled = false;
          termInput.focus();

          if (controlSAB && dataSAB) {
            const encoded  = new TextEncoder().encode(value);
            const dataView = new Uint8Array(dataSAB);
            const ctrlView = new Int32Array(controlSAB);
            const len = Math.min(encoded.length, dataView.length);
            dataView.set(encoded.subarray(0, len));
            Atomics.store(ctrlView, 1, len);   // write byte length
            Atomics.store(ctrlView, 0, 1);     // signal ready
            Atomics.notify(ctrlView, 0);       // wake the waiting worker
          }
        });
        break;
      }

      // ── WebAssembly.compile + instantiate finished ─────────────────────────
      case "compiled":
        _workerResolve?.(msg);
        _workerResolve = _workerReject = null;
        break;

      // ── exported function returned ────────────────────────────────────────
      case "result":
        _workerResolve?.(msg);
        _workerResolve = _workerReject = null;
        break;

      // ── any error from the worker ─────────────────────────────────────────
      case "error":
        _workerReject?.(new Error(msg.message));
        _workerResolve = _workerReject = null;
        break;
    }
  };

  wasmWorker.onerror = (ev) => {
    _workerReject?.(new Error(ev.message ?? "worker error"));
    _workerResolve = _workerReject = null;
  };

  if (controlSAB && dataSAB) {
    wasmWorker.postMessage({ type: "init", controlSAB, dataSAB });
  }
}

/** Send a message to the worker and return a Promise that resolves on reply. */
function workerSend(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    _workerResolve = resolve;
    _workerReject  = reject;
    wasmWorker.postMessage(msg, transfer);
  });
}

/** Terminate and restart the worker (e.g. to abort an infinite loop). */
function killWorker() {
  _workerReject?.(new Error("worker terminated"));
  _workerResolve = _workerReject = null;
  lastFuncExports = null;
  termInput.disabled = false;
  document.querySelector(".term-stdin")?.closest(".term-line")?.remove();
  _spawnWorker();
  print(`<span class="c-warn">⚠ worker restarted — compiled module cleared</span>`);
  print("");
}

// ─── WABT (WAT decompiler) ───────────────────────────────────────────────────

let _wabt = null;

async function getWabt() {
  if (_wabt) return _wabt;
  print(`<span class="c-muted">loading wabt…</span>`);
  if (!window.WabtModule) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/wabt@1.0.35/index.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("failed to load wabt.js from unpkg"));
      document.head.appendChild(s);
    });
  }
  _wabt = await window.WabtModule();
  return _wabt;
}

// ─── Documentation panel ────────────────────────────────────────────────────

const DOC_FILES = ["language_1.md"];
const DISPLAY_NAMES = { "language_1.md": "Language reference" };
const docsCache = {};
let currentDoc = null;

function toggleDocsPanel() {
  const panel = document.getElementById("docsPanel");
  const btn   = document.getElementById("activityDocs");
  const open  = panel.classList.toggle("collapsed") === false;
  btn.classList.toggle("active", open);
  document.getElementById("resizeDocs").classList.toggle("hidden-handle", !open);
  if (open) showDocsList();
}

function showDocsList() {
  currentDoc = null;
  document.getElementById("docsBack").classList.remove("visible");
  document.getElementById("docsHeaderTitle").textContent = "Documentation";
  document.getElementById("docsViewer").classList.remove("visible");
  document.getElementById("docsFileList").style.display = "block";
  renderDocsList();
}

function renderDocsList() {
  const list = document.getElementById("docsFileList");
  list.innerHTML = DOC_FILES.map((name) => {
    const displayName = DISPLAY_NAMES[name] || name;
    return `
      <div class="docs-file-item${currentDoc === name ? " active" : ""}" data-doc="${esc(name)}">
          <span class="docs-file-icon">▸</span>
          <span class="docs-file-name">${esc(displayName)}</span>
      </div>`;
  }).join("");
  list.querySelectorAll(".docs-file-item").forEach((el) => {
    el.addEventListener("click", () => openDoc(el.dataset.doc));
  });
}

async function openDoc(name) {
  currentDoc = name;
  renderDocsList();
  document.getElementById("docsFileList").style.display = "none";
  document.getElementById("docsBack").classList.add("visible");
  document.getElementById("docsHeaderTitle").textContent = name;
  const viewer = document.getElementById("docsViewer");
  viewer.classList.add("visible");
  if (typeof docsCache[name] === "string") {
    viewer.innerHTML = renderMarkdown(docsCache[name]);
    return;
  }
  if (docsCache[name] instanceof Error) {
    showDocError(viewer, name, docsCache[name]);
    return;
  }
  viewer.innerHTML = `<p style="color:var(--text-muted);font-size:12px;font-family:-apple-system,'Segoe UI',sans-serif;">Loading…</p>`;
  try {
    const res  = await fetch(`docs/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    const text = await res.text();
    docsCache[name] = text;
    if (currentDoc === name) viewer.innerHTML = renderMarkdown(text);
  } catch (err) {
    docsCache[name] = err;
    if (currentDoc === name) showDocError(viewer, name, err);
  }
}

function showDocError(viewer, name, err) {
  viewer.innerHTML = `<p style="color:var(--red);font-size:12px;font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.6;">
        Failed to load <code style="font-size:11px;">${esc(name)}</code><br>
        <span style="color:var(--text-muted);">${esc(err.message)}</span></p>`;
}

function renderMarkdown(md) {
  if (!md) return "";
  md = md.replace(/\r\n/g, "\n");

  const codeBlocks = [];
  md = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    const placeholder = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(
      code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    );
    return placeholder;
  });

  md = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  md = md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,  "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,   "<h1>$1</h1>");

  md = md.replace(/^> (.+)$/gm, "<blockquote><p>$1</p></blockquote>");
  md = md.replace(/^---$/gm, "<hr>");
  md = md.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/\*(.+?)\*/g, "<em>$1</em>");
  md = md.replace(/`([^`]+)`/g, "<code>$1</code>");
  md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  md = md.replace(/(^- .+(?:\n- .+)*)/gm, (block) => {
    const items = block.trim().split("\n")
      .map((line) => `<li>${line.slice(2).trim()}</li>`).join("");
    return `<ul>${items}</ul>`;
  });

  md = md.replace(
    /(\|.+\|[ \t]*\n)(\|[-| :]+\|[ \t]*\n)((?:\|.+\|[ \t]*\n?)*)/g,
    (_, head, _sep, body) => {
      const th = head.trim().split("|").filter(Boolean)
        .map((c) => `<th>${c.trim()}</th>`).join("");
      const rows = body.trim().split("\n").filter(Boolean)
        .map((r) => "<tr>" + r.split("|").filter(Boolean)
          .map((c) => `<td>${c.trim()}</td>`).join("") + "</tr>").join("");
      return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  );

  md = md.split(/\n{2,}/).map((chunk) => {
    const t = chunk.trim();
    if (!t) return "";
    if (/^<(h[1-3]|ul|ol|pre|table|blockquote|hr|code)/i.test(t)) return t;
    if (/^@@CODE_BLOCK_\d+@@$/.test(t)) return t;
    return `<p>${t.replace(/\n/g, " ")}</p>`;
  }).join("\n");

  md = md.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, i) => {
    return `<pre><code>${codeBlocks[i].trimEnd()}</code></pre>`;
  });

  return md;
}

// ─── Programs panel ──────────────────────────────────────────────────────────

const PROG_SECTIONS = [
  {
    label: "Getting Started",
    files: [
      { id: "basics",      name: "Basic syntax demonstration" },
      { id: "hello_world", name: "Hello, World!" },
    ]
  },
  {
    label: "Simple programs",
    files: [
      { id: "fibonacci",  name: "Fibonacci" },
      { id: "pi_approx",  name: "Approximation for pi" },
    ]
  },
  {
    label: "Libraries",
    files: [
      { id: "system",  name: "System management" },
      { id: "stdio",   name: "Printing different types to standart output" },
    ]
  },
];

const progsCache = {};
let userProgs = [];
try { userProgs = JSON.parse(localStorage.getItem("wasm-user-progs") || "[]"); } catch {}

let activeProg      = null;
let progPanelInited = false;

function toggleProgPanel() {
  const panel    = document.getElementById("progPanel");
  const btn      = document.getElementById("activityProg");
  const collapsed = panel.classList.toggle("collapsed");
  btn.classList.toggle("active", !collapsed);
  document.getElementById("resizeProg").classList.toggle("hidden-handle", collapsed);
  if (!collapsed) {
    renderProgList();
    if (!progPanelInited && PROG_SECTIONS.some(s => s.files.length > 0)) {
      progPanelInited = true;
    }
  }
}

function renderProgList() {
  const list = document.getElementById("progFileList");
  if (!list) return;
  let html = "";

  for (const section of PROG_SECTIONS) {
    if (!section.files.length) continue;
    html += `<div class="prog-section-label">${esc(section.label)}</div>`;
    for (const file of section.files) {
      const active = activeProg && !activeProg.isUser && activeProg.name === file.id;
      html += `<div class="prog-file-item prog-admin${active ? " active" : ""}" data-name="${esc(file.id)}" data-user="0">
      <span class="prog-file-icon">★</span>
      <span class="prog-file-name">
        ${esc(file.name)}
        <span class="prog-file-id">${esc(file.id)}</span>
      </span>
    </div>`;
    }
  }
  
  if (userProgs.length > 0) {
    html += `<div class="prog-section-label">My Programs</div>`;
    html += userProgs.map((p, i) => {
      const active = activeProg && activeProg.isUser && activeProg.idx === i;
      return `<div class="prog-file-item${active ? " active" : ""}" data-name="${esc(p.name)}" data-user="1" data-idx="${i}">
        <span class="prog-file-icon">▸</span>
        <span class="prog-file-name">${esc(p.name)}</span>
        <button class="prog-del-btn" data-idx="${i}" title="Delete">✕</button>
      </div>`;
    }).join("");
  }
  
  const totalAdminFiles = PROG_SECTIONS.reduce((n, s) => n + s.files.length, 0);
  if (!totalAdminFiles && !userProgs.length) {
    html = `<div class="env-empty">No programs yet.<br>Click + to create one.</div>`;
  }

  // ── Versions of the active program (Bootstrap Chain Table) ──────────────
  if (currentProgName()) {
    const vs   = versions[activeProg.name] || [];
    const open = activeProg.verId;
    
    html += `<div class="prog-section-label">Bootstrap Chain — ${esc(activeProg.name)}</div>`;
    html += `<div class="prog-file-item ver-item${!open ? " active" : ""}" data-act="work">
      <span class="prog-file-icon">▸</span>
      <span class="prog-file-name">Working copy</span>
    </div>`;
    html += `<div class="prog-file-item ver-item" data-act="save">
      <span class="prog-file-icon">＋</span>
      <span class="prog-file-name">New version
        <span class="prog-file-id">forks the code in the editor</span></span>
    </div>`;

    if (vs.length > 0) {
      html += `
      <style>
        .chain-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
        .chain-table th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border, #444); color: var(--text-muted, #888); font-weight: normal; }
        .chain-table td { padding: 8px; border-bottom: 1px solid var(--border-light, #333); vertical-align: top; cursor: pointer; }
        .chain-table tr:hover { background: var(--bg-hover, #2a2a2a); }
        .chain-table tr.active td { background: var(--bg-active, #333); border-left: 2px solid var(--accent, #55f); }
        .chain-col-src { border-right: 1px solid var(--border-light, #333); width: 45%; }
        .chain-col-bin { width: 55%; position: relative; }
        .chain-meta { font-size: 11px; color: var(--text-muted, #888); margin-top: 4px; }
        .chain-compiler { color: var(--accent, #55f); }
        .chain-bin-actions { margin-top: 6px; display: flex; gap: 4px; }
      </style>
      <table class="chain-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Binary</th>
          </tr>
        </thead>
        <tbody>`;

      for (const v of vs) {
        const state = isStale(v)
          ? "⚠ STALE" + (v.error ? " — " + v.error : " — rebuilding…")
          : "✓ in sync";
          
        const isCompiler = activeCompilerId === "boot:" + v.id;

        html += `
          <tr class="ver-item${open === v.id ? " active" : ""}" data-act="load" data-id="${esc(v.id)}">
            <td class="chain-col-src">
              <strong style="color: var(--text, #eee)">v${v.n}</strong>${v.label ? " · " + esc(v.label) : ""}
              <div class="chain-meta">${esc(state)}</div>
            </td>
            <td class="chain-col-bin">
              <div>${v.size} B ${isCompiler ? '<span class="c-ok" style="font-size: 10px">(ACTIVE)</span>' : ''}</div>
              <div class="chain-meta">Built by: <span class="chain-compiler">${esc(v.compiler.label)}</span></div>
              <div class="chain-bin-actions">
                <button class="env-action-btn" data-act="inspect" data-id="${esc(v.id)}" title="View Source, Hex & WAT">🔍</button>
                <button class="env-action-btn" data-act="use" data-id="${esc(v.id)}" title="Use as compiler">⚙</button>
                <button class="env-action-btn" data-act="del" data-id="${esc(v.id)}" title="Delete">✕</button>
              </div>
            </td>
          </tr>`;
      }
      html += `</tbody></table>`;
    }
  }

  list.innerHTML = html;

  list.querySelectorAll(".prog-file-item:not(.ver-item)").forEach((el) => {
    el.addEventListener("click", async (e) => {
      if (e.target.classList.contains("prog-del-btn")) return;
      if (el.dataset.user === "1") loadUserProg(Number(el.dataset.idx));
      else await loadAdminProg(el.dataset.name);
      editor.refresh();
    });
  });
  list.querySelectorAll(".prog-del-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteUserProg(Number(btn.dataset.idx));
    });
  });
  list.querySelectorAll(".ver-item").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-act]");
      if (!t) return;
      const act = t.dataset.act, id = t.dataset.id;
      if (act === "inspect") {
        openFullscreenViewer(id);
      } else if (act === "save") {
        const label = window.prompt("Version label (optional)");
        if (label !== null) await saveVersion(label);
      } else if (act === "load") {
        const hit = findVersion(id);
        if (hit) openVersion(hit.ver);
      } else if (act === "work") {
        if (activeProg?.verId) closeVersion();
      } else if (act === "use") {
        await switchCompiler("boot:" + id);
      } else if (act === "del") {
        deleteVersion(id);
      }
    });
  });
}

function findAdminFile(id) {
  for (const section of PROG_SECTIONS) {
    const file = section.files.find(f => f.id === id);
    if (file) return file;
  }
  return null;
}

async function loadAdminProg(id) {
  autoSaveCurrentProg();
  editingEnvFile = false;
  activeProg = { name: id, isUser: false };
  renderProgList();
  renderEnvList();
  if (typeof progsCache[id] === "string") {
    document.getElementById("code").value = progsCache[id];
    updateLineNumbers();
    const file = findAdminFile(id);
    print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(file ? file.name : id)}</span>`);
    return;
  }
  print(`<span class="c-muted">loading…</span>`);
  try {
    const res  = await fetch(`programs/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    const text = await res.text();
    progsCache[id] = text;
    if (activeProg && activeProg.name === id && !activeProg.isUser) {
      document.getElementById("code").value = text;
      updateLineNumbers();
    }
    const file = findAdminFile(id);
    print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(file ? file.name : id)}</span>`);
  } catch (err) {
    print(`<span class="c-err">✗ failed to load ${esc(id)}: ${esc(err.message)}</span>`);
  }
}

function loadUserProg(idx) {
  autoSaveCurrentProg();
  editingEnvFile = false;
  activeProg = { isUser: true, idx, name: userProgs[idx].name };
  renderProgList();
  renderEnvList();
  document.getElementById("code").value = userProgs[idx].code;
  updateLineNumbers();
  print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(userProgs[idx].name)}</span>`);
  print("");
}

function autoSaveCurrentProg() {
  if (editingEnvFile) {
    envFileCode = document.getElementById("code").value;
    try { localStorage.setItem("wasm-env-js", envFileCode); } catch {}
    return;
  }
  const bound = boundVersion();
  if (bound) { bound.code = document.getElementById("code").value; persistVersions(); return; }
  if (!activeProg || !activeProg.isUser) return;
  if (activeProg.idx >= userProgs.length) return;
  userProgs[activeProg.idx].code = document.getElementById("code").value;
  editor.refresh();
  try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
}

function deleteUserProg(idx) {
  const name = userProgs[idx].name;
  userProgs.splice(idx, 1);
  try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  if (activeProg && activeProg.isUser) {
    if (activeProg.idx === idx) {
      activeProg = null;
      document.getElementById("code").value = "";
      updateLineNumbers();
    } else if (activeProg.idx > idx) {
      activeProg.idx--;
    }
  }
  renderProgList();
  print(`<span class="c-muted">deleted: </span><span class="c-warn">${esc(name)}</span>`);
  print("");
}

function openProgNewForm() {
  document.getElementById("progNewForm").classList.remove("hidden");
  document.getElementById("progNewName").value = "";
  document.getElementById("progNewName").focus();
}

function closeProgNewForm() {
  document.getElementById("progNewForm").classList.add("hidden");
}

function createNewProg() {
  let name = document.getElementById("progNewName").value.trim();
  if (!name) { document.getElementById("progNewName").focus(); return; }
  autoSaveCurrentProg();
  editingEnvFile = false;
  userProgs.push({ name, code: "" });
  try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  const idx  = userProgs.length - 1;
  activeProg = { isUser: true, idx, name };
  document.getElementById("code").value = "";
  updateLineNumbers();
  closeProgNewForm();
  renderProgList();
  renderEnvList();
  print(`<span class="c-muted">created: </span><span class="c-ok">${esc(name)}</span>`);
  print("");
}

// ─── Program versions (new / open / sync / delete) ──────────────────────────
//
// A version is a file of its own: opening it binds the editor to it, so edits go
// straight into that version (no need to create another program) and its binary
// is rebuilt automatically. A binary is never trusted unless its `hash` matches
// the current code (see isStale / syncVersion).

/** Name under which versions are filed: user prog name or admin prog id. */
function currentProgName() {
  return !editingEnvFile && activeProg ? activeProg.name : null;
}

/** The version currently open in the editor (edits go into it), or null. */
function boundVersion() {
  if (!activeProg?.verId) return null;
  const hit = findVersion(activeProg.verId);
  if (!hit) { delete activeProg.verId; return null; }
  return hit.ver;
}

/** Fork the code in the editor into a new version, compile it, and keep editing that. */
async function saveVersion(label = "") {
  const name = currentProgName();
  if (!name) { print(`<span class="c-warn">⚠ open or create a program first</span>`); return; }

  const code = document.getElementById("code").value;
  if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }

  print(`<span class="c-muted">compiling with ${esc(compilerLabel(activeCompilerId))}…</span>`);
  try {
    const libs   = await gatherLibs(code);
    const binary = await compile(code, libs);
    if (!binary) throw new Error("compile() returned null");

    const list = (versions[name] ??= []);
    const n = list.reduce((m, v) => Math.max(m, v.n), 0) + 1;
    const ver = {
      id:     Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      n,
      ts:     Date.now(),
      label:  label.trim(),
      code,
      binary: toB64(binary),
      size:   binary.length,
      hash:   hashCode(code),
      compiler: { id: activeCompilerId, label: compilerLabel(activeCompilerId) },
    };
    list.push(ver);
    if (!persistVersions()) { list.pop(); return; }

    activeProg.verId = ver.id;     // from now on the editor edits this version
    const now = document.getElementById("code").value;
    if (now !== code) { ver.code = now; scheduleVersionSync(ver.id); }   // typed during compile

    print(`<span class="c-ok">✓ saved ${esc(name)} v${n}</span><span class="c-muted"> · ${binary.length} B · built by ${esc(compilerLabel(activeCompilerId))} · now editing it</span>`);
    renderProgList();
    renderSourcesPanel();
  } catch (err) {
    print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
  }
  print("");
}

/** Open a saved version in the editor; further edits modify it in place. */
function openVersion(ver) {
  autoSaveCurrentProg();            // flush the working copy / the version open so far
  activeProg.verId = ver.id;
  document.getElementById("code").value = ver.code;
  updateLineNumbers();
  editor?.refresh?.();
  renderProgList();
  print(`<span class="c-muted">editing: </span><span class="c-ok">${esc(activeProg.name)} v${ver.n}</span>`);
  print("");
}

/** Put the program's own (non-versioned) code back into the editor. */
function loadWorkingCopy() {
  delete activeProg.verId;
  const code = activeProg.isUser
    ? (userProgs[activeProg.idx]?.code ?? "")
    : (progsCache[activeProg.name] ?? "");
  document.getElementById("code").value = code;
  updateLineNumbers();
  editor?.refresh?.();
}

function closeVersion() {
  autoSaveCurrentProg();
  loadWorkingCopy();
  renderProgList();
  print(`<span class="c-muted">back to the working copy</span>`);
  print("");
}

function deleteVersion(id) {
  const hit = findVersion(id);
  if (!hit) return;
  clearTimeout(verTimers.get(id));
  verTimers.delete(id);
  if (activeProg?.verId === id) loadWorkingCopy();
  versions[hit.prog] = versions[hit.prog].filter(v => v.id !== id);
  if (!versions[hit.prog].length) delete versions[hit.prog];
  persistVersions();
  renderProgList();
  renderSourcesPanel();
  print(`<span class="c-muted">deleted: </span><span class="c-warn">${esc(hit.prog)} v${hit.ver.n}</span>`);
  if (activeCompilerId === "boot:" + id)
    print(`<span class="c-warn">⚠ it is the active compiler: still loaded, but will fall back to ${esc(COMPILER_SOURCES[0].label)} on reload</span>`);
  print("");
}

// ─── Env imports (env.js virtual file) ──────────────────────────────────────

const DEFAULT_ENV_CODE = `// Define your WASM host environment functions here.
// Add a '// (type)(type) => (type)' or '/** @type {(type)(type) => (type)} */'
// comment above any function to specify custom WASM types
// (int32, int64, float32, float64, empty).
// If omitted, parameters default to (int32) and return type defaults to (int32).

export default {
  // (int32) => (int32)
  putchar(c) {
    // static function that cannot be modified
    // prints a single character to stdout, then returns the character code
  },

  // (int32)(int32) => (int32)
  readline(addr, maxLen) {
    // static function that cannot be modified
    // reads a line of input from stdin, writes it to memory at addr,
    // and returns the number of bytes written (not including null terminator)
  },

  // (int32) => (int32)
  get_code(addr) {
    // static function that cannot be modified
    // writes the full source code (UTF-8, null-terminated) to memory at addr,
    // and returns the number of bytes written (not including null terminator)
  },

  // (int32)(int32) => (int32)
  pow(a, b) {
    return Math.pow(a, b) | 0;
  },

  // (int32) => (int32)
  log(a) {
    console.log(a);
    return a;
  },

  // (int32) => (int32)
  sleep(a) {
    const target = Date.now() + a;
    // Fall back to a standard while-loop if controlSAB is missing
    if (typeof controlSAB === "undefined") {
      while (Date.now() < target) {} 
      return 0;
    }
    const ctrl = new Int32Array(controlSAB);
    while (Date.now() < target) {
      Atomics.wait(ctrl, 0, 1, 10);
    }
    return 0;
  }
};
`;

let envFileCode = localStorage.getItem("wasm-env-js") ?? DEFAULT_ENV_CODE;
let editingEnvFile = false;

function toggleEnvPanel() {
  const panel    = document.getElementById("sidePanel");
  const btn      = document.getElementById("activityEnv");
  const collapsed = panel.classList.toggle("collapsed");
  btn.classList.toggle("active", !collapsed);
  document.getElementById("resizeEnv").classList.toggle("hidden-handle", collapsed);
  if (!collapsed) renderEnvList();
}

function openEnvFileInEditor() {
  autoSaveCurrentProg();
  activeProg = null;
  editingEnvFile = true;
  renderProgList();
  renderEnvList();

  document.getElementById("code").value = envFileCode;
  updateLineNumbers();
  if (editor?.refresh) editor.refresh();

  print(`<span class="c-muted">opened: </span><span class="c-ok">env.js</span>`);
  print("");
}

function resetEnvFile() {
  envFileCode = DEFAULT_ENV_CODE;
  try { localStorage.removeItem("wasm-env-js"); } catch {}

  if (editingEnvFile) {
    document.getElementById("code").value = envFileCode;
    updateLineNumbers();
    if (editor?.refresh) editor.refresh();
  }

  renderEnvList();
  print(`<span class="c-muted">env.js reset to defaults</span>`);
  print("");
}

function parseEnvImports() {
  const cleanCode = envFileCode.replace(/^\s*export\s+default\s+/m, "return ");
  let envObj;
  try {
    envObj = new Function(cleanCode)();
  } catch (err) {
    throw new Error(`env.js syntax error: ${err.message}`);
  }

  if (!envObj || typeof envObj !== "object") {
    throw new Error("env.js must export an object of functions");
  }

  // Mask comments with spaces of identical length so indices match envFileCode 1:1
  // without false-matching `{` or `,` inside comments.
  const maskedCode = envFileCode.replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    (m) => " ".repeat(m.length)
  );

  // Maps compiler type names to standard WASM type names for the worker/UI
  const normalizeType = (t) => {
    switch (t.trim()) {
      case "int32":   case "i32": return "i32";
      case "int64":   case "i64": return "i64";
      case "float32": case "f32": return "f32";
      case "float64": case "f64": return "f64";
      case "empty":   case "void": return "void";
      default:
        throw new Error(`env.js: unknown type '${t.trim()}'`);
    }
  };

  // Extracts all parenthesized types like "(int32)(float64)" -> ["i32", "f64"]
  const extractCompilerTypes = (typeStr) => {
    if (!typeStr || !typeStr.trim()) return [];
    const matches = [...typeStr.matchAll(/\(([^)]+)\)/g)];
    if (matches.length > 0) {
      return matches
        .flatMap(m => m[1].split(","))
        .map(normalizeType)
        .filter(t => t !== "void");
    }
    const single = normalizeType(typeStr);
    return single === "void" ? [] : [single];
  };

  const imports = Object.entries(envObj).map(([name, fn]) => {
    if (typeof fn !== "function") {
      throw new Error(`env.js: "${name}" must be a function`);
    }

    const src = fn.toString();
    const paramMatch = src.match(/^[^(]*\(([^)]*)\)/);
    const params = paramMatch
      ? paramMatch[1].split(",").map(p => p.trim()).filter(Boolean)
      : [];

    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match method shorthand `foo(...) {` or property syntax `foo: (...) =>` / `foo: function(...)`
    const declRegex = new RegExp(
      `(?:^|[,{\\s])(?:async\\s+)?${escapedName}\\s*(?:\\([^)]*\\)\\s*\\{|:\\s*(?:async\\s+)?(?:function\\s*)?\\([^)]*\\))`,
      "m"
    );
    const fnDeclMatch = declRegex.exec(maskedCode);

    let typeMatch = null;
    if (fnDeclMatch) {
      const beforeMasked = maskedCode.slice(0, fnDeclMatch.index + 1);
      const lastBoundary = Math.max(
        beforeMasked.lastIndexOf(","),
        beforeMasked.lastIndexOf("{")
      );

      const leadingTrivia = envFileCode.slice(lastBoundary + 1, fnDeclMatch.index);

      // Matches `// (int32)(int32) => (int32)` or `/** @type {(int32)(int32) => (int32)} */`
      // Also supports `=> (empty)` or `=> empty` for void return
      const typeRegex =
        /\/\*\*[\s\S]*?@type\s*\{\s*((?:\([^)]*\)\s*)*)=>\s*(\([^)]+\)|[a-z0-9_]+)\s*\}[\s\S]*?\*\/|\/\/\s*(?:@type\s*)?((?:\([^)]*\)\s*)*)=>\s*(\([^)]+\)|[a-z0-9_]+)/g;

      const matches = [...leadingTrivia.matchAll(typeRegex)];
      if (matches.length > 0) {
        typeMatch = matches[matches.length - 1];
      }
    }

    let sig;
    if (typeMatch) {
      const rawArgs = typeMatch[1] !== undefined ? typeMatch[1] : (typeMatch[3] || "");
      const rawRet  = typeMatch[2] !== undefined ? typeMatch[2] : (typeMatch[4] || "(empty)");

      const argTypes = extractCompilerTypes(rawArgs).join(" ");
      const retTypes = extractCompilerTypes(rawRet);
      const retStr   = retTypes.length ? retTypes.join(" ") : "void";

      sig = `${argTypes} => ${retStr}`.trim();
    } else {
      // Fallback: assume all params and return type are i32 (int32)
      sig = `${params.map(() => "i32").join(" ")} => i32`.trim();
    }

    const bodyStart = src.indexOf("{");
    let body = bodyStart !== -1
      ? src.slice(bodyStart + 1, src.lastIndexOf("}")).trim()
      : `return (${src.slice(src.indexOf("=>") + 2).trim()});`;

    const stdNames = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const aliases = params
      .map((p, i) => (stdNames[i] && p !== stdNames[i] ? `const ${p} = ${stdNames[i]};` : ""))
      .filter(Boolean)
      .join(" ");

    return {
      name,
      sig,
      body: aliases ? `${aliases}\n${body}` : body
    };
  });

  // get_code is a worker built-in; make sure it is always declared, even if the
  // user's saved env.js predates it.
  if (!imports.some(i => i.name === "get_code"))
    imports.push({ name: "get_code", sig: "i32 => i32", body: "" });

  return imports;
}

function renderEnvList() {
  const list = document.getElementById("envList");
  if (!list) return;

  let parsed = [];
  let parseErr = null;
  try {
    parsed = parseEnvImports();
  } catch (err) {
    parseErr = err.message;
  }

  let html = `
    <div class="prog-file-item${editingEnvFile ? " active" : ""}" id="openEnvJsBtn">
      <span class="prog-file-icon">⚙</span>
      <span class="prog-file-name">
        env.js
        <span class="prog-file-id">Host environment</span>
      </span>
      <button class="env-action-btn" id="resetEnvJsBtn" title="Reset env.js to default">↺</button>
    </div>
  `;

  if (parseErr) {
    html += `<div class="env-empty" style="color:var(--red);">${esc(parseErr)}</div>`;
  } else if (!parsed.length) {
    html += `<div class="env-empty">No functions declared in env.js</div>`;
  } else {
    html += `<div class="prog-section-label">Active Imports (${parsed.length})</div>`;
    html += parsed.map(e => `
      <div class="env-item">
        <div class="env-item-name">${esc(e.name)}</div>
        <div class="env-item-sig">${esc(e.sig)}</div>
      </div>
    `).join("");
  }

  list.innerHTML = html;
  document.getElementById("openEnvJsBtn")?.addEventListener("click", (e) => {
    if (e.target.closest("#resetEnvJsBtn")) return;
    openEnvFileInEditor();
  });
  document.getElementById("resetEnvJsBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    resetEnvFile();
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.getElementById("activityEnv").addEventListener("click",     toggleEnvPanel);
document.getElementById("activityDocs").addEventListener("click",    toggleDocsPanel);
document.getElementById("activityProg").addEventListener("click",    toggleProgPanel);
document.getElementById("activitySources").addEventListener("click", toggleSourcesPanel);

document.getElementById("docsBack").addEventListener("click", showDocsList);

document.getElementById("progAddBtn").addEventListener("click",    openProgNewForm);
document.getElementById("progNewCancel").addEventListener("click", closeProgNewForm);
document.getElementById("progNewSave").addEventListener("click",   createNewProg);
document.getElementById("progNewName").addEventListener("keydown", (e) => {
  if (e.key === "Enter")  createNewProg();
  if (e.key === "Escape") closeProgNewForm();
});

document.getElementById("code").addEventListener("input", () => {
  const val = document.getElementById("code").value;

  if (editingEnvFile) {
    envFileCode = val;
    try { localStorage.setItem("wasm-env-js", envFileCode); } catch {}
    renderEnvList();
    return;
  }

  const bound = boundVersion();
  if (bound) {
    const wasStale = isStale(bound);
    bound.code = val;
    if (!wasStale && isStale(bound)) renderProgList();   // show STALE right away
    scheduleVersionSync(bound.id);                        // rebuild the binary shortly
    return;
  }

  if (activeProg && activeProg.isUser) {
    userProgs[activeProg.idx].code = val;
    try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  }
});


// ─── Terminal ────────────────────────────────────────────────────────────────

const termOutput = document.getElementById("termOutput");
const termInput  = document.getElementById("termInput");
let cmdHistory = [], histIdx = -1;

// lastBinary  — kept on main thread for the `hex` and `wat` commands
// lastFuncExports — function-export names reported by the worker after compile
let lastBinary      = null;
let lastMeta        = {};
let lastFuncExports = null;   // null means no compiled module in worker

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function print(html) {
  const d = document.createElement("div");
  d.className = "term-line";
  d.innerHTML = html;
  termOutput.appendChild(d);
  termOutput.scrollTop = termOutput.scrollHeight;
}

function appendToPrint(text) {
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (index === 0) {
      const last = termOutput.lastElementChild;
      if (last) last.innerHTML += part;
      else print(part);
    } else {
      print(part);
    }
  });
}

async function gatherLibs(code) {
  const libs = {};
  for (const line of code.split("\n")) {
    const m = line.match(/^\s*#include\s+<([^>]+)>\s*(?:\/\/.*)?$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name in libs) continue;
    const userProg = userProgs.find(p => p.name === name);
    if (userProg) {
      libs[name] = userProg.code;
    } else if (findAdminFile(name)) {
      if (typeof progsCache[name] !== "string") {
        const res = await fetch(`programs/${name}`);
        if (!res.ok) throw new Error(`include <${name}>: HTTP ${res.status}`);
        progsCache[name] = await res.text();
      }
      libs[name] = progsCache[name];
    } else {
      throw new Error(`include <${name}>: not found`);
    }
  }
  return libs;
}

// ─── Terminal Commands ───────────────────────────────────────────────────────

/** Helper to resolve a version number or compiler ID to a Uint8Array binary */
function getBinaryArg(arg) {
  if (!arg) return lastBinary;
  let ver = null;
  if (arg.startsWith("boot:")) {
    const hit = findVersion(arg.slice(5));
    if (hit) ver = hit.ver;
  } else {
    // Treat as version number for the current program
    ver = (versions[currentProgName()] || []).find(v => v.n === Number(arg));
  }
  return (ver && ver.binary) ? fromB64(ver.binary) : null;
}

async function runCommand(raw, isInternal = false) {
  const cmd = raw.trim();
  if (!cmd) return;

  if (!isInternal) {
    cmdHistory.unshift(cmd);
    histIdx = -1;
    print(`<span class="c-prompt">$ </span>${esc(cmd)}`);
  }

  const parts = cmd.split(/\s+/), verb = parts[0].toLowerCase();

  // ── help ───────────────────────────────────────────────────────────────────
  if (verb === "help") {
    print(`<span class="c-muted">  compile         — compile only</span>`);
    print(`<span class="c-muted">  run fn [args]   — call exported function</span>`);
    print(`<span class="c-muted">  boot [args]     — compile &amp; run "main" with given args</span>`);
    print(`<span class="c-muted">  make [args]     — compile &amp; run all exports</span>`);
    print(`<span class="c-muted">  save [label]    — fork the editor code into a new version (and edit it)</span>`);
    print(`<span class="c-muted">  versions        — list saved versions of this program</span>`);
    print(`<span class="c-muted">  open &lt;n&gt;       — edit version n in place (binary rebuilds automatically)</span>`);
    print(`<span class="c-muted">  close           — back to the program's working copy</span>`);
    print(`<span class="c-muted">  compiler [n|id] — show / switch compiler (version n, or e.g. lang_2)</span>`);
    print(`<span class="c-muted">  hex [n|id]      — full hex dump of last compiled binary or specific version</span>`);
    print(`<span class="c-muted">  wat [n|id]      — disassemble binary to WebAssembly Text Format</span>`);
    print(`<span class="c-muted">  resetenv        — reset env.js to defaults</span>`);
    print(`<span class="c-muted">  kill            — terminate worker (stops infinite loops)</span>`);
    print(`<span class="c-muted">  clear           — clear terminal</span>`);
  }

  // ── clear ──────────────────────────────────────────────────────────────────
  else if (verb === "clear") {
    termOutput.innerHTML = "";
  }

  // ── resetenv: restore default env.js ───────────────────────────────────────
  else if (verb === "resetenv") {
    resetEnvFile();
  }

  // ── kill: abort a hung worker ──────────────────────────────────────────────
  else if (verb === "kill") {
    killWorker();
  }

  // ── save: compile + store a version ────────────────────────────────────────
  else if (verb === "save") {
    await saveVersion(parts.slice(1).join(" "));
    return;
  }

  // ── versions: list saved versions ──────────────────────────────────────────
  else if (verb === "versions") {
    const vs = versions[currentProgName()] || [];
    if (!vs.length) print(`<span class="c-muted">no saved versions</span>`);
    for (const v of vs)
      print(`<span class="c-muted">  v${v.n}${activeProg?.verId === v.id ? "*" : ""}</span> ${esc(v.label)} <span class="c-muted">· ${isStale(v) ? "STALE" : "in sync"} · built by ${esc(v.compiler.label)} · ${v.size} B</span>`);
  }

  // ── open: edit a saved version in place ───────────────────────────────────
  else if (verb === "open") {
    const ver = (versions[currentProgName()] || []).find(v => v.n === Number(parts[1]));
    if (ver) openVersion(ver);
    else print(`<span class="c-err">✗ no such version</span>`);
  }

  // ── close: back to the program's working copy ─────────────────────────────
  else if (verb === "close") {
    if (boundVersion()) closeVersion();
    else print(`<span class="c-muted">no version open</span>`);
  }

  // ── compiler: show / switch the active compiler ───────────────────────────
  else if (verb === "compiler") {
    const arg = parts[1];
    if (!arg) {
      print(`<span class="c-muted">active compiler: </span><span class="c-ok">${esc(compilerLabel(activeCompilerId))}</span>`);
    } else {
      const ver = (versions[currentProgName()] || []).find(v => v.n === Number(arg));
      const id  = ver ? "boot:" + ver.id : arg;
      if (allCompilerSources().some(s => s.id === id)) { await switchCompiler(id); return; }
      print(`<span class="c-err">✗ unknown compiler "${esc(arg)}"</span>`);
    }
  }

  // ── compile ────────────────────────────────────────────────────────────────
  else if (verb === "compile") {
    if (editingEnvFile) {
      print(`<span class="c-warn">⚠ env.js is currently open — select a program to compile</span>`);
      return;
    }

    const code = document.getElementById("code").value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }

    print(`<span class="c-muted">compiling…</span>`);

    try {
      const libs   = await gatherLibs(code);
      const binary = await compile(code, libs);
      if (!binary) throw new Error("compile() returned null");

      lastBinary      = binary;
      lastMeta        = binary.meta || {};
      lastFuncExports = null;

      print(`<span class="c-ok">✓ ${binary.length} bytes</span>`);
      let hex = "";
      const lim = Math.min(binary.length, 48);
      for (let i = 0; i < lim; i++)
        hex += binary[i].toString(16).padStart(2, "0").toUpperCase() + " ";
      if (binary.length > 48)
        hex += `<span class="c-muted">… +${binary.length - 48}</span>`;
      print(`<span class="c-hex">${hex}</span>`);

      const parsedEnvImports = parseEnvImports();
      const result = await workerSend({
        type:       "compile",
        binary:     binary,
        envImports: parsedEnvImports,
        code:       code,
      });

      lastFuncExports = result.funcExports;
      print(`<span class="c-muted">exports: </span><span class="c-ok">${result.allExports.map(esc).join(", ")}</span>`);

    } catch (err) {
      lastFuncExports = null;
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  // ── make: compile then run every exported function ─────────────────────────
  else if (verb === "make") {
    await runCommand("compile", true);
    print("");
    if (!lastFuncExports) return;

    const supplied = parts.slice(1).map(Number);
    for (const fn of lastFuncExports) {
      const needed   = lastMeta[fn] ?? supplied.length;
      const testArgs = Array.from({ length: needed }, (_, i) =>
        i < supplied.length ? supplied[i] : 0
      );
      await runCommand(`run ${fn} ${testArgs.join(" ")}`, true);
    }
  }

  // ── run: call a specific exported function ─────────────────────────────────
  else if (verb === "run") {
    if (!lastFuncExports) { print(`<span class="c-warn">⚠ run build/make first</span>`); return; }

    const fn   = parts[1];
    const args = parts.slice(2).map(Number);
    if (!fn) { print(`<span class="c-err">usage: run &lt;fn&gt; [args]</span>`); return; }

    if (!lastFuncExports.includes(fn)) {
      print(`<span class="c-err">✗ no export "${esc(fn)}"</span>`);
      return;
    }

    try {
      print(`<span class="c-muted">Running function ${esc(fn)}(${args.join(", ")})</span>`);
      print("");
      const result = await workerSend({ type: "run", fn, args });
      print(`<span class="c-muted">  ${esc(fn)}(${args.join(", ")}) → </span><span class="c-ok">${result.result}</span>`);
    } catch (err) {
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  // ── boot: compile then run main() ─────────────────────────────────────────
  else if (verb === "boot") {
    await runCommand("compile", true);
    print("");
    if (!lastFuncExports) return;

    if (!lastFuncExports.includes("main")) {
      print(`No "main" function found`);
      return;
    }

    const supplied = parts.slice(1).map(Number);
    const needed   = lastMeta["main"] ?? supplied.length;
    const testArgs = Array.from({ length: needed }, (_, i) =>
      i < supplied.length ? supplied[i] : 0
    );
    await runCommand(`run main ${testArgs.join(" ")}`, true);
  }

  // ── hex: dump binary (last compiled, or specified version/compiler) ──────
  else if (verb === "hex") {
    const bin = getBinaryArg(parts[1]);
    if (!bin) { 
      print(`<span class="c-warn">⚠ no binary available (run compile first or specify a valid version/compiler id)</span>`); 
      return; 
    }
    let row = "";
    for (let i = 0; i < bin.length; i++)
      row += bin[i].toString(16).padStart(2, "0").toUpperCase() + " ";
    if (row) print(`<span class="c-hex">${row}</span>`);
  }

  // ── wat: disassemble binary (last compiled, or specified version/compiler) ─
  else if (verb === "wat") {
    const bin = getBinaryArg(parts[1]);
    if (!bin) { 
      print(`<span class="c-warn">⚠ no binary available (run compile first or specify a valid version/compiler id)</span>`); 
      return; 
    }
    try {
      const wabt   = await getWabt();
      const module = wabt.readWasm(bin, { readDebugNames: true });
      module.generateNames();
      module.applyNames();
      const text = module.toText({ foldExprs: false, inlineExport: true });
      module.destroy();
      for (const line of text.split("\n"))
        print(`<span class="c-hex">${esc(line)}</span>`);
    } catch (err) {
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  else {
    print(`<span class="c-err">✗ unknown command: ${esc(verb)}</span>`);
  }

  if (!isInternal) print("");
}

termInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = termInput.value;
    termInput.value = "";
    runCommand(v);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (histIdx < cmdHistory.length - 1) { histIdx++; termInput.value = cmdHistory[histIdx]; }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx > 0) { histIdx--; termInput.value = cmdHistory[histIdx]; }
    else { histIdx = -1; termInput.value = ""; }
  }
});

document.getElementById("panel").addEventListener("click", () => termInput.focus());



// ─── Line numbers & minimap ───────────────────────────────────────────────────

const codeEl     = document.getElementById("code");
const lineNums   = document.getElementById("lineNumbers");
const editorWrap = document.getElementById("editorWrap");

// Ctrl/Cmd+Enter: compile & run
codeEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runCommand("make");
    termInput.focus();
  }
});


function getCursorLine() {
  return codeEl.value.substring(0, codeEl.selectionStart).split("\n").length;
}

function updateLineNumbers() {
  const lines = codeEl.value.split("\n");
  const cur   = getCursorLine();
  let html    = "";
  for (let i = 1; i <= lines.length; i++)
    html += `<span class="line-number${i === cur ? " active" : ""}">${i}</span>`;
  lineNums.innerHTML = html;
  lineNums.scrollTop = editorWrap.scrollTop;
  updateMinimap();
}

editorWrap.addEventListener("scroll", () => {
  lineNums.scrollTop = editorWrap.scrollTop;
  updateMinimap();
});
codeEl.addEventListener("input",  updateLineNumbers);
codeEl.addEventListener("keyup",  updateLineNumbers);
codeEl.addEventListener("click",  updateLineNumbers);
codeEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s   = codeEl.selectionStart, end = codeEl.selectionEnd;
    codeEl.value = codeEl.value.substring(0, s) + "    " + codeEl.value.substring(end);
    codeEl.selectionStart = codeEl.selectionEnd = s + 4;
    updateLineNumbers();
  }
});

const minimapCanvas    = document.getElementById("minimapCanvas");
const minimapViewport  = document.getElementById("minimapViewport");
const minimapContainer = document.getElementById("minimapContainer");
const LINE_PX = 2, LINE_GAP = 1, LINE_STRIDE = LINE_PX + LINE_GAP;

function updateMinimap() {
  const lines  = codeEl.value.split("\n");
  const W      = minimapContainer.offsetWidth;
  const totalH = lines.length * LINE_STRIDE;
  minimapCanvas.width        = W;
  minimapCanvas.height       = totalH;
  minimapCanvas.style.width  = W + "px";
  minimapCanvas.style.height = totalH + "px";
  const ctx = minimapCanvas.getContext("2d");
  ctx.clearRect(0, 0, W, totalH);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const alpha = Math.min(0.7, 0.2 + line.trim().length * 0.015);
    ctx.fillStyle = `rgba(212,212,212,${alpha})`;
    ctx.fillRect(2, i * LINE_STRIDE, Math.min(W - 4, line.length * 1.4), LINE_PX);
  });
  const containerH = minimapContainer.offsetHeight;
  const editorH    = editorWrap.offsetHeight;
  const contentH   = codeEl.scrollHeight || editorH;
  const vpH        = Math.max(6, Math.round(totalH * Math.min(1, editorH / contentH)));
  const cursorY    = (getCursorLine() - 1) * LINE_STRIDE;
  let offsetTop    = Math.max(0, Math.min(totalH - containerH, cursorY - containerH / 2));
  minimapCanvas.style.top   = -offsetTop + "px";
  const scrollRatio = contentH > editorH ? editorWrap.scrollTop / (contentH - editorH) : 0;
  minimapViewport.style.top    = scrollRatio * (totalH - vpH) - offsetTop + "px";
  minimapViewport.style.height = vpH + "px";
}

window.addEventListener("resize", updateMinimap);
setTimeout(updateMinimap, 50);

// ─── Fullscreen Viewer ────────────────────────────────────────────────────────

document.getElementById("viewerClose")?.addEventListener("click", () => {
  document.getElementById("viewerModal").classList.add("hidden");
});

async function openFullscreenViewer(verId) {
  const hit = findVersion(verId);
  if (!hit) {
    print(`<span class="c-err">✗ version not found for viewer</span>`);
    return;
  }
  
  const binary = fromB64(hit.ver.binary);
  const source = hit.ver.code;
  
  // Format Hex (16 bytes per line)
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += binary[i].toString(16).padStart(2, "0").toUpperCase() + " ";
    if ((i + 1) % 16 === 0) hex += "\n";
  }
  
  // Show modal immediately while WAT builds
  document.getElementById("viewerTitle").textContent = `${hit.prog} v${hit.ver.n} — Built by ${hit.ver.compiler.label} — ${binary.length} Bytes`;
  document.getElementById("viewerSource").textContent = source;
  document.getElementById("viewerHex").textContent = hex.trim();
  document.getElementById("viewerWat").textContent = "Decompiling..."; 
  document.getElementById("viewerModal").classList.remove("hidden");

  try {
    const wabt = await getWabt();
    const module = wabt.readWasm(binary, { readDebugNames: true });
    module.generateNames();
    module.applyNames();
    const wat = module.toText({ foldExprs: false, inlineExport: true });
    module.destroy();
    document.getElementById("viewerWat").textContent = wat;
  } catch (err) {
    document.getElementById("viewerWat").textContent = "Error generating WAT:\n" + err.message;
  }
}