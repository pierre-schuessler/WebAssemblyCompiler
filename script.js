import { compile, test } from "./compiler.js";

// ── PANEL RESIZE ──────────────────────────────────

function makeResizable(handleId, panelId, minW, maxW, storageKey) {
  const handle = document.getElementById(handleId);
  const panel = document.getElementById(panelId);
  let startX,
    startW,
    dragging = false;

  // restore saved width
  const saved = localStorage.getItem(storageKey);
  if (saved) panel.style.width = saved + "px";

  handle.addEventListener("mousedown", (e) => {
    // only resize when panel is open
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

// ── DOCS ──────────────────────────────────────────

const DOC_FILES = ["language.md", "examples.md"];

const docsCache = {};
let currentDoc = null;

function toggleDocsPanel() {
  const panel = document.getElementById("docsPanel");
  const btn = document.getElementById("activityDocs");
  const open = panel.classList.toggle("collapsed") === false;
  btn.classList.toggle("active", open);
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
  list.innerHTML = DOC_FILES.map(
    (name) => `
        <div class="docs-file-item${currentDoc === name ? " active" : ""}" data-doc="${esc(name)}">
            <span class="docs-file-icon">▸</span>
            <span class="docs-file-name">${esc(name)}</span>
        </div>`,
  ).join("");

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
    // Escape HTML inside the code block now, before the global escape pass
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

// ── ENV IMPORTS ───────────────────────────────────

let envImports = [
  {
    name: "pow",
    sig: "i32 i32 => i32",
    body: "return Math.pow(a, b)|0;",
  },
  { name: "log", sig: "i32 => i32", body: "console.log(a); return a;" },
  { name: "putchar", sig: "i32", body: `
      if (a === 0) {
        console.stdout(window.message);
        window.message = "";
        return;
  }
      if (window.message) {
        window.message += String.fromCharCode(a);
      } else {
        window.message = String.fromCharCode(a);
      }`}
];
let editingIdx = null;

function toggleEnvPanel() {
  const panel = document.getElementById("sidePanel");
  const btn = document.getElementById("activityEnv");
  const collapsed = panel.classList.toggle("collapsed");
  btn.classList.toggle("active", !collapsed);
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
  const env = {},
    argNames = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (const imp of envImports) {
    const parts = imp.sig.split("=>")[0].trim().split(/\s+/).filter(Boolean);
    const args = argNames.slice(0, parts.length);
    try {
      env[imp.name] = new Function(...args, imp.body || "return 0;");
    } catch (err) {
      throw new Error(`env.${imp.name}: ${err.message}`);
    }
  }
  return env;
}

// ── ACTIVITY BAR ──────────────────────────────────

document.getElementById("activityEnv").addEventListener("click", toggleEnvPanel);
document.getElementById("activityDocs").addEventListener("click", toggleDocsPanel);

// ── ENV FORM BUTTONS ──────────────────────────────

document.getElementById("envAddBtn").addEventListener("click", () => openForm());
document.getElementById("envCancelBtn").addEventListener("click", closeForm);
document.getElementById("envSaveBtn").addEventListener("click", saveEnv);

// ── DOCS BACK BUTTON ──────────────────────────────

document.getElementById("docsBack").addEventListener("click", showDocsList);

renderEnvList();

// ── TERMINAL ──────────────────────────────────────

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

console.stdout = print;

print(`<span class="c-info">WASM Compiler ready.</span>`);
print(
  `<span class="c-muted">make · build · run &lt;fn&gt; [args] · hex · clear · help</span>`,
);
print("");

async function runCommand(raw, isInternal = false) {
  const cmd = raw.trim();
  if (!cmd) return;

  // Only update history and print the prompt if it's a real user command
  if (!isInternal) {
    cmdHistory.unshift(cmd);
    histIdx = -1;
    print(`<span class="c-prompt"> $ </span>${esc(cmd)}`);
  }

  const parts = cmd.split(/\s+/),
    verb = parts[0].toLowerCase();

  if (verb === "help") {
    print(`<span class="c-muted">  make [args]   — compile &amp; test exports with given args (padded with 0s)</span>`);
    print(`<span class="c-muted">  build         — compile only</span>`);
    print(`<span class="c-muted">  run fn [args] — call exported function</span>`);
    print(`<span class="c-muted">  hex           — full hex dump of binary</span>`);
    print(`<span class="c-muted">  clear         — clear terminal</span>`);
  } 
  
  else if (verb === "clear") {
    termOutput.innerHTML = "";
  } 
  
  else if (verb === "build") {
    const code = document.getElementById("code").value;
    if (!code.trim()) {
      print(`<span class="c-err">editor is empty</span>`);
      return;
    }
    
    print(`<span class="c-muted">compiling…</span>`);
    
    try {
      const binary = compile(code);
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
    // 1. Recursively call build
    await runCommand("build", true);
    
    // 2. If build failed or there's no instance, bail out
    if (!lastInstance) return;

    // 3. Loop through exports and recursively call run
    const supplied = parts.slice(1).map(Number);
    const exps = Object.keys(lastInstance.exports);
    
    for (const fn of exps) {
      if (typeof lastInstance.exports[fn] !== "function") continue;
      
      const needed = lastMeta[fn] ?? supplied.length;
      const testArgs = Array.from({ length: needed }, (_, i) =>
        i < supplied.length ? supplied[i] : 0,
      );
      
      // Pass execution logic entirely to "run"
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
      const r = func(...args);
      print(`<span class="c-muted">  ${esc(fn)}(${args.join(", ")}) → </span><span class="c-ok">${r}</span>`);
    } catch (e) {
      print(`<span class="c-err">✗ ${esc(e.message)}</span>`);
    }
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
      if ((i + 1) % 16 === 0) {
        print(`<span class="c-hex">${row}</span>`);
        row = "";
      }
    }
    if (row) print(`<span class="c-hex">${row}</span>`);
  } 
  
  else {
    print(`<span class="c-err">✗ unknown command: ${esc(verb)}</span>`);
  }

  // Only print the trailing empty line for actual user inputs
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

// ── EDITOR ────────────────────────────────────────

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

// ── MINIMAP ───────────────────────────────────────

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