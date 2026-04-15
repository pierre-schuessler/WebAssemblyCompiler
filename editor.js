/**
 * editor.js — Syntax highlighting + autocomplete for the WASM compiler.
 *
 * Usage:
 *   import { initEditor } from "./editor.js";
 *   const editor = initEditor(
 *     document.getElementById("code"),
 *     document.getElementById("editorWrap")
 *   );
 *
 * The editor object exposes:
 *   editor.refresh()   — force re-highlight (call after programmatic value changes)
 */

// ─── Token definitions ────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  "export", "import", "global", "memory", "data", "local", "return", "mut", "#include",
]);

const TYPES = new Set(["i32", "i64", "f32", "f64", "empty"]);

const INSTRUCTIONS = new Set([
  "get", "set", "tee", "global.get", "global.set", "const",
  "nop", "unreachable", "drop", "select",
  "call", "call_indirect",
  "block", "loop", "if", "else", "end",
  "br", "br_if", "br_table",
  "memory.size", "memory.grow", "memory.fill",
  "load", "load8_s", "load8_u", "load16_s", "load16_u", "load32_s", "load32_u",
  "store", "store8", "store16", "store32",
  "add", "sub", "mul", "div", "div_s", "div_u", "rem_s", "rem_u",
  "and", "or", "xor", "shl", "shr_s", "shr_u", "rotl", "rotr",
  "clz", "ctz", "popcnt",
  "abs", "neg", "ceil", "floor", "trunc", "nearest", "sqrt",
  "min", "max", "copysign",
  "eqz", "eq", "ne",
  "lt_s", "lt_u", "lt", "gt_s", "gt_u", "gt",
  "le_s", "le_u", "le", "ge_s", "ge_u", "ge",
  "i32.wrap", "i32.trunc_s_f32", "i32.trunc_u_f32", "i32.trunc_s_f64", "i32.trunc_u_f64", "i32.reinterpret",
  "i64.extend_s", "i64.extend_u", "i64.trunc_s_f32", "i64.trunc_u_f32", "i64.trunc_s_f64", "i64.trunc_u_f64", "i64.reinterpret",
  "f32.convert_s_i32", "f32.convert_u_i32", "f32.convert_s_i64", "f32.convert_u_i64", "f32.demote", "f32.reinterpret",
  "f64.convert_s_i32", "f64.convert_u_i32", "f64.convert_s_i64", "f64.convert_u_i64", "f64.promote", "f64.reinterpret",
]);

// All completions available statically (dynamic user names are added at query time)
const STATIC_COMPLETIONS = [
  ...KEYWORDS,
  ...TYPES,
  ...INSTRUCTIONS,
];


// ─── Tokeniser ────────────────────────────────────────────────────────────────

/**
 * Tokenises a single line into [{text, kind}] tokens.
 * Kinds: keyword | type | instr | number | string | comment | punct | ident
 */
