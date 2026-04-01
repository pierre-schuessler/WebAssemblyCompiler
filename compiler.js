function encodeULEB128(v) {
  const b = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    b.push(byte);
  } while (v !== 0);
  return b;
}

const defaultAlign = { i32: 2, i64: 3, f32: 2, f64: 3 };

function encodeWasmInstruction(words) {
  let type = "i32";
  const validTypes = ["empty", "i32", "i64", "f32", "f64"];
  if (words.length > 1 && validTypes.includes(words[1])) {
    type = words[1];
    words.splice(1, 1);
  }
  const op = {
    get: 0x20,
    return: 0x0f,
    drop: 0x1a,
    call: 0x10,
    if: 0x04,
    else: 0x05,
    end: 0x0b,
    add:  { i32: 0x6a, i64: 0x7c, f32: 0x92, f64: 0xa0 },
    sub:  { i32: 0x6b, i64: 0x7d, f32: 0x93, f64: 0xa1 },
    mul:  { i32: 0x6c, i64: 0x7e, f32: 0x94, f64: 0xa2 },
    div:  { i32: 0x6d, i64: 0x7f, f32: 0x95, f64: 0xa3 },
    const: { i32: 0x41, i64: 0x42, f32: 0x43, f64: 0x44 },
    load:     { i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b },
    store:    { i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39 },
    load8_s:  { i32: 0x2c, i64: 0x30 },
    load8_u:  { i32: 0x2d, i64: 0x31 },
    load16_s: { i32: 0x2e, i64: 0x32 },
    load16_u: { i32: 0x2f, i64: 0x33 },
    load32_s: { i64: 0x34 },
    load32_u: { i64: 0x35 },
    store8:   { i32: 0x3a, i64: 0x3c },
    store16:  { i32: 0x3b, i64: 0x3d },
    store32:  { i64: 0x3e },
  };
  const bt = { empty: 0x40, i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

  switch (words[0]) {
    case "get":
      return [op.get, ...encodeULEB128(Number(words[1]))];
    case "const":
      return [op.const[type], ...encodeULEB128(Number(words[1]))];
    case "drop":
      return [op.drop];
    case "call":
      return [op.call, ...encodeULEB128(Number(words[1]))];
    case "if":
      return [op.if, bt[type]];
    case "else":
      return [op.else];
    case "end":
      return [op.end];
    case "add":
    case "sub":
    case "mul":
    case "div":
      return [op[words[0]][type]];
    case "return":
      return [op.return];

    // Memory load instructions
    case "load":
    case "load8_s":
    case "load8_u":
    case "load16_s":
    case "load16_u":
    case "load32_s":
    case "load32_u": {
      const opcode = op[words[0]][type];
      if (opcode == null)
        throw new Error(`Unsupported type '${type}' for '${words[0]}'`);
      const align  = Number(words[1] ?? defaultAlign[type] ?? 2);
      const offset = Number(words[2] ?? 0);
      return [opcode, ...encodeULEB128(align), ...encodeULEB128(offset)];
    }

    // Memory store instructions
    case "store":
    case "store8":
    case "store16":
    case "store32": {
      const opcode = op[words[0]][type];
      if (opcode == null)
        throw new Error(`Unsupported type '${type}' for '${words[0]}'`);
      const align  = Number(words[1] ?? defaultAlign[type] ?? 2);
      const offset = Number(words[2] ?? 0);
      return [opcode, ...encodeULEB128(align), ...encodeULEB128(offset)];
    }

    // Memory size / grow
    case "memory.size":
      return [0x3f, 0x00];
    case "memory.grow":
      return [0x40, 0x00];

    default:
      return [Number(words[0])];
  }
}

export function compile(code) {
  const lines = code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(";"));
  if (!lines.length) return null;

  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  let types     = [],
      functions = [],
      imports   = [],
      exports   = [],
      codes     = [],
      tmp       = [],
      memory    = null;

  const tmap = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

  for (const line of lines) {
    const words = line.split(" ").filter((p) => p.length > 0);
    if (!words.length) continue;

    if (words[0] === "memory") {
      // memory <min> [<max>]
      memory = {
        min: Number(words[1] ?? 1),
        max: words[2] != null ? Number(words[2]) : null,
      };
    } else if (words[0] === "export") {
      if (tmp.length) { codes.push(tmp); tmp = []; }
      let inputs = [], outputs = [], mode = "inputs";
      for (let j = 2; j < words.length; j++) {
        if (words[j] === "=>") { mode = "outputs"; continue; }
        if (tmap[words[j]])
          (mode === "inputs" ? inputs : outputs).push(tmap[words[j]]);
      }
      types.push({ inputs, outputs });
      functions.push(types.length - 1);
      exports.push({ name: words[1] });
    } else if (words[0] === "import") {
      if (tmp.length) { codes.push(tmp); tmp = []; }
      let inputs = [], outputs = [], mode = "inputs";
      for (let j = 3; j < words.length; j++) {
        if (words[j] === "=>") { mode = "outputs"; continue; }
        if (tmap[words[j]])
          (mode === "inputs" ? inputs : outputs).push(tmap[words[j]]);
      }
      types.push({ inputs, outputs });
      imports.push({
        module: words[1],
        name: words[2],
        typeIndex: types.length - 1,
      });
    } else {
      tmp.push(...encodeWasmInstruction(words));
    }
  }
  if (tmp.length) codes.push(tmp);

  // ── Section 1: Type ───────────────────────────────────────────────────────
  bytes.push(0x01);
  let tsl = 1;
  types.forEach((t) => {
    tsl += 1 + 1 + t.inputs.length + 1 + t.outputs.length;
  });
  bytes.push(...encodeULEB128(tsl), types.length);
  types.forEach((t) => {
    bytes.push(0x60, t.inputs.length, ...t.inputs, t.outputs.length, ...t.outputs);
  });

  // ── Section 2: Import ─────────────────────────────────────────────────────
  bytes.push(0x02);
  let isl = 1;
  imports.forEach((i) => {
    isl += 1 + i.module.length + 1 + i.name.length + 2;
  });
  bytes.push(...encodeULEB128(isl), imports.length);
  imports.forEach((imp) => {
    bytes.push(imp.module.length, ...[...imp.module].map((c) => c.charCodeAt(0)));
    bytes.push(imp.name.length,   ...[...imp.name].map((c) => c.charCodeAt(0)));
    bytes.push(0x00, ...encodeULEB128(imp.typeIndex));
  });

  // ── Section 3: Function ───────────────────────────────────────────────────
  bytes.push(0x03, ...encodeULEB128(1 + functions.length), functions.length);
  functions.forEach((f) => bytes.push(...encodeULEB128(f)));

  // ── Section 5: Memory ─────────────────────────────────────────────────────
  if (memory) {
    const hasMax  = memory.max != null;
    const minEnc  = encodeULEB128(memory.min);
    const maxEnc  = hasMax ? encodeULEB128(memory.max) : [];
    // count(1) + limits-flag(1) + min + optional max
    const msl = 1 + 1 + minEnc.length + maxEnc.length;
    bytes.push(0x05, ...encodeULEB128(msl));
    bytes.push(0x01);                   // one memory entry
    bytes.push(hasMax ? 0x01 : 0x00);  // limit type
    bytes.push(...minEnc);
    if (hasMax) bytes.push(...maxEnc);
  }

  // ── Section 7: Export ─────────────────────────────────────────────────────
  if (exports.length) {
    bytes.push(0x07);
    let esl = 1;
    exports.forEach((e) => { esl += 1 + e.name.length + 2; });
    bytes.push(...encodeULEB128(esl), exports.length);
    exports.forEach((e, idx) => {
      bytes.push(e.name.length, ...[...e.name].map((c) => c.charCodeAt(0)));
      bytes.push(0x00, ...encodeULEB128(idx + imports.length));
    });
  }

  // ── Section 10: Code ──────────────────────────────────────────────────────
  bytes.push(0x0a);
  const bodies = codes.map((c) => {
    const b = [0x00, ...c, 0x0b];
    return [...encodeULEB128(b.length), ...b];
  });
  let csl = 1;
  bodies.forEach((b) => (csl += b.length));
  bytes.push(...encodeULEB128(csl), codes.length);
  bodies.forEach((b) => bytes.push(...b));

  const result = new Uint8Array(bytes);
  const meta = {};
  exports.forEach((e, idx) => {
    const typeIdx = functions[idx];
    meta[e.name] = types[typeIdx].inputs.length;
  });
  result.meta = meta;
  return result;
}