import { compile, test } from "./compiler.js";

import { initEditor } from "./editor.js";

const editor = initEditor(
  document.getElementById("code"),
  document.getElementById("editorWrap")
);




function makeResizable(handleId, panelId, minW, maxW, storageKey) {
  const handle = document.getElementById(handleId);
  const panel = document.getElementById(panelId);
  let startX,
    startW,
    dragging = false;

  const saved = localStorage.getItem(storageKey);
  if (saved) panel.style.width = saved + "px";

  handle.classList.toggle("hidden-handle", panel.classList.contains("collapsed"));

  handle.addEventListener("mousedown", (e) => {
    if (panel.classList.contains("collapsed")) return;
    dragging = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add("dragging");
    document.body.classList.add("dragging-panel");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(minW, Math.min(maxW, startW + delta));
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

makeResizable("resizeEnv", "sidePanel", 140, 520, "wasm-env-panel-w");
makeResizable("resizeDocs", "docsPanel", 140, 520, "wasm-docs-panel-w");
makeResizable("resizeProg", "progPanel", 140, 520, "wasm-prog-panel-w");



const DOC_FILES = ["language.md"];
const DISPLAY_NAMES = {
  "language.md": "Language reference"
};

const docsCache = {};
let currentDoc = null;

function toggleDocsPanel() {
  const panel = document.getElementById("docsPanel");
  const btn = document.getElementById("activityDocs");
  const open = panel.classList.toggle("collapsed") === false;
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
    const res = await fetch(`docs/${name}`);
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
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>");

  md = md.replace(/^> (.+)$/gm, "<blockquote><p>$1</p></blockquote>");
  md = md.replace(/^---$/gm, "<hr>");
  md = md.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/\*(.+?)\*/g, "<em>$1</em>");
  md = md.replace(/`([^`]+)`/g, "<code>$1</code>");
  md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  md = md.replace(/(^- .+(?:\n- .+)*)/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((line) => `<li>${line.slice(2).trim()}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  md = md.replace(
    /(\|.+\|[ \t]*\n)(\|[-| :]+\|[ \t]*\n)((?:\|.+\|[ \t]*\n?)*)/g,
    (_, head, _sep, body) => {
      const th = head
        .trim()
        .split("|")
        .filter(Boolean)
        .map((c) => `<th>${c.trim()}</th>`)
        .join("");
      const rows = body
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (r) =>
            "<tr>" +
            r
              .split("|")
              .filter(Boolean)
              .map((c) => `<td>${c.trim()}</td>`)
              .join("") +
            "</tr>"
        )
        .join("");
      return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  );

  md = md
    .split(/\n{2,}/)
    .map((chunk) => {
      const t = chunk.trim();
      if (!t) return "";
      if (/^<(h[1-3]|ul|ol|pre|table|blockquote|hr|code)/i.test(t)) return t;
      if (/^@@CODE_BLOCK_\d+@@$/.test(t)) return t;
      return `<p>${t.replace(/\n/g, " ")}</p>`;
    })
    .join("\n");

  md = md.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, i) => {
    const code = codeBlocks[i];
    return `<pre><code>${code.trimEnd()}</code></pre>`;
  });

  return md;
}

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
      { id: "fibonacci",      name: "Fibonacci" },
    ]
  },
  {
    label: "Libraries",
    files: [
      { id: "system",    name: "System management" },
      { id: "stdio",    name: "Printing different types to standart output" },
    ]
  },
];

const progsCache = {};
let userProgs = [];
try { userProgs = JSON.parse(localStorage.getItem("wasm-user-progs") || "[]"); } catch {}

let activeProg = null;
let progPanelInited = false;