function tokenizeLine(line) {
  const tokens = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    // Comment — rest of line
    if (ch === "/" && line[i + 1] === "/") {
      tokens.push({ text: line.slice(i), kind: "comment" });
      break;
    }

    // Double-quoted string / numeric literal (e.g. "42", 64"3.14")
    if (ch === '"' || (ch === '6' && line[i + 1] === '4' && line[i + 2] === '"')) {
      const start = i;
      if (line[i] !== '"') i += 2;   // skip 64 prefix
      i++;                            // skip opening "
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;   // skip escaped char
        i++;
      }
      i++;                            // skip closing "
      tokens.push({ text: line.slice(start, i), kind: "string" });
      continue;
    }

    // Single-quoted string literal  'hello\nworld'
    if (ch === "'") {
      const start = i++;
      while (i < line.length && line[i] !== "'") {
        if (line[i] === "\\") i++;
        i++;
      }
      i++;
      tokens.push({ text: line.slice(start, i), kind: "string" });
      continue;
    }

    // #include
    if (ch === "#") {
      const end = line.indexOf(" ", i);
      const word = end === -1 ? line.slice(i) : line.slice(i, end);
      tokens.push({ text: word, kind: KEYWORDS.has(word) ? "keyword" : "ident" });
      i += word.length;
      continue;
    }

    // Whitespace — pass through unstyled
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
      tokens.push({ text: line.slice(i, j), kind: "space" });
      i = j;
      continue;
    }

    // Number  (starts with digit, or minus followed by digit at word boundary)
    const prevIsWordChar = i > 0 && /[\w.]/.test(line[i - 1]);
    if (/[0-9]/.test(ch) || (ch === "-" && !prevIsWordChar && /[0-9]/.test(line[i + 1]))) {
      let j = i;
      if (line[j] === "-") j++;
      while (j < line.length && /[0-9._eE+xXa-fA-F]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), kind: "number" });
      i = j;
      continue;
    }

    // Punctuation
    if ("()=>,".includes(ch)) {
      // Treat => as a single token
      if (ch === "=" && line[i + 1] === ">") {
        tokens.push({ text: "=>", kind: "punct" });
        i += 2;
      } else {
        tokens.push({ text: ch, kind: "punct" });
        i++;
      }
      continue;
    }

    // Word — may contain dots (e.g. global.get, f32.convert_s_i32)
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_.$/]/.test(line[j])) j++;
      const word = line.slice(i, j);

      let kind = "ident";
      if (KEYWORDS.has(word))     kind = "keyword";
      else if (TYPES.has(word))   kind = "type";
      else if (INSTRUCTIONS.has(word)) kind = "instr";

      tokens.push({ text: word, kind });
      i = j;
      continue;
    }

    // Fallback — emit as-is
    tokens.push({ text: ch, kind: "other" });
    i++;
  }

  return tokens;
}


// ─── Highlighting ─────────────────────────────────────────────────────────────

// Color palette uses CSS custom properties so the host page can override them.
const KIND_COLOR = {
  keyword: "var(--hl-keyword, #c792ea)",
  type:    "var(--hl-type,    #82aaff)",
  instr:   "var(--hl-instr,  #89ddff)",
  number:  "var(--hl-number, #f78c6c)",
  string:  "var(--hl-string, #c3e88d)",
  comment: "var(--hl-comment,#546e7a)",
  punct:   "var(--hl-punct,  #ffcb6b)",
  default: "var(--hl-default, white)"
};

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightCode(code) {
  return code
    .split("\n")
    .map((line) =>
      tokenizeLine(line)
        .map(({ text, kind }) => {
          const color = KIND_COLOR[kind];
          const safe = escHtml(text);
          return color ? `<span style="color:${color}">${safe}</span>` : `<span style="${KIND_COLOR.default}">${safe}</span>`;
        })
        .join("")
    )
    .join("\n");
}


// ─── Autocomplete ─────────────────────────────────────────────────────────────

