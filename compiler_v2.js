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

function encodeSLEB128(v) {
  const b = [];
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0))
      more = false;
    else
      byte |= 0x80;
    b.push(byte);
  }
  return b;
}

function encodeF32(v) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, true);
  return [...new Uint8Array(buf)];
}

function encodeF64(v) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, v, true);
  return [...new Uint8Array(buf)];
}

function encodeWasmInstruction(words) {
  // Strip optional type qualifier from position 1 (e.g. "add i32" → type="i32")
  let type = "i32";
  const validTypes = ["empty", "i32", "i64", "f32", "f64"];
  if (words.length > 1 && validTypes.includes(words[1])) {
    type = words[1];
    words.splice(1, 1);
  }

  const bt = { empty: 0x40, i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

  // ── Arithmetic ──────────────────────────────────────────────────────────────
  const arith = {
    add:      { i32: 0x6a, i64: 0x7c, f32: 0x92, f64: 0xa0 },
    sub:      { i32: 0x6b, i64: 0x7d, f32: 0x93, f64: 0xa1 },
    mul:      { i32: 0x6c, i64: 0x7e, f32: 0x94, f64: 0xa2 },
    div:      { i32: 0x6d, i64: 0x7f, f32: 0x95, f64: 0xa3 },
    div_s:    { i32: 0x6d, i64: 0x7f },
    div_u:    { i32: 0x6e, i64: 0x80 },
    rem_s:    { i32: 0x6f, i64: 0x81 },
    rem_u:    { i32: 0x70, i64: 0x82 },
    and:      { i32: 0x71, i64: 0x83 },
    or:       { i32: 0x72, i64: 0x84 },
    xor:      { i32: 0x73, i64: 0x85 },
    shl:      { i32: 0x74, i64: 0x86 },
    shr_s:    { i32: 0x75, i64: 0x87 },
    shr_u:    { i32: 0x76, i64: 0x88 },
    rotl:     { i32: 0x77, i64: 0x89 },
    rotr:     { i32: 0x78, i64: 0x8a },
    clz:      { i32: 0x67, i64: 0x79 },
    ctz:      { i32: 0x68, i64: 0x7a },
    popcnt:   { i32: 0x69, i64: 0x7b },
    abs:      { f32: 0x8b, f64: 0x99 },
    neg:      { f32: 0x8c, f64: 0x9a },
    ceil:     { f32: 0x8d, f64: 0x9b },
    floor:    { f32: 0x8e, f64: 0x9c },
    trunc:    { f32: 0x8f, f64: 0x9d },
    nearest:  { f32: 0x90, f64: 0x9e },
    sqrt:     { f32: 0x91, f64: 0x9f },
    min:      { f32: 0x96, f64: 0xa4 },
    max:      { f32: 0x97, f64: 0xa5 },
    copysign: { f32: 0x98, f64: 0xa6 },
  };

  // ── Comparisons ────────────────────────────────────────────────────────────
  const cmp = {
    eqz:  { i32: 0x45, i64: 0x50 },
    eq:   { i32: 0x46, i64: 0x51, f32: 0x5b, f64: 0x61 },
    ne:   { i32: 0x47, i64: 0x52, f32: 0x5c, f64: 0x62 },
    lt_s: { i32: 0x48, i64: 0x53 },
    lt_u: { i32: 0x49, i64: 0x54 },
    lt:   { f32: 0x5d, f64: 0x63 },
    gt_s: { i32: 0x4a, i64: 0x55 },
    gt_u: { i32: 0x4b, i64: 0x56 },
    gt:   { f32: 0x5e, f64: 0x64 },
    le_s: { i32: 0x4c, i64: 0x57 },
    le_u: { i32: 0x4d, i64: 0x58 },
    le:   { f32: 0x5f, f64: 0x65 },
    ge_s: { i32: 0x4e, i64: 0x59 },
    ge_u: { i32: 0x4f, i64: 0x5a },
    ge:   { f32: 0x60, f64: 0x66 },
  };

  // ── Type Conversions ────────────────────────────────────────────────────────
  const conv = {
    "i32.wrap":          0xa7,
    "i32.trunc_s_f32":   0xa8,
    "i32.trunc_u_f32":   0xa9,
    "i32.trunc_s_f64":   0xaa,
    "i32.trunc_u_f64":   0xab,
    "i64.extend_s":      0xac,
    "i64.extend_u":      0xad,
    "i64.trunc_s_f32":   0xae,
    "i64.trunc_u_f32":   0xaf,
    "i64.trunc_s_f64":   0xb0,
    "i64.trunc_u_f64":   0xb1,
    "f32.convert_s_i32": 0xb2,
    "f32.convert_u_i32": 0xb3,
    "f32.convert_s_i64": 0xb4,
    "f32.convert_u_i64": 0xb5,
    "f32.demote":        0xb6,
    "f64.convert_s_i32": 0xb7,
    "f64.convert_u_i32": 0xb8,
    "f64.convert_s_i64": 0xb9,
    "f64.convert_u_i64": 0xba,
    "f64.promote":       0xbb,
    "i32.reinterpret":   0xbc,
    "i64.reinterpret":   0xbd,
    "f32.reinterpret":   0xbe,
    "f64.reinterpret":   0xbf,
  };

  const instr = words[0];

  if (conv[instr] != null) return [conv[instr]];

  switch (instr) {
    // ── Locals ───────────────────────────────────────────────────────────────
    case "get": return [0x20, ...encodeULEB128(Number(words[1]))];
    case "set": return [0x21, ...encodeULEB128(Number(words[1]))];
    case "tee": return [0x22, ...encodeULEB128(Number(words[1]))];

    // ── Globals ──────────────────────────────────────────────────────────────
    case "global.get": return [0x23, ...encodeULEB128(Number(words[1]))];
    case "global.set": return [0x24, ...encodeULEB128(Number(words[1]))];

    // ── Constants ────────────────────────────────────────────────────────────
    case "const": {
      const v = Number(words[1]);
      if (type === "f32") return [0x43, ...encodeF32(v)];
      if (type === "f64") return [0x44, ...encodeF64(v)];
      if (type === "i64") return [0x42, ...encodeSLEB128(v)];
      return              [0x41, ...encodeSLEB128(v)];
    }

    // ── Control Flow ─────────────────────────────────────────────────────────
    case "nop":           return [0x01];
    case "unreachable":   return [0x00];
    case "return":        return [0x0f];
    case "drop":          return [0x1a];
    case "select":        return [0x1b];
    case "call":          return [0x10, ...encodeULEB128(Number(words[1]))];
    case "call_indirect": return [0x11, ...encodeULEB128(Number(words[1])), 0x00];

    // ── Block Structures ─────────────────────────────────────────────────────
    case "block": return [0x02, bt[type]];
    case "loop":  return [0x03, bt[type]];
    case "if":    return [0x04, bt[type]];
    case "else":  return [0x05];
    case "end":   return [0x0b];

    // ── Branches ─────────────────────────────────────────────────────────────
    case "br":    return [0x0c, ...encodeULEB128(Number(words[1]))];
    case "br_if": return [0x0d, ...encodeULEB128(Number(words[1]))];
    case "br_table": {
      const targets = words.slice(1).map(Number);
      const def = targets.pop();
      return [
        0x0e,
        ...encodeULEB128(targets.length),
        ...targets.flatMap(encodeULEB128),
        ...encodeULEB128(def),
      ];
    }

    // ── Memory Loads ─────────────────────────────────────────────────────────
    case "load":
    case "load8_s":
    case "load8_u":
    case "load16_s":
    case "load16_u":
    case "load32_s":
    case "load32_u": {
      const ops = {
        load:     { i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b },
        load8_s:  { i32: 0x2c, i64: 0x30 },
        load8_u:  { i32: 0x2d, i64: 0x31 },
        load16_s: { i32: 0x2e, i64: 0x32 },
        load16_u: { i32: 0x2f, i64: 0x33 },
        load32_s: { i64: 0x34 },
        load32_u: { i64: 0x35 },
      };
      const opcode = ops[instr][type];
      if (opcode == null) throw new Error(`Unsupported type '${type}' for '${instr}'`);
      const defaultAlign = { i32: 2, i64: 3, f32: 2, f64: 3 };
      return [
        opcode,
        ...encodeULEB128(Number(words[1] ?? defaultAlign[type] ?? 2)),
        ...encodeULEB128(Number(words[2] ?? 0)),
      ];
    }

    // ── Memory Stores ────────────────────────────────────────────────────────
    case "store":
    case "store8":
    case "store16":
    case "store32": {
      const ops = {
        store:   { i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39 },
        store8:  { i32: 0x3a, i64: 0x3c },
        store16: { i32: 0x3b, i64: 0x3d },
        store32: { i64: 0x3e },
      };
      const opcode = ops[instr][type];
      if (opcode == null) throw new Error(`Unsupported type '${type}' for '${instr}'`);
      const defaultAlign = { i32: 2, i64: 3, f32: 2, f64: 3 };
      return [
        opcode,
        ...encodeULEB128(Number(words[1] ?? defaultAlign[type] ?? 2)),
        ...encodeULEB128(Number(words[2] ?? 0)),
      ];
    }

    // ── Memory Management ────────────────────────────────────────────────────
    case "memory.size": return [0x3f, 0x00];
    case "memory.grow": return [0x40, 0x00];

    // ── Arithmetic & Comparisons (table lookup) ───────────────────────────────
    default: {
      if (arith[instr]?.[type] != null) return [arith[instr][type]];
      if (cmp[instr]?.[type]   != null) return [cmp[instr][type]];
      return [Number(instr)]; // raw opcode fallback
    }
  }
}




const TYPEMAP = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

function preprocess(code){
    const lines = code
    .split("\n")
    .map((l) => l.replace(/;.*$/, "").trim()) // strip inline comments
    .filter((l) => l.length > 0);
    return lines;
}

function process(words, tmp, types){
    const resolved = [...words];
    if (["get", "set", "tee"].includes(resolved[0]) && isNaN(Number(resolved[1]))) {
        const paramCount = types[types.length - 1].inputs.length;
        const idx = tmp.locals.findIndex(([name]) => name === resolved[1]);
        if (idx === -1) throw new Error(`Unknown local: '${resolved[1]}'`);
        resolved[1] = String(paramCount + idx);
    }
    return resolved;
}


export function compile(code) {

  const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // magic + version
  let types    = [],  // [{inputs: [valtype], outputs: [valtype]}]
      functions= [],  // type index for each defined function
      imports  = [],  // [{module, name, typeIndex}]
      exports  = [],  // [{name}]
      codes    = [],  // [{locals: [[name, valtype]], binary: []}]
      globals  = [],  // [{gtype, mutable, initbinary}]
      dataSegs = [],  // [{offset, binary}]
      memory   = null,
      tmp      = null; // function body currently being assembled

  function flushTmp() {
    if (tmp) {
      tmp.binary.push(0x0b); // implicit end
      codes.push({ locals: tmp.locals, binary: tmp.binary });
      tmp = null;
    }
  }

  const lines = preprocess(code);
  if (!lines.length) console.warn("[WebAssemblyCompiler] Compiler was called without any code.");

  for (const line of lines) {
    const words = line.split(/\s+/).filter((p) => p.length > 0);
    const verb = words[0];
    switch (verb) {
      case "memory": {
        const parts = words[1]?.split("-");
        if (!parts) break;
        const min = Number(parts[0]);
        const max = parts[1] != null ? Number(parts[1]) : null;
        if (isNaN(min) || min < 0) throw new Error(`Invalid memory min: '${parts[0]}'`);
        if (max !== null && (isNaN(max) || max < min)) throw new Error(`Invalid memory max: '${parts[1]}'`);
        memory = { min, max };
        break;
      }
      case "global": {
        break;
      }
      case "data": {
        break;
      }
      case "export": {
        flushTmp();
        let inputs = [], outputs = [], mode = "inputs";
        for (let j = 2; j < words.length; j++) {
          if (words[j] === "=>")              { mode = "outputs"; continue; }
          if (TYPEMAP[words[j]] != null) {
            if      (mode === "inputs")  inputs.push(TYPEMAP[words[j]]);
            else if (mode === "outputs") outputs.push(TYPEMAP[words[j]]);
          }
        }
        types.push({ inputs, outputs });
        functions.push(types.length - 1);
        exports.push({ name: words[1] });
        tmp = { locals: [], binary: [] };
        break;
      }
      case "local": {
        if (tmp) {
          const valtype = TYPEMAP[words[words.length - 1]];
          const name = words.length > 2 ? words[1] : `$${tmp.locals.length}`;
          if (valtype == null) throw new Error(`Unknown local type: ${words[words.length - 1]}`);
          tmp.locals.push([name, valtype]);
        }
        break;
      }
      default: {
        if (tmp) {
            // resolve named locals to their index
            
            tmp.binary.push(...encodeWasmInstruction(process(words, tmp, types)));
        }
        break;
        }
    }
  }
  flushTmp();

  // ── Section 1: Type ───────────────────────────────────────────────────────
  {
    binary.push(0x01);
    let size = encodeULEB128(types.length).length;
    types.forEach((t) => { size += 1 + 1 + t.inputs.length + 1 + t.outputs.length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(types.length));
    types.forEach((t) => {
      binary.push(0x60, t.inputs.length, ...t.inputs, t.outputs.length, ...t.outputs);
    });
  }

  // ── Section 2: Import ─────────────────────────────────────────────────────
  {
    binary.push(0x02);
    let size = encodeULEB128(imports.length).length;
    imports.forEach((imp) => {
      size += 1 + imp.module.length + 1 + imp.name.length + 1
              + encodeULEB128(imp.typeIndex).length;
    });
    binary.push(...encodeULEB128(size), ...encodeULEB128(imports.length));
    imports.forEach((imp) => {
      binary.push(imp.module.length, ...[...imp.module].map((c) => c.charCodeAt(0)));
      binary.push(imp.name.length,   ...[...imp.name  ].map((c) => c.charCodeAt(0)));
      binary.push(0x00, ...encodeULEB128(imp.typeIndex));
    });
  }

  // ── Section 3: Function ───────────────────────────────────────────────────
  {
    binary.push(0x03);
    let size = encodeULEB128(functions.length).length;
    functions.forEach((f) => { size += encodeULEB128(f).length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(functions.length));
    functions.forEach((f) => binary.push(...encodeULEB128(f)));
  }

  // ── Section 5: Memory ─────────────────────────────────────────────────────
  if (memory) {
    const hasMax = memory.max != null;
    const minEnc = encodeULEB128(memory.min);
    const maxEnc = hasMax ? encodeULEB128(memory.max) : [];
    const size   = 1 + 1 + minEnc.length + maxEnc.length;
    binary.push(0x05, ...encodeULEB128(size));
    binary.push(0x01, hasMax ? 0x01 : 0x00, ...minEnc);
    if (hasMax) binary.push(...maxEnc);
  }

  // ── Section 6: Global ─────────────────────────────────────────────────────
  if (globals.length) {
    binary.push(0x06);
    let size = encodeULEB128(globals.length).length;
    globals.forEach((g) => { size += 2 + g.initbinary.length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(globals.length));
    globals.forEach((g) => {
      binary.push(g.gtype, g.mutable ? 0x01 : 0x00, ...g.initbinary);
    });
  }

  // ── Section 7: Export ─────────────────────────────────────────────────────
  if (exports.length) {
    binary.push(0x07);
    let size = encodeULEB128(exports.length).length;
    exports.forEach((e, idx) => {
      size += 1 + e.name.length + 1 + encodeULEB128(idx + imports.length).length;
    });
    binary.push(...encodeULEB128(size), ...encodeULEB128(exports.length));
    exports.forEach((e, idx) => {
      binary.push(e.name.length, ...[...e.name].map((c) => c.charCodeAt(0)));
      binary.push(0x00, ...encodeULEB128(idx + imports.length));
    });
  }

  // ── Section 10: Code ──────────────────────────────────────────────────────
  {
    binary.push(0x0a);

    const bodies = codes.map((fn) => {
      const localValues = fn.locals.map(([_, valtype]) => valtype);

      const groups = [];
      let i = 0;
      while (i < localValues.length) {
        let j = i;
        while (j < localValues.length && localValues[j] === localValues[i]) j++;
        groups.push([j - i, localValues[i]]);
        i = j;
      }
      const localDecls  = groups.flatMap(([count, valtype]) => [...encodeULEB128(count), valtype]);
      const groupCount  = encodeULEB128(groups.length);
      const body = [...groupCount, ...localDecls, ...fn.binary];
      return [...encodeULEB128(body.length), ...body];
    });

    let size = encodeULEB128(codes.length).length;
    bodies.forEach((b) => (size += b.length));
    binary.push(...encodeULEB128(size), ...encodeULEB128(codes.length));
    bodies.forEach((b) => binary.push(...b));
  }

  // ── Section 11: Data ──────────────────────────────────────────────────────
  if (dataSegs.length) {
    binary.push(0x0b);
    const segs = dataSegs.map((seg) => [
      0x00,
      0x41, ...encodeSLEB128(seg.offset), 0x0b,
      ...encodeULEB128(seg.binary.length),
      ...seg.binary,
    ]);
    let size = encodeULEB128(dataSegs.length).length;
    segs.forEach((s) => (size += s.length));
    binary.push(...encodeULEB128(size), ...encodeULEB128(dataSegs.length));
    segs.forEach((s) => binary.push(...s));
  }

  const result = new Uint8Array(binary);
  const meta = {};
  exports.forEach((e, idx) => { meta[e.name] = types[functions[idx]].inputs.length; });
  result.meta = meta;
  return result;
}