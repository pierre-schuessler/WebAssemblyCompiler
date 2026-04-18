import { compile, test } from "./compiler.js";
import { initEditor } from "./editor.js";

const editor = initEditor(
  document.getElementById("code"),
  document.getElementById("editorWrap")
);

// ── Worker source (embedded as blob so no extra file needed) ─────────────────
// The WASM runs inside this worker. When readline/getchar is called the worker
// blocks with Atomics.wait(); the main thread fills the SharedArrayBuffer and
// calls Atomics.notify() once the user has pressed Enter.
//
// SAB layout:
//   Bytes 0-3   Int32  signal   0 = worker waiting  1 = data ready
//   Bytes 4-7   Int32  dataLen  byte length of line in databuf
//   Bytes 8+    Uint8  databuf  UTF-8 bytes of the input line
const WORKER_SRC = `
"use strict";

let wasmInstance = null;
self.lastInstance = null;

let sabSignal = null;   // Int32Array view of SAB (indices 0 and 1)
let sabData   = null;   // Uint8Array  view of SAB starting at byte 8

self.console = {
  stdout: (text) => self.postMessage({ type: "stdout", text }),
  log:    (...a) => self.postMessage({ type: "stdout", text: a.join(" ") }),
};

function stdinReadLine() {
  // Tell the main thread we need a line
  self.postMessage({ type: "stdin_request" });
  // Block until main sets signal[0] = 1
  Atomics.wait(sabSignal, 0, 0);
  // Read the line out of the shared buffer
  const len  = sabSignal[1];
  const line = new TextDecoder().decode(sabData.subarray(0, len));
  // Reset for next call
  Atomics.store(sabSignal, 0, 0);
  return line;
}

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === "init") {
    sabSignal = new Int32Array(msg.sab);
    sabData   = new Uint8Array(msg.sab, 8);

    const binary   = new Uint8Array(msg.binary);
    const envDefs  = msg.envDefs;
    const argNames = ["a","b","c","d","e","f","g","h"];

    const env = {};

    env.readline = (addr, maxLen) => {
      const line    = stdinReadLine();
      const encoded = new TextEncoder().encode(line);
      const n       = Math.min(encoded.length, Math.max(0, maxLen - 1));
      const mem     = new Uint8Array(wasmInstance.exports.memory.buffer);
      mem.set(encoded.subarray(0, n), addr);
      mem[addr + n] = 0;
      return n;
    };

    let _cbuf = [], _cpos = 0;
    env.getchar = () => {
      if (_cpos >= _cbuf.length) {
        const line = stdinReadLine();
        _cbuf = Array.from(new TextEncoder().encode(line + "\\n"));
        _cpos = 0;
      }
      return _cbuf[_cpos++];
    };

    for (const imp of envDefs) {
      if (imp.name in env) continue;
      const parts = imp.sig.split("=>")[0].trim().split(/\\s+/).filter(Boolean);
      const args  = argNames.slice(0, parts.length);
      try {
        env[imp.name] = new Function(...args, imp.body || "return 0;");
      } catch (err) {
        self.postMessage({ type: "error", message: "env." + imp.name + ": " + err.message });
        return;
      }
    }

    WebAssembly.instantiate(binary, { env })
      .then(instance => {
        wasmInstance      = instance;
        self.lastInstance = instance;
        self.postMessage({ type: "ready", exports: Object.keys(instance.exports) });
      })
      .catch(err => self.postMessage({ type: "error", message: err.message }));

    return;
  }

  if (msg.type === "run") {
    try {
      const result = wasmInstance.exports[msg.fn](...msg.args);
      self.postMessage({ type: "result", fn: msg.fn, args: msg.args, result });
    } catch (err) {
      self.postMessage({ type: "run_error", message: err.message });
    }
  }
};
`;

// ── resizable panels ─────────────────────────────────────────────────────────
function makeResizable(handleId, panelId, minW, maxW, storageKey) {
  const handle = document.getElementById(handleId);
  const panel  = document.getElementById(panelId);
  let startX, startW, dragging = false;

  const saved = localStorage.getItem(storageKey);
  if (saved) panel.style.width = saved + "px";

  handle.classList.toggle("hidden-handle", panel.classList.contains("collapsed"));

  handle.addEventListener("mousedown", (e) => {
    if (panel.classList.contains("collapsed")) return;
    dragging = true; startX = e.clientX; startW = panel.offsetWidth;
    handle.classList.add("dragging");
    document.body.classList.add("dragging-panel");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.width = Math.max(minW, Math.min(maxW, startW + e.clientX - startX)) + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("dragging-panel");
    localStorage.setItem(storageKey, panel.offsetWidth);
  });
}

