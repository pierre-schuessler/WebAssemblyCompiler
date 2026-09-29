const KEYWORDS = new Set([
  "endpoint", "internal", "create", "min", "max", "open"
]);

const TYPES = new Set(["int32", "int64", "float32", "float64", "empty"]);

const INSTRUCTIONS = new Set([
  "nop", "return", "end", "call", 
  "local.get", "local.set", "local.tee", 
  "br", "br_if", 
  "memory.grow", "memory.size", 
  "store", "load", "const", 
  "clz", "eqz", "add", "sub", "subtract", "mul"
]);

const SECTION_HEADERS = new Set([
  "// IMPORTS //", "// DECLARATIONS //", "// BODIES //", "// MACROS //"
]);

const STATIC_COMPLETIONS = [
  ...KEYWORDS,
  ...TYPES,
  ...INSTRUCTIONS,
  ...SECTION_HEADERS
];

function tokenizeLine(line) {
  const tokens = [];
  let i = 0;

  const trimmed = line.trim();
  if (SECTION_HEADERS.has(trimmed)) {
    const startIdx = line.indexOf("//");
    if (startIdx > 0) {
      tokens.push({ text: line.slice(0, startIdx), kind: "space" });
    }
    tokens.push({ text: line.slice(startIdx), kind: "section" });
    return tokens;
  }

  while (i < line.length) {
    const ch = line[i];

    if ((ch === "/" && line[i + 1] === "/") || ch === "#") {
      tokens.push({ text: line.slice(i), kind: "comment" });
      break;
    }

    if (ch === '"') {
      const start = i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;
        i++;
      }
      i++;
      tokens.push({ text: line.slice(start, i), kind: "string" });
      continue;
    }

    if (ch === "@") {
      let j = i + 1;
      while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), kind: "decorator" });
      i = j;
      continue;
    }

    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
      tokens.push({ text: line.slice(i, j), kind: "space" });
      i = j;
      continue;
    }

    const prevIsWordChar = i > 0 && /[\w.]/.test(line[i - 1]);
    if (/[0-9]/.test(ch) || (ch === "-" && !prevIsWordChar && /[0-9]/.test(line[i + 1]))) {
      let j = i;
      if (line[j] === "-") j++;
      while (j < line.length && /[0-9._eE+xXa-fA-F]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), kind: "number" });
      i = j;
      continue;
    }

    if ("(){}=><,:".includes(ch)) {
      if (ch === "=" && line[i + 1] === ">") {
        tokens.push({ text: "=>", kind: "punct" });
        i += 2;
      } else {
        tokens.push({ text: ch, kind: "punct" });
        i++;
      }
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_.$/]/.test(line[j])) j++;
      const word = line.slice(i, j);

      let kind = "ident";
      if (KEYWORDS.has(word))      kind = "keyword";
      else if (TYPES.has(word))    kind = "type";
      else if (INSTRUCTIONS.has(word)) kind = "instr";

      tokens.push({ text: word, kind });
      i = j;
      continue;
    }

    tokens.push({ text: ch, kind: "other" });
    i++;
  }

  return tokens;
}

const KIND_COLOR = {
  keyword:   "#c792ea",
  type:      "#82aaff",
  instr:     "#89ddff",
  number:    "#f78c6c",
  string:    "#c3e88d",
  comment:   "#546e7a",
  punct:     "#ffcb6b",
  decorator: "#ff9cac",
  section:   "#ffd700",
  default:   "#ffffff"
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
          const style = kind === "section" ? `color:${color}; font-weight:bold;` : `color:${color}`;
          return color ? `<span style="${style}">${safe}</span>` : `<span style="color:${KIND_COLOR.default}">${safe}</span>`;
        })
        .join("")
    )
    .join("\n");
}

function getWordAtCursor(textarea) {
  const pos = textarea.selectionStart;
  const text = textarea.value;
  let start = pos;
  while (start > 0 && /[\w.#$@]/.test(text[start - 1])) start--;
  return { word: text.slice(start, pos), start, end: pos };
}

function extractUserNames(code) {
  const names = new Set();
  let currentService = "";

  for (const raw of code.split("\n")) {
    const t = raw.trim();

    const sM = t.match(/^@(\w+)/);
    if (sM) {
      currentService = sM[1];
      names.add(`@${currentService}`);
      names.add(currentService);
    }

    const fnM = t.match(/^(?:endpoint|internal)\s+([\w.]+):/);
    if (fnM) {
      names.add(fnM[1]);
      if (currentService && !fnM[1].includes('.')) {
        names.add(`${currentService}.${fnM[1]}`);
      }
    }

    const lM = t.match(/^create\s+(\w+)/);
    if (lM && !KEYWORDS.has(lM[1]) && !TYPES.has(lM[1])) names.add(lM[1]);
  }
  return [...names];
}

function getCandidates(word, code, limit = 12) {
  if (!word) return [];
  const userNames = extractUserNames(code);
  const pool = [...new Set([...STATIC_COMPLETIONS, ...userNames])];
  return pool
    .filter((c) => c !== word && c.toLowerCase().startsWith(word.toLowerCase()))
    .slice(0, limit);
}

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

  const before = textarea.value.slice(0, textarea.selectionStart);
  mirror.textContent = before;

  const sentinel = document.createElement("span");
  sentinel.textContent = "\u200b";
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

export function initEditor(textarea, wrapEl) {

  const overlay = document.createElement("pre");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position:      "absolute",
    inset:         "0",
    margin:        "0",
    padding:       getComputedStyle(textarea).padding,
    font:          getComputedStyle(textarea).font,
    color:         "transparent",
    background:    "transparent",
    pointerEvents: "none",
    whiteSpace:    "pre",
    wordBreak:     "break-all",
    overflowX:     "hidden",
    overflowY:     "hidden",
    zIndex:        "0",
    boxSizing:     "border-box",
    border:        "1px solid transparent",
    tabSize:       getComputedStyle(textarea).tabSize || "4",
  });

  wrapEl.style.position = "relative";
  wrapEl.insertBefore(overlay, textarea);

  Object.assign(textarea.style, {
    position:   "relative",
    zIndex:     "1",
    background: "transparent",
    caretColor: "#ffffff",
    color:      "transparent",
    whiteSpace: "pre",
    wordWrap:   "normal"
  });

  function syncScroll() {
    overlay.scrollTop  = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  }

  function refresh() {
    overlay.innerHTML = highlightCode(textarea.value) + "\n";
    syncScroll();
  }

  textarea.addEventListener("input",  refresh);
  textarea.addEventListener("scroll", syncScroll);
  
  wrapEl.addEventListener("scroll", () => {
    textarea.scrollTop  = wrapEl.scrollTop;
    overlay.scrollTop   = wrapEl.scrollTop;
  });

  refresh();

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
        let color = KIND_COLOR.ident ?? "#cdd6f4";
        if (KEYWORDS.has(c))         color = KIND_COLOR.keyword;
        else if (TYPES.has(c))       color = KIND_COLOR.type;
        else if (INSTRUCTIONS.has(c)) color = KIND_COLOR.instr;
        else if (c.startsWith("@"))  color = KIND_COLOR.decorator;

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

  textarea.addEventListener("input", triggerAutocomplete);

  document.addEventListener("mousedown", (e) => {
    if (!dropdown.contains(e.target) && e.target !== textarea) hideDropdown();
  });
  textarea.addEventListener("click", hideDropdown);

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

  return { refresh };
}