function toggleProgPanel() {
  const panel = document.getElementById("progPanel");
  const btn = document.getElementById("activityProg");
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

  list.innerHTML = html;

  list.querySelectorAll(".prog-file-item").forEach((el) => {
    el.addEventListener("click", async (e) => {
      if (e.target.classList.contains("prog-del-btn")) return;
      if (el.dataset.user === "1") {
        loadUserProg(Number(el.dataset.idx));
      } else {
        await loadAdminProg(el.dataset.name);
      }
      editor.refresh()
    });
  });

  list.querySelectorAll(".prog-del-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteUserProg(Number(btn.dataset.idx));
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
  activeProg = { name: id, isUser: false };
  renderProgList();

  if (typeof progsCache[id] === "string") {
    document.getElementById("code").value = progsCache[id];
    updateLineNumbers();
    const file = findAdminFile(id);
    print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(file ? file.name : id)}</span>`);
    return;
  }

  print(`<span class="c-muted">loading…</span>`);
  try {
    const res = await fetch(`programs/${id}`);
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
  activeProg = { isUser: true, idx, name: userProgs[idx].name };
  renderProgList();
  document.getElementById("code").value = userProgs[idx].code;
  updateLineNumbers();
  print(`<span class="c-muted">loaded: </span><span class="c-ok">${esc(userProgs[idx].name)}</span>`);
  print("");
}

function autoSaveCurrentProg() {
  if (!activeProg || !activeProg.isUser) return;
  if (activeProg.idx >= userProgs.length) return;
  userProgs[activeProg.idx].code = document.getElementById("code").value;
  editor.refresh()
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



let envImports = [
  {
    name: "pow",
    sig: "i32 i32 => i32",
    body: "return Math.pow(a, b)|0;",
  },
  { name: "log", sig: "i32 => i32", body: "console.log(a); return a;" },
  { name: "putchar", sig: "i32", body: `console.stdout(String.fromCharCode(a));` },

  // ── stdin ──────────────────────────────────────────────────────────────
  {
    name: "readline",
    sig: "i32 i32 => i32",
    body: `var input = window.prompt("stdin:") ?? "";
var encoded = new TextEncoder().encode(input);
var n = Math.min(encoded.length, Math.max(0, b - 1));
var mem = new Uint8Array(lastInstance.exports.memory.buffer);
mem.set(encoded.subarray(0, n), a);
mem[a + n] = 0;
return n;`,
  },
];
let editingIdx = null;

function toggleEnvPanel() {
  const panel = document.getElementById("sidePanel");
  const btn = document.getElementById("activityEnv");
  const collapsed = panel.classList.toggle("collapsed");
  btn.classList.toggle("active", !collapsed);
  document.getElementById("resizeEnv").classList.toggle("hidden-handle", collapsed);
}

function renderEnvList() {
  const list = document.getElementById("envList");
  if (!envImports.length) {
    list.innerHTML =
      '<div class="env-empty">No env imports.<br>Click + to add one.</div>';
    return;
  }
  list.innerHTML = envImports
    .map(
      (e, i) => `
        <div class="env-item" data-idx="${i}">
            <div class="env-item-name">${esc(e.name)}</div>
            <div class="env-item-sig">${esc(e.sig || "")}</div>
            <div class="env-item-actions">
                <button class="env-action-btn" data-action="edit" data-idx="${i}">✎</button>
                <button class="env-action-btn del" data-action="delete" data-idx="${i}">✕</button>
            </div>
        </div>`,
    )
    .join("");

  list.querySelectorAll(".env-item").forEach((el) => {
    el.addEventListener("click", () => selectEnv(Number(el.dataset.idx)));
  });

  list.querySelectorAll(".env-action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      if (btn.dataset.action === "edit") editEnv(idx);
      else if (btn.dataset.action === "delete") deleteEnv(idx);
    });
  });
}

function selectEnv(i) {
  document
    .querySelectorAll(".env-item")
    .forEach((el, j) => el.classList.toggle("selected", j === i));
}

function openForm(idx = null) {
  editingIdx = idx;
  document.getElementById("envFormTitle").textContent =
    idx === null ? "New Import" : "Edit Import";
  const e = idx !== null ? envImports[idx] : { name: "", sig: "", body: "" };
  document.getElementById("envName").value = e.name;
  document.getElementById("envSig").value = e.sig;
  document.getElementById("envBody").value = e.body;
  document.getElementById("envForm").classList.remove("hidden");
  document.getElementById("envName").focus();
}

function closeForm() {
  document.getElementById("envForm").classList.add("hidden");
  editingIdx = null;
}

function editEnv(i) {
  openForm(i);
}

function deleteEnv(i) {
  envImports.splice(i, 1);
  renderEnvList();
  closeForm();
  print(`<span class="c-muted">env import removed</span>`);
  print("");
}

function saveEnv() {
  const name = document.getElementById("envName").value.trim();
  const sig = document.getElementById("envSig").value.trim();
  const body = document.getElementById("envBody").value.trim();
  if (!name) {
    document.getElementById("envName").focus();
    return;
  }
  const entry = { name, sig, body };
  if (editingIdx !== null) {
    envImports[editingIdx] = entry;
  } else {
    envImports.push(entry);
  }
  renderEnvList();
  closeForm();
  print(
    `<span class="c-muted">env import saved: </span><span class="c-ok">${esc(name)}</span>`,
  );
  print("");
}

function buildEnvObject() {
  const env = {}, argNames = ["a", "b", "c", "d", "e", "f", "g", "h"];

  // ── stdin built-ins ──────────────────────────────────────────────────────

  // readline(addr, maxLen) → writes line into WASM memory, returns byte count
  env.readline = (addr, maxLen) => {
    const input   = window.prompt("stdin:") ?? "";
    const line    = input;
    const encoded = new TextEncoder().encode(line);
    const n       = Math.min(encoded.length, Math.max(0, maxLen - 1));
    const mem     = new Uint8Array(lastInstance.exports.memory.buffer);
    mem.set(encoded.subarray(0, n), addr);
    mem[addr + n] = 0;   // null-terminate
    return n;
  };

  // getchar() → one byte at a time, buffers a whole prompt() line internally
  let _charBuf = [], _charPos = 0;
  env.getchar = () => {
    if (_charPos >= _charBuf.length) {
      const input = window.prompt("stdin:") ?? "";
      if (input === null) return -1;  // cancelled = EOF
      _charBuf = Array.from(new TextEncoder().encode(input + "\n"));
      _charPos = 0;
    }
    return _charBuf[_charPos++];
  };

  // ── user-defined env imports (existing logic) ────────────────────────────
  for (const imp of envImports) {
    if (imp.name in env) continue;   // don't override built-ins
    const parts = imp.sig.split("=>")[0].trim().split(/\s+/).filter(Boolean);
    const args  = argNames.slice(0, parts.length);
    try {
      env[imp.name] = new Function(...args, imp.body || "return 0;");
    } catch (err) {
      throw new Error(`env.${imp.name}: ${err.message}`);
    }
  }

  return env;
}


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
  if (e.key === "Enter") createNewProg();
  if (e.key === "Escape") closeProgNewForm();
});

document.getElementById("code").addEventListener("input", () => {
  if (activeProg && activeProg.isUser) {
    userProgs[activeProg.idx].code = document.getElementById("code").value;
    try { localStorage.setItem("wasm-user-progs", JSON.stringify(userProgs)); } catch {}
  }
});

renderEnvList();



const termOutput = document.getElementById("termOutput");
const termInput = document.getElementById("termInput");
let cmdHistory = [],
  histIdx = -1,
  lastBinary = null,
  lastInstance = null,
  lastMeta = {};

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
      if (last) {
        last.innerHTML += part;
      } else {
        print(part);
      }
    } else {
      print(part);
    }
  });
}
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

console.stdout = appendToPrint;

print(`<span class="c-info">WASM Compiler ready.</span>`);
print(
  `<span class="c-muted">compile · run &lt;fn&gt; [args] · make · hex · clear · help</span>`,
);
print("");

async function runCommand(raw, isInternal = false) {
  const cmd = raw.trim();
  if (!cmd) return;

  if (!isInternal) {
    cmdHistory.unshift(cmd);
    histIdx = -1;
    print(`<span class="c-prompt">$ </span>${esc(cmd)}`);
  }

  const parts = cmd.split(/\s+/),
    verb = parts[0].toLowerCase();

  if (verb === "help") {
    print(`<span class="c-muted">  compile         — compile only</span>`);
    print(`<span class="c-muted">  run fn [args] — call exported function</span>`);
    print(`<span class="c-muted">  make [args]   — compile &amp; test exports with given args</span>`);
    print(`<span class="c-muted">  boot [args]   — compile &amp; run "main" with given args</span>`);
    print(`<span class="c-muted">  hex           — full hex dump of binary</span>`);
    print(`<span class="c-muted">  clear         — clear terminal</span>`);
  }

  else if (verb === "clear") {
    termOutput.innerHTML = "";
  }

  else if (verb === "compile") {
    const code = document.getElementById("code").value;
    if (!code.trim()) {
      print(`<span class="c-err">editor is empty</span>`);
      return;
    }

    print(`<span class="c-muted">compiling…</span>`);

    try {
      const libs = await gatherLibs(code);
      const binary = compile(code, libs);
      if (!binary) throw new Error("compile() returned null");

      lastBinary = binary;
      lastMeta = binary.meta || {};

      print(`<span class="c-ok">✓ ${binary.length} bytes</span>`);

      let hex = "";
      const lim = Math.min(binary.length, 48);
      for (let i = 0; i < lim; i++) {
        hex += binary[i].toString(16).padStart(2, "0").toUpperCase() + " ";
      }
      if (binary.length > 48) {
        hex += `<span class="c-muted">… +${binary.length - 48}</span>`;
      }
      print(`<span class="c-hex">${hex}</span>`);

      const mod = await WebAssembly.compile(binary);
      lastInstance = await WebAssembly.instantiate(mod, {
        env: buildEnvObject(),
      });

      const exps = Object.keys(lastInstance.exports);
      print(`<span class="c-muted">exports: </span><span class="c-ok">${exps.map(esc).join(", ")}</span>`);

    } catch (e) {
      print(`<span class="c-err">✗ ${esc(e.message)}</span>`);
    }
  }

  else if (verb === "make") {
    await runCommand("compile", true);
    print("");

    if (!lastInstance) return;

    const supplied = parts.slice(1).map(Number);
    const exps = Object.keys(lastInstance.exports);

    for (const fn of exps) {
      if (typeof lastInstance.exports[fn] !== "function") continue;

      const needed = lastMeta[fn] ?? supplied.length;
      const testArgs = Array.from({ length: needed }, (_, i) =>
        i < supplied.length ? supplied[i] : 0,
      );

      await runCommand(`run ${fn} ${testArgs.join(" ")}`, true);
    }
  }

  else if (verb === "run") {
    if (!lastInstance) {
      print(`<span class="c-warn">⚠ run build/make first</span>`);
      return;
    }

    const fn = parts[1],
      args = parts.slice(2).map(Number);

    if (!fn) {
      print(`<span class="c-err">usage: run &lt;fn&gt; [args]</span>`);
      return;
    }

    const func = lastInstance.exports[fn];
    if (!func || typeof func !== "function") {
      print(`<span class="c-err">✗ no export "${esc(fn)}"</span>`);
      return;
    }

    try {
      print(`<span class="c-muted">Running function ${esc(fn)}(${args.join(", ")})</span>`);
      print('');
      const r = func(...args);
      print(`<span class="c-muted">  ${esc(fn)}(${args.join(", ")}) → </span><span class="c-ok">${r}</span>`);
    } catch (e) {
      print(`<span class="c-err">✗ ${esc(e.message)}</span>`);
    }
  }

  else if (verb === "boot") {
    await runCommand("compile", true);
    print("");

    if (!lastInstance) return;

    const supplied = parts.slice(1).map(Number);

    const fn = "main";

    if (typeof lastInstance.exports[fn] !== "function") {
      print(`No "${fn}" function found`);
      return;
    }

    const needed = lastMeta[fn] ?? supplied.length;
    const testArgs = Array.from({ length: needed }, (_, i) =>
      i < supplied.length ? supplied[i] : 0,
    );

    await runCommand(`run ${fn} ${testArgs.join(" ")}`, true);
  }
  

  else if (verb === "test") {
    let args = parts.slice(1);
    print(test(...args));
  }

  else if (verb === "hex") {
    if (!lastBinary) {
      print(`<span class="c-warn">⚠ run build first</span>`);
      return;
    }
    let row = "";
    for (let i = 0; i < lastBinary.length; i++) {
      row += lastBinary[i].toString(16).padStart(2, "0").toUpperCase() + " ";
    }
    if (row) print(`<span class="c-hex">${row}</span>`);
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
    if (histIdx < cmdHistory.length - 1) {
      histIdx++;
      termInput.value = cmdHistory[histIdx];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx > 0) {
      histIdx--;
      termInput.value = cmdHistory[histIdx];
    } else {
      histIdx = -1;
      termInput.value = "";
    }
  }
});

document.getElementById("panel").addEventListener("click", () => termInput.focus());



const codeEl = document.getElementById("code");
const lineNums = document.getElementById("lineNumbers");
const editorWrap = document.getElementById("editorWrap");

function getCursorLine() {
  return codeEl.value.substring(0, codeEl.selectionStart).split("\n").length;
}
function updateLineNumbers() {
  const lines = codeEl.value.split("\n");
  const cur = getCursorLine();
  let html = "";
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
codeEl.addEventListener("input", updateLineNumbers);
codeEl.addEventListener("keyup", updateLineNumbers);
codeEl.addEventListener("click", updateLineNumbers);
codeEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = codeEl.selectionStart,
      end = codeEl.selectionEnd;
    codeEl.value =
      codeEl.value.substring(0, s) + "    " + codeEl.value.substring(end);
    codeEl.selectionStart = codeEl.selectionEnd = s + 4;
    updateLineNumbers();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runCommand("make");
    termInput.focus();
  }
});


const minimapCanvas = document.getElementById("minimapCanvas");
const minimapViewport = document.getElementById("minimapViewport");
const minimapContainer = document.getElementById("minimapContainer");
const LINE_PX = 2,
  LINE_GAP = 1,
  LINE_STRIDE = LINE_PX + LINE_GAP;
updateLineNumbers();

function updateMinimap() {
  const lines = codeEl.value.split("\n");
  const W = minimapContainer.offsetWidth,
    totalH = lines.length * LINE_STRIDE;
  minimapCanvas.width = W;
  minimapCanvas.height = totalH;
  minimapCanvas.style.width = W + "px";
  minimapCanvas.style.height = totalH + "px";
  const ctx = minimapCanvas.getContext("2d");
  ctx.clearRect(0, 0, W, totalH);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const alpha = Math.min(0.7, 0.2 + line.trim().length * 0.015);
    ctx.fillStyle = `rgba(212,212,212,${alpha})`;
    ctx.fillRect(
      2,
      i * LINE_STRIDE,
      Math.min(W - 4, line.length * 1.4),
      LINE_PX,
    );
  });
  const containerH = minimapContainer.offsetHeight,
    editorH = editorWrap.offsetHeight,
    contentH = codeEl.scrollHeight || editorH;
  const vpH = Math.max(6, Math.round(totalH * Math.min(1, editorH / contentH)));
  const cursorY = (getCursorLine() - 1) * LINE_STRIDE;
  let offsetTop = Math.max(
    0,
    Math.min(totalH - containerH, cursorY - containerH / 2),
  );
  minimapCanvas.style.top = -offsetTop + "px";
  const scrollRatio =
    contentH > editorH ? editorWrap.scrollTop / (contentH - editorH) : 0;
  minimapViewport.style.top = scrollRatio * (totalH - vpH) - offsetTop + "px";
  minimapViewport.style.height = vpH + "px";
}
window.addEventListener("resize", updateMinimap);
setTimeout(updateMinimap, 50);