makeResizable("resizeEnv",  "sidePanel",  140, 520, "wasm-env-panel-w");
makeResizable("resizeDocs", "docsPanel",  140, 520, "wasm-docs-panel-w");
makeResizable("resizeProg", "progPanel",  140, 520, "wasm-prog-panel-w");

// ── docs panel ───────────────────────────────────────────────────────────────
const DOC_FILES     = ["language.md"];
const DISPLAY_NAMES = { "language.md": "Language reference" };
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
  list.innerHTML = DOC_FILES.map(name => {
    const dn = DISPLAY_NAMES[name] || name;
    return `<div class="docs-file-item${currentDoc===name?" active":""}" data-doc="${esc(name)}">
      <span class="docs-file-icon">▸</span>
      <span class="docs-file-name">${esc(dn)}</span>
    </div>`;
  }).join("");
  list.querySelectorAll(".docs-file-item").forEach(el =>
    el.addEventListener("click", () => openDoc(el.dataset.doc)));
}
async function openDoc(name) {
  currentDoc = name;
  renderDocsList();
  document.getElementById("docsFileList").style.display = "none";
  document.getElementById("docsBack").classList.add("visible");
  document.getElementById("docsHeaderTitle").textContent = name;
  const viewer = document.getElementById("docsViewer");
  viewer.classList.add("visible");
  if (typeof docsCache[name] === "string") { viewer.innerHTML = renderMarkdown(docsCache[name]); return; }
  if (docsCache[name] instanceof Error)    { showDocError(viewer, name, docsCache[name]); return; }
  viewer.innerHTML = `<p style="color:var(--text-muted);font-size:12px;">Loading…</p>`;
  try {
    const res = await fetch(`docs/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    docsCache[name] = await res.text();
    if (currentDoc === name) viewer.innerHTML = renderMarkdown(docsCache[name]);
  } catch (err) {
    docsCache[name] = err;
    if (currentDoc === name) showDocError(viewer, name, err);
  }
}
function showDocError(viewer, name, err) {
  viewer.innerHTML = `<p style="color:var(--red);font-size:12px;">Failed to load <code>${esc(name)}</code><br>
    <span style="color:var(--text-muted);">${esc(err.message)}</span></p>`;
}
function renderMarkdown(md) {
  if (!md) return "";
  md = md.replace(/\r\n/g, "\n");
  const codeBlocks = [];
  md = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    const ph = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"));
    return ph;
  });
  md = md.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  md = md.replace(/^### (.+)$/gm,"<h3>$1</h3>").replace(/^## (.+)$/gm,"<h2>$1</h2>").replace(/^# (.+)$/gm,"<h1>$1</h1>");
  md = md.replace(/^> (.+)$/gm,"<blockquote><p>$1</p></blockquote>").replace(/^---$/gm,"<hr>");
  md = md.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>");
  md = md.replace(/`([^`]+)`/g,"<code>$1</code>");
  md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  md = md.replace(/(^- .+(?:\n- .+)*)/gm, block => {
    const items = block.trim().split("\n").map(l=>`<li>${l.slice(2).trim()}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  md = md.replace(/(\|.+\|[ \t]*\n)(\|[-| :]+\|[ \t]*\n)((?:\|.+\|[ \t]*\n?)*)/g, (_, head, _sep, body) => {
    const th   = head.trim().split("|").filter(Boolean).map(c=>`<th>${c.trim()}</th>`).join("");
    const rows = body.trim().split("\n").filter(Boolean).map(r =>
      "<tr>" + r.split("|").filter(Boolean).map(c=>`<td>${c.trim()}</td>`).join("") + "</tr>").join("");
    return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  md = md.split(/\n{2,}/).map(chunk => {
    const t = chunk.trim();
    if (!t) return "";
    if (/^<(h[1-3]|ul|ol|pre|table|blockquote|hr)/i.test(t) || /^@@CODE_BLOCK_\d+@@$/.test(t)) return t;
    return `<p>${t.replace(/\n/g," ")}</p>`;
  }).join("\n");
  md = md.replace(/@@CODE_BLOCK_(\d+)@@/g, (_,i) => `<pre><code>${codeBlocks[i].trimEnd()}</code></pre>`);
  return md;
}

// ── programs panel ───────────────────────────────────────────────────────────
const PROG_SECTIONS = [
  { label: "Getting Started", files: [
      { id: "basics",      name: "Basic syntax demonstration" },
      { id: "hello_world", name: "Hello, World!" },
  ]},
  { label: "Simple programs", files: [
      { id: "fibonacci", name: "Fibonacci" },
  ]},
  { label: "Libraries", files: [
      { id: "system", name: "System management" },
      { id: "stdio",  name: "Printing different types to standart output" },
  ]},
];
const progsCache = {};
let userProgs = [];
try { userProgs = JSON.parse(localStorage.getItem("wasm-user-progs") || "[]"); } catch {}

let activeProg = null;

function toggleProgPanel() {
  const panel     = document.getElementById("progPanel");
  const btn       = document.getElementById("activityProg");
  const collapsed = panel.classList.toggle("collapsed");
  btn.classList.toggle("active", !collapsed);
  document.getElementById("resizeProg").classList.toggle("hidden-handle", collapsed);
  if (!collapsed) renderProgList();
}
function renderProgList() {
  const list = document.getElementById("progFileList");
  let html = "";
  for (const section of PROG_SECTIONS) {
    if (!section.files.length) continue;
    html += `<div class="prog-section-label">${esc(section.label)}</div>`;
    for (const file of section.files) {
      const active = activeProg && !activeProg.isUser && activeProg.name === file.id;
      html += `<div class="prog-file-item prog-admin${active?" active":""}" data-name="${esc(file.id)}" data-user="0">
        <span class="prog-file-icon">★</span>
        <span class="prog-file-name">${esc(file.name)}<span class="prog-file-id">${esc(file.id)}</span></span>
      </div>`;
    }
  }
  if (userProgs.length > 0) {
    html += `<div class="prog-section-label">My Programs</div>`;
    html += userProgs.map((p, i) => {
      const active = activeProg && activeProg.isUser && activeProg.idx === i;
      return `<div class="prog-file-item${active?" active":""}" data-name="${esc(p.name)}" data-user="1" data-idx="${i}">
        <span class="prog-file-icon">▸</span>
        <span class="prog-file-name">${esc(p.name)}</span>
        <button class="prog-del-btn" data-idx="${i}" title="Delete">✕</button>
      </div>`;
    }).join("");
  }
  const total = PROG_SECTIONS.reduce((n,s)=>n+s.files.length,0);
  if (!total && !userProgs.length) html = `<div class="env-empty">No programs yet.<br>Click + to create one.</div>`;
  list.innerHTML = html;
  list.querySelectorAll(".prog-file-item").forEach(el => {
    el.addEventListener("click", async (e) => {
      if (e.target.classList.contains("prog-del-btn")) return;
      if (el.dataset.user === "1") loadUserProg(Number(el.dataset.idx));
      else await loadAdminProg(el.dataset.name);
      editor.refresh();
    });
  });
  list.querySelectorAll(".prog-del-btn").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); deleteUserProg(Number(btn.dataset.idx)); });
  });
}
function findAdminFile(id) {
  for (const s of PROG_SECTIONS) { const f = s.files.find(f=>f.id===id); if (f) return f; }
  return null;
}
async function loadAdminProg(id) {
  autoSaveCurrentProg();
  activeProg = { name: id, isUser: false };
  renderProgList();
  if (typeof progsCache[id] === "string") {
    document.getElementById("code").value = progsCache[id];
    updateLineNumbers();
    const file = findAdminFile(id);
    print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(file?file.name:id)}</span>`);
    return;
  }
  print(`<span class="c-muted">loading…</span>`);
  try {
    const res = await fetch(`programs/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    progsCache[id] = await res.text();
    if (activeProg && activeProg.name === id && !activeProg.isUser) {
      document.getElementById("code").value = progsCache[id];
      updateLineNumbers();
    }
    const file = findAdminFile(id);
    print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(file?file.name:id)}</span>`);
  } catch (err) {
    print(`<span class="c-err">✗ failed to load ${esc(id)}: ${esc(err.message)}</span>`);
  }
}
function loadUserProg(idx) {
  autoSaveCurrentProg();
  activeProg = { isUser: true, idx, name: userProgs[idx].name };
  renderProgList();
  document.getElementById("code").value = userProgs[idx].code;
  updateLineNumbers();
  print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(userProgs[idx].name)}</span>`);
  print("");
}
function autoSaveCurrentProg() {
  if (!activeProg || !activeProg.isUser || activeProg.idx >= userProgs.length) return;
  userProgs[activeProg.idx].code = document.getElementById("code").value;
  editor.refresh();
  try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
}
function deleteUserProg(idx) {
  const name = userProgs[idx].name;
  userProgs.splice(idx, 1);
  try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  if (activeProg && activeProg.isUser) {
    if (activeProg.idx === idx) { activeProg = null; document.getElementById("code").value = ""; updateLineNumbers(); }
    else if (activeProg.idx > idx) activeProg.idx--;
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
function closeProgNewForm() { document.getElementById("progNewForm").classList.add("hidden"); }
function createNewProg() {
  const name = document.getElementById("progNewName").value.trim();
  if (!name) { document.getElementById("progNewName").focus(); return; }
  autoSaveCurrentProg();
  userProgs.push({ name, code: "" });
  try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  const idx = userProgs.length - 1;
  activeProg = { isUser: true, idx, name };
  document.getElementById("code").value = "";
  updateLineNumbers();
  closeProgNewForm();
  renderProgList();
  print(`<span class="c-muted">created: </span><span class="c-ok">${esc(name)}</span>`);
  print("");
}

// ── env imports ──────────────────────────────────────────────────────────────
let envImports = [
  { name: "pow",     sig: "i32 i32 => i32", body: "return Math.pow(a, b)|0;" },
  { name: "log",     sig: "i32 => i32",     body: "console.log(a); return a;" },
  { name: "putchar", sig: "i32",            body: `console.stdout(String.fromCharCode(a));` },
];
let editingIdx = null;

function toggleEnvPanel() {
  const panel     = document.getElementById("sidePanel");
  const btn       = document.getElementById("activityEnv");
  const collapsed = panel.classList.toggle("collapsed");
  btn.classList.toggle("active", !collapsed);
  document.getElementById("resizeEnv").classList.toggle("hidden-handle", collapsed);
}
function renderEnvList() {
  const list = document.getElementById("envList");
  if (!envImports.length) { list.innerHTML = '<div class="env-empty">No env imports.<br>Click + to add one.</div>'; return; }
  list.innerHTML = envImports.map((e, i) => `
    <div class="env-item" data-idx="${i}">
      <div class="env-item-name">${esc(e.name)}</div>
      <div class="env-item-sig">${esc(e.sig||"")}</div>
      <div class="env-item-actions">
        <button class="env-action-btn" data-action="edit"   data-idx="${i}">✎</button>
        <button class="env-action-btn del" data-action="delete" data-idx="${i}">✕</button>
      </div>
    </div>`).join("");
  list.querySelectorAll(".env-item").forEach(el => el.addEventListener("click", () => selectEnv(Number(el.dataset.idx))));
  list.querySelectorAll(".env-action-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      if (btn.dataset.action === "edit")   editEnv(idx);
      if (btn.dataset.action === "delete") deleteEnv(idx);
    });
  });
}
function selectEnv(i) {
  document.querySelectorAll(".env-item").forEach((el,j) => el.classList.toggle("selected", j===i));
}
function openForm(idx = null) {
  editingIdx = idx;
  document.getElementById("envFormTitle").textContent = idx === null ? "New Import" : "Edit Import";
  const e = idx !== null ? envImports[idx] : { name:"", sig:"", body:"" };
  document.getElementById("envName").value = e.name;
  document.getElementById("envSig").value  = e.sig;
  document.getElementById("envBody").value = e.body;
  document.getElementById("envForm").classList.remove("hidden");
  document.getElementById("envName").focus();
}
function closeForm() { document.getElementById("envForm").classList.add("hidden"); editingIdx = null; }
function editEnv(i) { openForm(i); }
function deleteEnv(i) {
  envImports.splice(i, 1); renderEnvList(); closeForm();
  print(`<span class="c-muted">env import removed</span>`); print("");
}
function saveEnv() {
  const name = document.getElementById("envName").value.trim();
  const sig  = document.getElementById("envSig").value.trim();
  const body = document.getElementById("envBody").value.trim();
  if (!name) { document.getElementById("envName").focus(); return; }
  const entry = { name, sig, body };
  if (editingIdx !== null) envImports[editingIdx] = entry; else envImports.push(entry);
  renderEnvList(); closeForm();
  print(`<span class="c-muted">env import saved: </span><span class="c-ok">${esc(name)}</span>`); print("");
}

// ── event wiring ─────────────────────────────────────────────────────────────
document.getElementById("activityEnv").addEventListener("click", toggleEnvPanel);
document.getElementById("activityDocs").addEventListener("click", toggleDocsPanel);
document.getElementById("activityProg").addEventListener("click", toggleProgPanel);
document.getElementById("envAddBtn").addEventListener("click", () => openForm());
document.getElementById("envCancelBtn").addEventListener("click", closeForm);
document.getElementById("envSaveBtn").addEventListener("click", saveEnv);
document.getElementById("docsBack").addEventListener("click", showDocsList);
document.getElementById("progAddBtn").addEventListener("click", openProgNewForm);
document.getElementById("progNewCancel").addEventListener("click", closeProgNewForm);
document.getElementById("progNewSave").addEventListener("click", createNewProg);
document.getElementById("progNewName").addEventListener("keydown", (e) => {
  if (e.key === "Enter")  createNewProg();
  if (e.key === "Escape") closeProgNewForm();
});
document.getElementById("code").addEventListener("input", () => {
  if (activeProg && activeProg.isUser) {
    userProgs[activeProg.idx].code = document.getElementById("code").value;
    try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  }
});

renderEnvList();

// ── terminal ─────────────────────────────────────────────────────────────────
const termOutput = document.getElementById("termOutput");
const termInput  = document.getElementById("termInput");
let cmdHistory = [], histIdx = -1;
let lastBinary = null, lastMeta = {};

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function print(html) {
  const d = document.createElement("div");
  d.className = "term-line";
  d.innerHTML = html;
  termOutput.appendChild(d);
  termOutput.scrollTop = termOutput.scrollHeight;
}
function appendToPrint(text) {
  text.split("\n").forEach((part, i) => {
    if (i === 0) {
      const last = termOutput.lastElementChild;
      if (last) last.innerHTML += part; else print(part);
    } else {
      print(part);
    }
  });
}
console.stdout = appendToPrint;

// ── Worker / SharedArrayBuffer stdin ─────────────────────────────────────────
let activeWorker   = null;   // running Web Worker
let activeSAB      = null;   // SharedArrayBuffer (8-byte header + data)
let sabSignalView  = null;   // Int32Array[0]=signal, [1]=length
let sabDataView    = null;   // Uint8Array at offset 8
let stdinMode      = false;  // terminal is waiting for user to type a stdin line
let pendingRunResolve = null;
let pendingRunReject  = null;

function terminateWorker() {
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  exitStdinMode();
  pendingRunResolve = pendingRunReject = null;
}

// Enter "stdin waiting" state — changes the prompt indicator
function enterStdinMode() {
  stdinMode = true;
  termInput.classList.add("stdin-mode");
  // Print a waiting line that will be replaced when the user submits
  print(`<span class="c-stdin-wait">stdin ▸ </span>`);
  termInput.focus();
}

function exitStdinMode() {
  stdinMode = false;
  termInput.classList.remove("stdin-mode");
}

// Called when the user presses Enter while stdinMode === true
function submitStdin(line) {
  // Update the waiting indicator line with the echoed text
  const last = termOutput.lastElementChild;
  if (last) last.innerHTML =
    `<span class="c-stdin-wait">stdin ▸ </span><span class="c-stdin-echo">${esc(line)}</span>`;

  exitStdinMode();

  // Write into SharedArrayBuffer and wake the worker
  const encoded = new TextEncoder().encode(line);
  const n = Math.min(encoded.length, sabDataView.length);
  sabDataView.set(encoded.subarray(0, n), 0);
  Atomics.store(sabSignalView, 1, n);     // store byte count
  Atomics.store(sabSignalView, 0, 1);     // signal: data ready
  Atomics.notify(sabSignalView, 0, 1);    // wake the worker
}

// Central handler for all messages coming from the worker
function onWorkerMessage(e) {
  const msg = e.data;

  if (msg.type === "stdout") {
    appendToPrint(msg.text);
    return;
  }
  if (msg.type === "stdin_request") {
    enterStdinMode();
    return;
  }
  if (msg.type === "result") {
    if (pendingRunResolve) { pendingRunResolve(msg); pendingRunResolve = pendingRunReject = null; }
    return;
  }
  if (msg.type === "run_error") {
    print(`<span class="c-err">✗ ${esc(msg.message)}</span>`);
    if (pendingRunReject) { pendingRunReject(new Error(msg.message)); pendingRunResolve = pendingRunReject = null; }
    terminateWorker();
    return;
  }
  if (msg.type === "error") {
    print(`<span class="c-err">✗ ${esc(msg.message)}</span>`);
    terminateWorker();
    return;
  }
}

/**
 * Compile the source, spin up a worker, hand it the binary.
 * Resolves with the list of exported names once the worker is ready.
 */
async function compileAndSpawnWorker(code) {
  terminateWorker();

  const libs   = await gatherLibs(code);
  const binary = compile(code, libs);
  if (!binary) throw new Error("compile() returned null");

  lastBinary = binary;
  lastMeta   = binary.meta || {};

  // Print binary summary
  print(`<span class="c-ok">✓ ${binary.length} bytes</span>`);
  let hex = "";
  const lim = Math.min(binary.length, 48);
  for (let i = 0; i < lim; i++) hex += binary[i].toString(16).padStart(2,"0").toUpperCase() + " ";
  if (binary.length > 48) hex += `<span class="c-muted">… +${binary.length-48}</span>`;
  print(`<span class="c-hex">${hex}</span>`);

  // SharedArrayBuffer: 8-byte header + 64 KiB data
  activeSAB     = new SharedArrayBuffer(8 + 65536);
  sabSignalView = new Int32Array(activeSAB);
  sabDataView   = new Uint8Array(activeSAB, 8);

  const blob = new Blob([WORKER_SRC], { type: "text/javascript" });
  const blobURL = URL.createObjectURL(blob);
  activeWorker  = new Worker(blobURL);
  URL.revokeObjectURL(blobURL);

  activeWorker.onmessage = onWorkerMessage;
  activeWorker.onerror   = (e) => { print(`<span class="c-err">✗ worker error: ${esc(e.message)}</span>`); terminateWorker(); };

  // Transfer the binary buffer to the worker (zero-copy)
  const buf = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);

  return new Promise((resolve, reject) => {
    // Intercept the first "ready" or "error" message
    activeWorker.onmessage = (e) => {
      if (e.data.type === "ready") {
        activeWorker.onmessage = onWorkerMessage; // swap to normal handler
        resolve(e.data.exports);
      } else if (e.data.type === "error") {
        reject(new Error(e.data.message));
        terminateWorker();
      } else {
        onWorkerMessage(e); // pass through stdout etc.
      }
    };

    activeWorker.postMessage({ type: "init", binary: buf, sab: activeSAB, envDefs: envImports }, [buf]);
  });
}

/**
 * Ask the running worker to call fn(...args).
 * Returns a promise resolving to { fn, args, result }.
 */
function workerRun(fn, args) {
  return new Promise((resolve, reject) => {
    pendingRunResolve = resolve;
    pendingRunReject  = reject;
    activeWorker.postMessage({ type: "run", fn, args });
  });
}

// ── lib gatherer ─────────────────────────────────────────────────────────────
async function gatherLibs(code) {
  const libs = {};
  for (const line of code.split("\n")) {
    const m = line.match(/^\s*#include\s+<([^>]+)>\s*$/);
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

// ── startup ───────────────────────────────────────────────────────────────────
print(`<span class="c-info">WASM Compiler ready.</span>`);
print(`<span class="c-muted">compile · run &lt;fn&gt; [args] · make · boot · hex · clear · help</span>`);
print("");

// ── command dispatcher ───────────────────────────────────────────────────────
async function runCommand(raw, isInternal = false) {
  const cmd = raw.trim();
  if (!cmd) return;

  if (!isInternal) {
    cmdHistory.unshift(cmd);
    histIdx = -1;
    print(`<span class="c-prompt">$ </span>${esc(cmd)}`);
  }

  const parts = cmd.split(/\s+/), verb = parts[0].toLowerCase();

  if (verb === "help") {
    print(`<span class="c-muted">  compile         — compile only</span>`);
    print(`<span class="c-muted">  run fn [args] — call exported function</span>`);
    print(`<span class="c-muted">  make [args]   — compile &amp; test all exports</span>`);
    print(`<span class="c-muted">  boot [args]   — compile &amp; run "main"</span>`);
    print(`<span class="c-muted">  hex           — hex dump of last binary</span>`);
    print(`<span class="c-muted">  clear         — clear terminal</span>`);
  }

  else if (verb === "clear") {
    termOutput.innerHTML = "";
  }

  else if (verb === "compile") {
    const code = document.getElementById("code").value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }
    print(`<span class="c-muted">compiling…</span>`);
    try {
      const exports = await compileAndSpawnWorker(code);
      print(`<span class="c-muted">exports: </span><span class="c-ok">${exports.map(esc).join(", ")}</span>`);
    } catch (err) {
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  else if (verb === "run") {
    if (!activeWorker) { print(`<span class="c-warn">⚠ compile first</span>`); return; }
    const fn   = parts[1];
    const args = parts.slice(2).map(Number);
    if (!fn) { print(`<span class="c-err">usage: run &lt;fn&gt; [args]</span>`); return; }
    try {
      print(`<span class="c-muted">running ${esc(fn)}(${args.join(", ")})…</span>`);
      print("");
      const { result } = await workerRun(fn, args);
      print(`<span class="c-muted">  ${esc(fn)}(${args.join(", ")}) → </span><span class="c-ok">${result}</span>`);
    } catch (err) {
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  else if (verb === "make") {
    const code = document.getElementById("code").value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }
    print(`<span class="c-muted">compiling…</span>`);
    try {
      const exports  = await compileAndSpawnWorker(code);
      print(`<span class="c-muted">exports: </span><span class="c-ok">${exports.map(esc).join(", ")}</span>`);
      print("");
      const supplied = parts.slice(1).map(Number);
      for (const fn of exports) {
        const needed   = lastMeta[fn] ?? supplied.length;
        const testArgs = Array.from({ length: needed }, (_, i) => i < supplied.length ? supplied[i] : 0);
        await runCommand(`run ${fn} ${testArgs.join(" ")}`, true);
      }
    } catch (err) {
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  else if (verb === "boot") {
    const code = document.getElementById("code").value;
    if (!code.trim()) { print(`<span class="c-err">editor is empty</span>`); return; }
    print(`<span class="c-muted">compiling…</span>`);
    try {
      const exports  = await compileAndSpawnWorker(code);
      print(`<span class="c-muted">exports: </span><span class="c-ok">${exports.map(esc).join(", ")}</span>`);
      print("");
      if (!exports.includes("main")) { print(`<span class="c-warn">no "main" export found</span>`); return; }
      const supplied  = parts.slice(1).map(Number);
      const needed    = lastMeta["main"] ?? supplied.length;
      const testArgs  = Array.from({ length: needed }, (_, i) => i < supplied.length ? supplied[i] : 0);
      print(`<span class="c-muted">running main(${testArgs.join(", ")})…</span>`);
      print("");
      const { result } = await workerRun("main", testArgs);
      print(`<span class="c-muted">  main(${testArgs.join(", ")}) → </span><span class="c-ok">${result}</span>`);
    } catch (err) {
      print(`<span class="c-err">✗ ${esc(err.message)}</span>`);
    }
  }

  else if (verb === "hex") {
    if (!lastBinary) { print(`<span class="c-warn">⚠ compile first</span>`); return; }
    let row = "";
    for (let i = 0; i < lastBinary.length; i++)
      row += lastBinary[i].toString(16).padStart(2,"0").toUpperCase() + " ";
    if (row) print(`<span class="c-hex">${row}</span>`);
  }

  else if (verb === "test") {
    print(test(...parts.slice(1)));
  }

  else {
    print(`<span class="c-err">✗ unknown command: ${esc(verb)}</span>`);
  }

  if (!isInternal) print("");
}

// ── keyboard ──────────────────────────────────────────────────────────────────
termInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = termInput.value;
    termInput.value = "";
    // If the program is waiting for stdin, route to the worker's SAB
    if (stdinMode) {
      submitStdin(v);
    } else {
      runCommand(v);
    }
  } else if (!stdinMode && e.key === "ArrowUp") {
    e.preventDefault();
    if (histIdx < cmdHistory.length - 1) { histIdx++; termInput.value = cmdHistory[histIdx]; }
  } else if (!stdinMode && e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx > 0) { histIdx--; termInput.value = cmdHistory[histIdx]; }
    else { histIdx = -1; termInput.value = ""; }
  }
});

document.getElementById("panel").addEventListener("click", () => termInput.focus());

// ── editor / line numbers / minimap ──────────────────────────────────────────
const codeEl     = document.getElementById("code");
const lineNums   = document.getElementById("lineNumbers");
const editorWrap = document.getElementById("editorWrap");

function getCursorLine() {
  return codeEl.value.substring(0, codeEl.selectionStart).split("\n").length;
}
function updateLineNumbers() {
  const lines = codeEl.value.split("\n"), cur = getCursorLine();
  let html = "";
  for (let i = 1; i <= lines.length; i++)
    html += `<span class="line-number${i===cur?" active":""}">${i}</span>`;
  lineNums.innerHTML = html;
  lineNums.scrollTop = editorWrap.scrollTop;
  updateMinimap();
}
editorWrap.addEventListener("scroll", () => { lineNums.scrollTop = editorWrap.scrollTop; updateMinimap(); });
codeEl.addEventListener("input",  updateLineNumbers);
codeEl.addEventListener("keyup",  updateLineNumbers);
codeEl.addEventListener("click",  updateLineNumbers);
codeEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = codeEl.selectionStart, end = codeEl.selectionEnd;
    codeEl.value = codeEl.value.substring(0,s) + "    " + codeEl.value.substring(end);
    codeEl.selectionStart = codeEl.selectionEnd = s + 4;
    updateLineNumbers();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault(); runCommand("make"); termInput.focus();
  }
});

const minimapCanvas    = document.getElementById("minimapCanvas");
const minimapViewport  = document.getElementById("minimapViewport");
const minimapContainer = document.getElementById("minimapContainer");
const LINE_PX = 2, LINE_GAP = 1, LINE_STRIDE = LINE_PX + LINE_GAP;
updateLineNumbers();

function updateMinimap() {
  const lines = codeEl.value.split("\n");
  const W = minimapContainer.offsetWidth, totalH = lines.length * LINE_STRIDE;
  minimapCanvas.width = W; minimapCanvas.height = totalH;
  minimapCanvas.style.width = W + "px"; minimapCanvas.style.height = totalH + "px";
  const ctx = minimapCanvas.getContext("2d");
  ctx.clearRect(0, 0, W, totalH);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const alpha = Math.min(0.7, 0.2 + line.trim().length * 0.015);
    ctx.fillStyle = `rgba(212,212,212,${alpha})`;
    ctx.fillRect(2, i*LINE_STRIDE, Math.min(W-4, line.length*1.4), LINE_PX);
  });
  const containerH = minimapContainer.offsetHeight;
  const editorH    = editorWrap.offsetHeight;
  const contentH   = codeEl.scrollHeight || editorH;
  const vpH        = Math.max(6, Math.round(totalH * Math.min(1, editorH/contentH)));
  const cursorY    = (getCursorLine()-1) * LINE_STRIDE;
  const offsetTop  = Math.max(0, Math.min(totalH-containerH, cursorY-containerH/2));
  minimapCanvas.style.top = -offsetTop + "px";
  const scrollRatio = contentH > editorH ? editorWrap.scrollTop / (contentH-editorH) : 0;
  minimapViewport.style.top    = scrollRatio*(totalH-vpH) - offsetTop + "px";
  minimapViewport.style.height = vpH + "px";
}
window.addEventListener("resize", updateMinimap);
setTimeout(updateMinimap, 50);