/** Extract the identifier fragment immediately before the cursor. */
function getWordAtCursor(textarea) {
  const pos = textarea.selectionStart;
  const text = textarea.value;
  let start = pos;
  while (start > 0 && /[\w.#$]/.test(text[start - 1])) start--;
  return { word: text.slice(start, pos), start, end: pos };
}

/** Scan the code for user-defined names (exported fns, globals, local vars). */
function extractUserNames(code) {
  const names = new Set();
  for (const raw of code.split("\n")) {
    const t = raw.trim();

    // export / import function names
    const fnM = t.match(/^(?:export|import)\s+(\w+)/);
    if (fnM) names.add(fnM[1]);

    // global <type> [mut] <name>
    const gM = t.match(/^global\s+(?:mut\s+)?(?:i32|i64|f32|f64)\s+(\w+)/);
    if (gM) names.add(gM[1]);

    // local variable declarations or assignments  name = ...
    const lM = t.match(/^(?:\w+\s+)?(\w+)\s*=/);
    if (lM && !KEYWORDS.has(lM[1]) && !TYPES.has(lM[1])) names.add(lM[1]);
  }
  return [...names];
}

/**
 * Return up to `limit` completions that start with `word` (case-sensitive).
 * User-defined names are merged with the static list and deduplicated.
 */
function getCandidates(word, code, limit = 12) {
  if (!word) return [];
  const userNames = extractUserNames(code);
  const pool = [...new Set([...STATIC_COMPLETIONS, ...userNames])];
  return pool
    .filter((c) => c !== word && c.toLowerCase().startsWith(word.toLowerCase()))
    .slice(0, limit);
}


// ─── Cursor pixel-position helper ────────────────────────────────────────────

/**
 * Returns an {left, bottom} rect (viewport-relative) for the textarea cursor.
 * Uses a hidden mirror div that replicates the textarea's layout.
 */
function getCursorRect(textarea) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");

  const copyProps = [
    "font", "fontSize", "fontFamily", "fontWeight", "lineHeight",
    "letterSpacing", "padding", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "border", "boxSizing",
    "whiteSpace", "wordBreak", "wordWrap", "width",
  ];
  copyProps.forEach((p) => { mirror.style[p] = style[p]; });

  Object.assign(mirror.style, {
    position:   "absolute",
    visibility: "hidden",
    top:        "-9999px",
    left:       "-9999px",
    whiteSpace: "pre-wrap",
    overflow:   "hidden",
  });

  document.body.appendChild(mirror);

  // Text before cursor
  const before = textarea.value.slice(0, textarea.selectionStart);
  mirror.textContent = before;

  // Sentinel span at cursor
  const sentinel = document.createElement("span");
  sentinel.textContent = "\u200b"; // zero-width space
  mirror.appendChild(sentinel);

  const taRect  = textarea.getBoundingClientRect();
  const mRect   = mirror.getBoundingClientRect();
  const sRect   = sentinel.getBoundingClientRect();

  document.body.removeChild(mirror);

  const relX = sRect.left - mRect.left - textarea.scrollLeft;
  const relY = sRect.top  - mRect.top  - textarea.scrollTop;
  const lineH = parseFloat(style.lineHeight) || 16;

  return {
    left:   taRect.left + relX + (parseFloat(style.paddingLeft) || 0),
    bottom: taRect.top  + relY + (parseFloat(style.paddingTop)  || 0) + lineH,
  };
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the editor enhancements on an existing <textarea>.
 *
 * @param {HTMLTextAreaElement} textarea  The code textarea (id="code").
 * @param {HTMLElement}         wrapEl    Its scroll-wrapper (id="editorWrap").
 * @returns {{ refresh: () => void }}
 */
export function initEditor(textarea, wrapEl) {

  // ── 1. Highlight overlay ───────────────────────────────────────────────────

  const overlay = document.createElement("pre");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position:     "absolute",
    inset:        "0",
    margin:       "0",
    padding:      getComputedStyle(textarea).padding,
    font:         getComputedStyle(textarea).font,
    color:        "transparent",   // text is invisible; only spans show colour
    background:   "transparent",
    pointerEvents: "none",
    whiteSpace:   "pre-wrap",
    wordBreak:    "break-all",
    overflowX:    "hidden",
    overflowY:    "hidden",
    zIndex:       "0",
    boxSizing:    "border-box",
    border:       "1px solid transparent",
    tabSize:      getComputedStyle(textarea).tabSize || "4",
  });

  // The wrapper must be the scroll container with overflow:hidden/auto
  wrapEl.style.position = "relative";
  wrapEl.insertBefore(overlay, textarea);

  // Make the textarea sit above the overlay, with transparent background
  Object.assign(textarea.style, {
    position:   "relative",
    zIndex:     "1",
    background: "transparent",
    caretColor: "#ffffff",
    color:      "transparent",
  });

  function syncScroll() {
    overlay.scrollTop  = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  }

  function refresh() {
    console.log("Refreshed the editor")
    overlay.innerHTML = highlightCode(textarea.value) + "\n";
    syncScroll();
  }

  textarea.addEventListener("input",  refresh);
  textarea.addEventListener("scroll", syncScroll);
  // Also sync on external scroll (e.g. the editorWrap scrollbar)
  wrapEl.addEventListener("scroll", () => {
    textarea.scrollTop  = wrapEl.scrollTop;
    overlay.scrollTop   = wrapEl.scrollTop;
  });

  refresh(); // initial paint


  // ── 2. Autocomplete dropdown ───────────────────────────────────────────────

  const dropdown = document.createElement("div");
  dropdown.id = "acDropdown";
  Object.assign(dropdown.style, {
    position:   "fixed",
    zIndex:     "9999",
    background: "#1a1a2e",
    border:     "1px solid #3a3a5c",
    borderRadius: "5px",
    fontFamily: "monospace",
    fontSize:   "13px",
    maxHeight:  "192px",
    overflowY:  "auto",
    display:    "none",
    boxShadow:  "0 6px 24px rgba(0,0,0,.6)",
    minWidth:   "160px",
    padding:    "3px 0",
  });
  document.body.appendChild(dropdown);

  let acCandidates = [];
  let acIndex = -1;

  function renderDropdown(candidates, rect) {
    acCandidates = candidates;
    acIndex = 0;

    dropdown.innerHTML = candidates
      .map((c, i) => {
        // Figure out which colour to give the item text
        let color = KIND_COLOR.ident ?? "#cdd6f4";
        if (KEYWORDS.has(c))     color = KIND_COLOR.keyword;
        else if (TYPES.has(c))   color = KIND_COLOR.type;
        else if (INSTRUCTIONS.has(c)) color = KIND_COLOR.instr;

        return `<div class="ac-item" data-i="${i}" style="
          padding: 3px 12px;
          cursor: pointer;
          color: ${color};
          white-space: nowrap;
          ${i === 0 ? "background:#2a2a4a;" : ""}
        ">${escHtml(c)}</div>`;
      })
      .join("");

    Object.assign(dropdown.style, {
      display: "block",
      left:    rect.left + "px",
      top:     rect.bottom + 4 + "px",
    });

    dropdown.querySelectorAll(".ac-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyCompletion(acCandidates[+el.dataset.i]);
      });
    });
  }

  function updateActiveItem() {
    dropdown.querySelectorAll(".ac-item").forEach((el, i) => {
      const active = i === acIndex;
      el.style.background = active ? "#2a2a4a" : "";
      if (active) el.scrollIntoView({ block: "nearest" });
    });
  }

  function hideDropdown() {
    dropdown.style.display = "none";
    acCandidates = [];
    acIndex = -1;
  }

  function applyCompletion(completion) {
    const { start, end } = getWordAtCursor(textarea);
    const before = textarea.value.slice(0, start);
    const after  = textarea.value.slice(end);
    textarea.value = before + completion + after;
    const cur = start + completion.length;
    textarea.selectionStart = textarea.selectionEnd = cur;
    hideDropdown();
    refresh();
    // Let host code react (line number update, minimap, etc.)
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function triggerAutocomplete() {
    const { word } = getWordAtCursor(textarea);
    if (word.length < 1) { hideDropdown(); return; }

    const candidates = getCandidates(word, textarea.value);
    if (!candidates.length) { hideDropdown(); return; }

    const rect = getCursorRect(textarea);
    renderDropdown(candidates, rect);
  }

  // Show suggestions as the user types
  textarea.addEventListener("input", triggerAutocomplete);

  // Hide on click-away
  document.addEventListener("mousedown", (e) => {
    if (!dropdown.contains(e.target) && e.target !== textarea) hideDropdown();
  });
  textarea.addEventListener("click", hideDropdown);

  // Keyboard navigation inside the dropdown
  textarea.addEventListener("keydown", (e) => {
    if (dropdown.style.display === "none") return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      acIndex = Math.min(acIndex + 1, acCandidates.length - 1);
      updateActiveItem();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      acIndex = Math.max(acIndex - 1, 0);
      updateActiveItem();
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (acCandidates.length > 0) {
        e.preventDefault();
        applyCompletion(acCandidates[acIndex]);
      }
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  });


  // ── 3. Public surface ──────────────────────────────────────────────────────
  return { refresh };
}