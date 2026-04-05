import { compile, test } from "./compiler_v2.js";

// ── INIT ──────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
initUI();
});

function initUI() {
// top bar
document.getElementById("activityEnv")
.addEventListener("click", toggleEnvPanel);

document.getElementById("activityDocs")
.addEventListener("click", toggleDocsPanel);

document.getElementById("docsBack")
.addEventListener("click", showDocsList);

// env form buttons
document.querySelector(".side-panel-add")
.addEventListener("click", () => openForm());

document.querySelector(".env-btn-cancel")
.addEventListener("click", closeForm);

document.querySelector(".env-btn-primary")
.addEventListener("click", saveEnv);

// delegated lists
document.getElementById("docsFileList")
.addEventListener("click", onDocsClick);

document.getElementById("envList")
.addEventListener("click", onEnvClick);

// terminal
termInput.addEventListener("keydown", onTermKey);
document.getElementById("panel")
.addEventListener("click", () => termInput.focus());

// editor
editorWrap.addEventListener("scroll", syncScroll);
codeEl.addEventListener("input", updateLineNumbers);
codeEl.addEventListener("keyup", updateLineNumbers);
codeEl.addEventListener("click", updateLineNumbers);
codeEl.addEventListener("keydown", onEditorKey);

window.addEventListener("resize", updateMinimap);

makeResizable("resizeEnv", "sidePanel", 140, 520, "wasm-env-panel-w");
makeResizable("resizeDocs", "docsPanel", 140, 520, "wasm-docs-panel-w");

renderEnvList();
updateLineNumbers();

print(`<span class="c-info">WASM Assembler ready.</span>`);
print(`<span class="c-muted">make · build · run · hex · clear · help</span>`);
print("");
}

// ── PANEL RESIZE ──────────────────────────────────

function makeResizable(handleId, panelId, minW, maxW, storageKey) {
const handle = document.getElementById(handleId);
const panel = document.getElementById(panelId);
let startX, startW, dragging = false;

const saved = localStorage.getItem(storageKey);
if (saved) panel.style.width = saved + "px";

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
const newW = Math.max(minW, Math.min(maxW, startW + (e.clientX - startX)));
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
(name) => `       <div class="docs-file-item${currentDoc === name ? " active" : ""}" data-name="${name}">         <span class="docs-file-icon">▸</span>         <span class="docs-file-name">${esc(name)}</span>       </div>`
).join("");
}

function onDocsClick(e) {
const item = e.target.closest(".docs-file-item");
if (!item) return;
openDoc(item.dataset.name);
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

viewer.innerHTML = "Loading…";

try {
const res = await fetch(`docs/${name}`);
const text = await res.text();
docsCache[name] = text;
if (currentDoc === name) viewer.innerHTML = renderMarkdown(text);
} catch (err) {
viewer.innerHTML = err.message;
}
}

// ── ENV IMPORTS ───────────────────────────────────

let envImports = [
{ name: "pow", sig: "i32 i32 => i32", body: "return Math.pow(a,b)|0;" },
{ name: "log", sig: "i32 => i32", body: "console.log(a);return a;" }
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
list.innerHTML = '<div class="env-empty">No imports</div>';
return;
}

list.innerHTML = envImports.map((e, i) => `     <div class="env-item" data-index="${i}">       <div>${esc(e.name)}</div>       <button data-action="edit">✎</button>       <button data-action="delete">✕</button>     </div>
  `).join("");
}

function onEnvClick(e) {
const item = e.target.closest(".env-item");
if (!item) return;

const i = Number(item.dataset.index);

if (e.target.dataset.action === "edit") return editEnv(i);
if (e.target.dataset.action === "delete") return deleteEnv(i);

selectEnv(i);
}

function selectEnv(i) {
console.log("selected", i);
}

function openForm(i=null){
editingIdx=i;
document.getElementById("envForm").classList.remove("hidden");
}
function closeForm(){
document.getElementById("envForm").classList.add("hidden");
}
function editEnv(i){openForm(i);}
function deleteEnv(i){
envImports.splice(i,1);
renderEnvList();
}
function saveEnv(){
renderEnvList();
closeForm();
}

// ── TERMINAL ──────────────────────────────────────

const termOutput = document.getElementById("termOutput");
const termInput = document.getElementById("termInput");

function print(html){
const d=document.createElement("div");
d.innerHTML=html;
termOutput.appendChild(d);
}

function onTermKey(e){
if(e.key==="Enter"){
runCommand(termInput.value);
termInput.value="";
}
}

async function runCommand(cmd){
if(cmd==="clear"){termOutput.innerHTML="";return;}
print(cmd);
}

// ── EDITOR ────────────────────────────────────────

const codeEl = document.getElementById("code");
const lineNums = document.getElementById("lineNumbers");
const editorWrap = document.getElementById("editorWrap");

function updateLineNumbers(){
const lines = codeEl.value.split("\n");
lineNums.innerHTML = lines.map((_,i)=>i+1).join("<br>");
updateMinimap();
}

function onEditorKey(e){
if(e.key==="Tab"){
e.preventDefault();
const s=codeEl.selectionStart;
codeEl.value=codeEl.value.slice(0,s)+"  "+codeEl.value.slice(s);
}
}

// ── MINIMAP ───────────────────────────────────────

const minimapCanvas = document.getElementById("minimapCanvas");

function updateMinimap(){
const ctx=minimapCanvas.getContext("2d");
ctx.clearRect(0,0,minimapCanvas.width,minimapCanvas.height);
}

// ── UTILS ─────────────────────────────────────────

function esc(s){
return String(s).replace(/</g,"<");
}
