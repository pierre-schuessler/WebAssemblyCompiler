function encodeULEB128(v) {
  v = BigInt(v || 0);
  const b = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    b.push(byte);
  } while (v !== 0n);
  return b;
}

function encodeSLEB128(v) {
  v = BigInt(v || 0);
  const b = [];
  let more = true;
  while (more) {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0))
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
  let type = ["block", "loop", "if"].includes(words[0]) ? "empty" : "i32";
  
  const validTypes = ["empty", "i32", "i64", "f32", "f64"];
  if (words.length > 1 && validTypes.includes(words[1])) {
    type = words[1];
    words.splice(1, 1);
  }

  const bt = { empty: 0x40, i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
  const instr = words[0];
  const a = Number(words[1]);
  const b = Number(words[2]);

  const table = {
    get:          () => [0x20, ...encodeULEB128(a)],
    set:          () => [0x21, ...encodeULEB128(a)],
    tee:          () => [0x22, ...encodeULEB128(a)],
    "global.get": () => [0x23, ...encodeULEB128(a)],
    "global.set": () => [0x24, ...encodeULEB128(a)],
    const: () => ({
      f32: [0x43, ...encodeF32(a)],
      f64: [0x44, ...encodeF64(a)],
      i64: [0x42, ...encodeSLEB128(words[1])],
      i32: [0x41, ...encodeSLEB128(words[1])],
    })[type],
    nop:          () => [0x01],
    unreachable:  () => [0x00],
    return:       () => [0x0f],
    drop:         () => [0x1a],
    select:       () => [0x1b],
    call:         () => [0x10, ...encodeULEB128(a)],
    call_indirect:() => [0x11, ...encodeULEB128(a), 0x00],
    block:        () => [0x02, bt[type]],
    loop:         () => [0x03, bt[type]],
    if:           () => [0x04, bt[type]],
    else:         () => [0x05],
    end:          () => [0x0b],
    br:           () => [0x0c, ...encodeULEB128(a)],
    br_if:        () => [0x0d, ...encodeULEB128(a)],
    br_table:     () => { const t = words.slice(1).map(Number); const d = t.pop(); return [0x0e, ...encodeULEB128(t.length), ...t.flatMap(encodeULEB128), ...encodeULEB128(d)]; },
    "memory.size":() => [0x3f, 0x00],
    "memory.grow":() => [0x40, 0x00],
    load:         () => [{ i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b }[type], ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    load8_s:      () => [{ i32: 0x2c, i64: 0x30 }[type],                        ...encodeULEB128(a ?? 0), ...encodeULEB128(b ?? 0)],
    load8_u:      () => [{ i32: 0x2d, i64: 0x31 }[type],                        ...encodeULEB128(a ?? 0), ...encodeULEB128(b ?? 0)],
    load16_s:     () => [{ i32: 0x2e, i64: 0x32 }[type],                        ...encodeULEB128(a ?? 1), ...encodeULEB128(b ?? 0)],
    load16_u:     () => [{ i32: 0x2f, i64: 0x33 }[type],                        ...encodeULEB128(a ?? 1), ...encodeULEB128(b ?? 0)],
    load32_s:     () => [{ i64: 0x34 }[type],                                    ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    load32_u:     () => [{ i64: 0x35 }[type],                                    ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    store:        () => [{ i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39 }[type],  ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    store8:       () => [{ i32: 0x3a, i64: 0x3c }[type],                         ...encodeULEB128(a ?? 0), ...encodeULEB128(b ?? 0)],
    store16:      () => [{ i32: 0x3b, i64: 0x3d }[type],                         ...encodeULEB128(a ?? 1), ...encodeULEB128(b ?? 0)],
    store32:      () => [{ i64: 0x3e }[type],                                     ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    add:      () => [{ i32: 0x6a, i64: 0x7c, f32: 0x92, f64: 0xa0 }[type]],
    sub:      () => [{ i32: 0x6b, i64: 0x7d, f32: 0x93, f64: 0xa1 }[type]],
    mul:      () => [{ i32: 0x6c, i64: 0x7e, f32: 0x94, f64: 0xa2 }[type]],
    div:      () => [{ i32: 0x6d, i64: 0x7f, f32: 0x95, f64: 0xa3 }[type]],
    div_s:    () => [{ i32: 0x6d, i64: 0x7f }[type]],
    div_u:    () => [{ i32: 0x6e, i64: 0x80 }[type]],
    rem_s:    () => [{ i32: 0x6f, i64: 0x81 }[type]],
    rem_u:    () => [{ i32: 0x70, i64: 0x82 }[type]],
    and:      () => [{ i32: 0x71, i64: 0x83 }[type]],
    or:       () => [{ i32: 0x72, i64: 0x84 }[type]],
    xor:      () => [{ i32: 0x73, i64: 0x85 }[type]],
    shl:      () => [{ i32: 0x74, i64: 0x86 }[type]],
    shr_s:    () => [{ i32: 0x75, i64: 0x87 }[type]],
    shr_u:    () => [{ i32: 0x76, i64: 0x88 }[type]],
    rotl:     () => [{ i32: 0x77, i64: 0x89 }[type]],
    rotr:     () => [{ i32: 0x78, i64: 0x8a }[type]],
    clz:      () => [{ i32: 0x67, i64: 0x79 }[type]],
    ctz:      () => [{ i32: 0x68, i64: 0x7a }[type]],
    popcnt:   () => [{ i32: 0x69, i64: 0x7b }[type]],
    abs:      () => [{ f32: 0x8b, f64: 0x99 }[type]],
    neg:      () => [{ f32: 0x8c, f64: 0x9a }[type]],
    ceil:     () => [{ f32: 0x8d, f64: 0x9b }[type]],
    floor:    () => [{ f32: 0x8e, f64: 0x9c }[type]],
    trunc:    () => [{ f32: 0x8f, f64: 0x9d }[type]],
    nearest:  () => [{ f32: 0x90, f64: 0x9e }[type]],
    sqrt:     () => [{ f32: 0x91, f64: 0x9f }[type]],
    min:      () => [{ f32: 0x96, f64: 0xa4 }[type]],
    max:      () => [{ f32: 0x97, f64: 0xa5 }[type]],
    copysign: () => [{ f32: 0x98, f64: 0xa6 }[type]],
    eqz:  () => [{ i32: 0x45, i64: 0x50 }[type]],
    eq:   () => [{ i32: 0x46, i64: 0x51, f32: 0x5b, f64: 0x61 }[type]],
    ne:   () => [{ i32: 0x47, i64: 0x52, f32: 0x5c, f64: 0x62 }[type]],
    lt_s: () => [{ i32: 0x48, i64: 0x53 }[type]],
    lt_u: () => [{ i32: 0x49, i64: 0x54 }[type]],
    lt:   () => [{ f32: 0x5d, f64: 0x63 }[type]],
    gt_s: () => [{ i32: 0x4a, i64: 0x55 }[type]],
    gt_u: () => [{ i32: 0x4b, i64: 0x56 }[type]],
    gt:   () => [{ f32: 0x5e, f64: 0x64 }[type]],
    le_s: () => [{ i32: 0x4c, i64: 0x57 }[type]],
    le_u: () => [{ i32: 0x4d, i64: 0x58 }[type]],
    le:   () => [{ f32: 0x5f, f64: 0x65 }[type]],
    ge_s: () => [{ i32: 0x4e, i64: 0x59 }[type]],
    ge_u: () => [{ i32: 0x4f, i64: 0x5a }[type]],
    ge:   () => [{ f32: 0x60, f64: 0x66 }[type]],
    "i32.wrap":          () => [0xa7],
    "i32.trunc_s_f32":   () => [0xa8],
    "i32.trunc_u_f32":   () => [0xa9],
    "i32.trunc_s_f64":   () => [0xaa],
    "i32.trunc_u_f64":   () => [0xab],
    "i64.extend_s":      () => [0xac],
    "i64.extend_u":      () => [0xad],
    "i64.trunc_s_f32":   () => [0xae],
    "i64.trunc_u_f32":   () => [0xaf],
    "i64.trunc_s_f64":   () => [0xb0],
    "i64.trunc_u_f64":   () => [0xb1],
    "f32.convert_s_i32": () => [0xb2],
    "f32.convert_u_i32": () => [0xb3],
    "f32.convert_s_i64": () => [0xb4],
    "f32.convert_u_i64": () => [0xb5],
    "f32.demote":        () => [0xb6],
    "f64.convert_s_i32": () => [0xb7],
    "f64.convert_u_i32": () => [0xb8],
    "f64.convert_s_i64": () => [0xb9],
    "f64.convert_u_i64": () => [0xba],
    "f64.promote":       () => [0xbb],
    "i32.reinterpret":   () => [0xbc],
    "i64.reinterpret":   () => [0xbd],
    "f32.reinterpret":   () => [0xbe],
    "f64.reinterpret":   () => [0xbf],
  };

  const handler = table[instr];
  if (handler) return handler();
  return [Number(instr)];
}

const TYPEMAP = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

function resolveIncludes(lines, libs = {}) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^#include\s+<([^>]+)>$/);
    if (!m) { out.push(line); continue; }
    const name = m[1].trim();
    if (!(name in libs)) throw new Error(`include <${name}>: not found`);
    out.push(...libs[name].split("\n").map(l => l.replace(/\/\/.*$/, "").trim()).filter(Boolean));
  }
  return out;
}

function flatten(line) {
  let output = [];
  let tempIndex = 0;

  let lhs = null;
  if (line.includes("=")) {
    const eqIdx = line.indexOf("=");
    lhs = line.slice(0, eqIdx).trim();
    line = line.slice(eqIdx + 1).trim();
  }

  function _flatten(expr) {
    expr = expr.trim();
    const parenIdx = expr.indexOf("(");
    if (parenIdx === -1) {
      return (expr.startsWith('"') || expr.startsWith('64"')) ? expr : `$${expr}`;
    }

    const funct = expr.slice(0, parenIdx).trim();

    let depth = 0, closeIdx = -1;
    for (let i = parenIdx; i < expr.length; i++) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    const inside = expr.slice(parenIdx + 1, closeIdx);

    const args = [];
    let d = 0, current = "";
    for (const c of inside) {
      if (c === '(') { d++; current += c; }
      else if (c === ')') { d--; current += c; }
      else if (c === ',' && d === 0) { args.push(current.trim()); current = ""; }
      else current += c;
    }
    if (current.trim()) args.push(current.trim());

    const argExprs = [];
    for (const arg of args) {
      if (arg.includes("(")) {
        const tempName = `temp_${tempIndex++}`;
        output.push(`${tempName} = ${_flatten(arg)}`);
        argExprs.push(`$${tempName}`);
      } else {
        argExprs.push(_flatten(arg));
      }
    }

    return `${funct}(${argExprs.join(", ")})`;
  }

  const resultExpr = _flatten(line);
  if (lhs) {
    output.push(`${lhs} = ${resultExpr}`);
  } else {
    output.push(resultExpr);
  }

  return output;
}

function registerFunctions(lines) {
  const registry = {

    "get":        { arity: 1, output: "local"  },
    "set":        { arity: 1, output: null      },
    "tee":        { arity: 1, output: "local"  },
    "global.get": { arity: 1, output: "global" },
    "global.set": { arity: 1, output: null      },

    "const": { arity: 0, output: "typed" },

    "add":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "same" },
    "sub":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "same" },
    "mul":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "same" },
    "div":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "same" },
    "div_s": { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "div_u": { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "rem_s": { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "rem_u": { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "and":   { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "or":    { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "xor":   { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "shl":   { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "shr_s": { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "shr_u": { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "rotl":  { arity: 2, validTypes: ["i32","i64"],             output: "same" },
    "rotr":  { arity: 2, validTypes: ["i32","i64"],             output: "same" },

    "clz":    { arity: 1, validTypes: ["i32","i64"], output: "same" },
    "ctz":    { arity: 1, validTypes: ["i32","i64"], output: "same" },
    "popcnt": { arity: 1, validTypes: ["i32","i64"], output: "same" },

    "abs":     { arity: 1, validTypes: ["f32","f64"], output: "same" },
    "neg":     { arity: 1, validTypes: ["f32","f64"], output: "same" },
    "ceil":    { arity: 1, validTypes: ["f32","f64"], output: "same" },
    "floor":   { arity: 1, validTypes: ["f32","f64"], output: "same" },
    "trunc":   { arity: 1, validTypes: ["f32","f64"], output: "same" },
    "nearest": { arity: 1, validTypes: ["f32","f64"], output: "same" },
    "sqrt":    { arity: 1, validTypes: ["f32","f64"], output: "same" },

    "min":      { arity: 2, validTypes: ["f32","f64"], output: "same" },
    "max":      { arity: 2, validTypes: ["f32","f64"], output: "same" },
    "copysign": { arity: 2, validTypes: ["f32","f64"], output: "same" },

    "eqz":  { arity: 1, validTypes: ["i32","i64"],             output: "i32" },
    "eq":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "i32" },
    "ne":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "i32" },
    "lt_s": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "lt_u": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "lt":   { arity: 2, validTypes: ["f32","f64"],             output: "i32" },
    "gt_s": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "gt_u": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "gt":   { arity: 2, validTypes: ["f32","f64"],             output: "i32" },
    "le_s": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "le_u": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "le":   { arity: 2, validTypes: ["f32","f64"],             output: "i32" },
    "ge_s": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "ge_u": { arity: 2, validTypes: ["i32","i64"],             output: "i32" },
    "ge":   { arity: 2, validTypes: ["f32","f64"],             output: "i32" },

    "i32.wrap":          { arity: 1, inputType: "i64", output: "i32" },
    "i32.trunc_s_f32":   { arity: 1, inputType: "f32", output: "i32" },
    "i32.trunc_u_f32":   { arity: 1, inputType: "f32", output: "i32" },
    "i32.trunc_s_f64":   { arity: 1, inputType: "f64", output: "i32" },
    "i32.trunc_u_f64":   { arity: 1, inputType: "f64", output: "i32" },
    "i32.reinterpret":   { arity: 1, inputType: "f32", output: "i32" },

    "i64.extend_s":      { arity: 1, inputType: "i32", output: "i64" },
    "i64.extend_u":      { arity: 1, inputType: "i32", output: "i64" },
    "i64.trunc_s_f32":   { arity: 1, inputType: "f32", output: "i64" },
    "i64.trunc_u_f32":   { arity: 1, inputType: "f32", output: "i64" },
    "i64.trunc_s_f64":   { arity: 1, inputType: "f64", output: "i64" },
    "i64.trunc_u_f64":   { arity: 1, inputType: "f64", output: "i64" },
    "i64.reinterpret":   { arity: 1, inputType: "f64", output: "i64" },

    "f32.convert_s_i32": { arity: 1, inputType: "i32", output: "f32" },
    "f32.convert_u_i32": { arity: 1, inputType: "i32", output: "f32" },
    "f32.convert_s_i64": { arity: 1, inputType: "i64", output: "f32" },
    "f32.convert_u_i64": { arity: 1, inputType: "i64", output: "f32" },
    "f32.demote":        { arity: 1, inputType: "f64", output: "f32" },
    "f32.reinterpret":   { arity: 1, inputType: "i32", output: "f32" },

    "f64.convert_s_i32": { arity: 1, inputType: "i32", output: "f64" },
    "f64.convert_u_i32": { arity: 1, inputType: "i32", output: "f64" },
    "f64.convert_s_i64": { arity: 1, inputType: "i64", output: "f64" },
    "f64.convert_u_i64": { arity: 1, inputType: "i64", output: "f64" },
    "f64.promote":       { arity: 1, inputType: "f32", output: "f64" },
    "f64.reinterpret":   { arity: 1, inputType: "i64", output: "f64" },

    "load":     { arity: 2, validTypes: ["i32","i64","f32","f64"], output: "typed" },
    "load8_s":  { arity: 2, validTypes: ["i32","i64"],             output: "typed" },
    "load8_u":  { arity: 2, validTypes: ["i32","i64"],             output: "typed" },
    "load16_s": { arity: 2, validTypes: ["i32","i64"],             output: "typed" },
    "load16_u": { arity: 2, validTypes: ["i32","i64"],             output: "typed" },
    "load32_s": { arity: 2, validTypes: ["i64"],                   output: "typed" },
    "load32_u": { arity: 2, validTypes: ["i64"],                   output: "typed" },

    "store":   { arity: 2, validTypes: ["i32","i64","f32","f64"], output: null },
    "store8":  { arity: 2, validTypes: ["i32","i64"],             output: null },
    "store16": { arity: 2, validTypes: ["i32","i64"],             output: null },
    "store32": { arity: 2, validTypes: ["i64"],                   output: null },

    "memory.size": { arity: 0, output: "i32" },
    "memory.grow": { arity: 1, validTypes: ["i32"], output: "i32" },

    "call":          { arity: -1, output: "fn" },
    "call_indirect": { arity: -1, output: "fn" },

    "nop":         { arity: 0,  output: null   },
    "unreachable": { arity: 0,  output: null   },
    "return":      { arity: 0,  output: null   },
    "drop":        { arity: 1,  output: null   },
    "select":      { arity: 3,  output: "same" },
    "block":       { arity: 0,  output: null   },
    "loop":        { arity: 0,  output: null   },
    "if":          { arity: 1,  output: null   },
    "else":        { arity: 0,  output: null   },
    "end":         { arity: 0,  output: null   },
    "br":          { arity: 0,  output: null   },
    "br_if":       { arity: 1,  output: null   },
    "br_table":    { arity: -1, output: null   },
  };

  const validTypes = new Set(["i32","i64","f32","f64"]);
  let importCount = 0;
  let exportCount = 0;

  for (const line of lines) {
    const t = line.trim();

    if (t.startsWith("import ")) {
      const tokens = t.slice(7).trim().split(/\s+/);
      let i = 1;
      let localName = null;
      if (tokens[i] && !validTypes.has(tokens[i]) && tokens[i] !== "=>")
        localName = tokens[i++];

      const inputs = [], outputs = [];
      let mode = "inputs";
      for (; i < tokens.length; i++) {
        if (tokens[i] === "=>") { mode = "outputs"; continue; }
        if (validTypes.has(tokens[i]))
          (mode === "inputs" ? inputs : outputs).push(tokens[i]);
      }

      if (localName) {
        registry[localName] = {
          arity:      inputs.length,
          inputTypes: inputs,
          output:     outputs[0] ?? null,
          outputs,
          index:      importCount,
        };
      }
      importCount++;
      continue;
    }

    if (t.startsWith("export ")) {
      const tokens  = t.slice(7).trim().split(/\s+/);
      const fnName  = tokens[0];
      const inputs  = [], outputs = [], argTypes = {};
      let mode = "inputs", i = 1;

      while (i < tokens.length) {
        if (tokens[i] === "=>") { mode = "outputs"; i++; continue; }
        if (validTypes.has(tokens[i])) {
          if (mode === "inputs") {
            const typ = tokens[i];
            inputs.push(typ);
            if (tokens[i + 1] && !validTypes.has(tokens[i + 1]) && tokens[i + 1] !== "=>") {
              argTypes[tokens[++i]] = typ;
            }
          } else {
            outputs.push(tokens[i]);
          }
        }
        i++;
      }

      registry[fnName] = {
        arity:      inputs.length,
        inputTypes: inputs,
        argTypes,
        output:     outputs[0] ?? null,
        outputs,
        index:      importCount + exportCount,
      };
      exportCount++;
    }
  }

  return registry;
}

function reorder(lines) {
  const memory  = [];
  const imports = [];
  const globals = [];
  const data    = [];
  const exports = [];

  for (const line of lines) {
    const t = line.trim();
    const key = Object.keys({ memory: 1, import: 1, global: 1, data: 1, export: 1 })
      .find(k => t.startsWith(k + " "));

    switch (key) {
      case "memory": memory.push(line);  break;
      case "import": imports.push(line); break;
      case "global": globals.push(line); break;
      case "data":   data.push(line);    break;
      default:       exports.push(line); break;
    }
  }

  return [...memory, ...imports, ...globals, ...exports, ...data];
}

function inferWasmTypes(lines, registry = {}) {
  const globalTypeMap = {};
  let   typeMap       = {};
  const validTypes    = new Set(["i32", "i64", "f32", "f64"]);

  for (const line of lines) {
    const t = line.trim();
    const globalM = t.match(/^global\s+(?:mut\s+)?(\S+)\s+(\S+)/);
    if (globalM) globalTypeMap[globalM[2]] = globalM[1];
  }

  typeMap = { ...globalTypeMap };

  function resolveTypes(operation, argsStr) {
    const entry = registry[operation];

    const operandType = [...argsStr.matchAll(/\$(\w+)/g)]
      .map(m => typeMap[m[1]])
      .find(t => t !== undefined);

    if (entry?.index !== undefined) {
      const ret = entry.output;
      const resultType = (ret && validTypes.has(ret)) ? ret : null;
      return resultType ? { resultType, opType: null, isCall: true, index: entry.index } : null;
    }

    if (!entry) {
      const resultType = operandType ?? "i32";
      return { resultType, opType: resultType, isCall: false };
    }

    const { output, inputType } = entry;

    if (validTypes.has(output)) {
      const opType = inputType ?? operandType ?? output;
      return { resultType: output, opType, isCall: false };
    }

    if (output === "same") {
      const resultType = operandType ?? "i32";
      return { resultType, opType: resultType, isCall: false };
    }

    if (output === "typed") {
      const resultType = operandType ?? "i32";
      return { resultType, opType: resultType, isCall: false };
    }

    if (output === "fn") {
      const resultType = operandType ?? "i32";
      return { resultType, opType: resultType, isCall: false };
    }

    return null;
  }

  return lines.map(line => {
    const indent = line.match(/^(\s*)/)[1];
    const t      = line.trim();

    if (t.startsWith("export ")) {
      const name    = t.slice(7).trim().split(/\s+/)[0];
      const fnEntry = registry[name];
      typeMap = { ...globalTypeMap, ...(fnEntry?.argTypes ?? {}) };
      return line;
    }

    const copyM = t.match(/^(\w+)\s*=\s*(\$\w+|(?:64)?"[^"]*")$/);
    if (copyM) {
      const [, varName, rawVal] = copyM;
      const is64    = rawVal.startsWith('64"');
      const isConst = is64 || rawVal.startsWith('"');
      const ref     = isConst ? rawVal.replace(/^(?:64)?"|"$/g, '') : rawVal.slice(1);

      const inferredType = isConst
        ? (ref.includes('.') || /[eE]/.test(ref) ? 'f' : 'i') + (is64 ? '64' : '32')
        : typeMap[ref];

      if (!inferredType) return line;
      typeMap[varName] = inferredType;
      return `${indent}${inferredType} ${varName} = ${rawVal}`;
    }

    const multiCallM = t.match(/^(\w+(?:\s+\w+)?(?:,\s*\w+(?:\s+\w+)?)+)\s*=\s*([\w.]+)\s*\((.+)\)\s*$/);
    if (multiCallM) {
      const [, lhsStr, operation, argsStr] = multiCallM;
      const entry = registry[operation];
      if (entry?.index !== undefined) {
        const varParts = lhsStr.split(',').map(s => s.trim().split(/\s+/));
        const varNames = varParts.map(p => p[p.length - 1]);
        const outTypes = entry.outputs ?? [];
        varNames.forEach((v, i) => { if (outTypes[i]) typeMap[v] = outTypes[i]; });
        const typedLhs = varNames.map((v, i) => `${outTypes[i] ?? 'i32'} ${v}`).join(', ');
        return `${indent}${typedLhs} = callfn ${entry.index}(${argsStr})`;
      }
    }

    const callM = t.match(/^(\w+)\s*=\s*([\w.]+)\s*\((.+)\)\s*$/);
    if (callM) {
      const [, varName, operation, argsStr] = callM;
      const resolved = resolveTypes(operation, argsStr);
      if (!resolved) return line;

      const { resultType, opType, isCall, index } = resolved;
      typeMap[varName] = resultType;

      if (isCall) {
        return `${indent}${resultType} ${varName} = callfn ${index}(${argsStr})`;
      }

      return `${indent}${resultType} ${varName} = ${operation} ${opType}(${argsStr})`;
    }

    const voidM = t.match(/^([\w.]+)\s*\((.+)\)\s*$/);
    if (voidM) {
      const entry = registry[voidM[1]];
      if (entry?.index !== undefined) {
        return `${indent}callfn ${entry.index}(${voidM[2]})`;
      }
    }

    return line;
  });
}

function evaluate(lines, callReturnMap = {}, callInputMap = {}) {
  const output = [];
  const globalNames = new Set();
  let exportIdx = -1;
  let knownLocals = new Set();

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("global ")) {
      const tokens = t.split(/\s+/);
      let i = 1;
      if (tokens[i] === 'mut') i++;
      i++;
      if (tokens[i]) globalNames.add(tokens[i]);
    }
  }

  for (const line of lines) {
    const t = line.trim();

    if (t.startsWith("export")) {
      knownLocals = new Set();
      exportIdx = output.length;

      const tokens = t.slice(7).trim().split(/\s+/);
      let i = 1;
      while (i < tokens.length && tokens[i] !== '=>') {
        if (tokens[i + 1] && tokens[i + 1] !== '=>' && !["i32","i64","f32","f64"].includes(tokens[i + 1])) {
          knownLocals.add(tokens[i + 1]);
          i += 2;
        } else { i++; }
      }

      output.push(line);
      continue;
    }

    if (t.startsWith("global ")) {
      output.push(line);
      continue;
    }

    const returnM = t.match(/^return\s+(\w+)$/);
    if (returnM) {
      const name = returnM[1];
      output.push(globalNames.has(name) ? `global.get ${name}` : `get $${name}`);
      output.push(`return`);
      continue;
    }

    const copyM = t.match(/^(?:(\w+)\s+)?(\w+)\s*=\s*(\$\w+|(?:64)?"[^"]*")$/);
    if (copyM) {
      const [, maybeType, dest, rawVal] = copyM;
      const is64    = rawVal.startsWith('64"');
      const isConst = is64 || rawVal.startsWith('"');
      const src     = isConst ? rawVal.replace(/^(?:64)?"|"$/g, '') : rawVal.slice(1);

      let type = maybeType;
      if (!type) {
        type = isConst
          ? (src.includes('.') || /[eE]/.test(src) ? 'f' : 'i') + (is64 ? '64' : '32')
          : 'i32';
      }

      if (!globalNames.has(dest) && !knownLocals.has(dest)) {
        knownLocals.add(dest);
        output.splice(exportIdx + 1, 0, `local ${type} ${dest}`);
        exportIdx++;
      }

      if (isConst) {
        output.push(`const ${type} ${src}`);
      } else {
        output.push(globalNames.has(src) ? `global.get ${src}` : `get $${src}`);
      }

      output.push(globalNames.has(dest) ? `global.set ${dest}` : `set $${dest}`);
      continue;
    }

    const multiVarCallM = t.match(/^((?:\w+\s+\w+)(?:,\s*(?:\w+\s+\w+))*)\s*=\s*callfn\s+(\d+)\((.*)\)$/);
    if (multiVarCallM) {
      const [, lhsStr, fnIdxStr, argsStr] = multiVarCallM;
      const fnIdx = parseInt(fnIdxStr, 10);
      const vars = lhsStr.split(',').map(s => {
        const [type, name] = s.trim().split(/\s+/);
        return { type, name };
      });

      for (const { type, name } of vars) {
        if (!globalNames.has(name) && !knownLocals.has(name)) {
          knownLocals.add(name);
          output.splice(exportIdx + 1, 0, `local ${type} ${name}`);
          exportIdx++;
        }
      }

      const inputTypes = callInputMap[fnIdx] ?? [];
      const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(a => a) : [];
      args.forEach((arg, argIdx) => {
        if (arg.startsWith('"') || arg.startsWith('64"')) {
          const argIs64  = arg.startsWith('64"');
          const val      = arg.replace(/^(?:64)?"|"$/g, '');
          const constType = inputTypes[argIdx]
            ?? (val.includes('.') || /[eE]/.test(val) ? 'f' : 'i') + (argIs64 ? '64' : '32');
          output.push(`const ${constType} ${val}`);
        } else {
          const name = arg.slice(1);
          output.push(globalNames.has(name) ? `global.get ${name}` : `get $${name}`);
        }
      });

      output.push(`call ${fnIdx}`);

      const retTypes = callReturnMap[fnIdx] ?? [];
      for (let i = vars.length; i < retTypes.length; i++) output.push('drop');
      for (const { name } of [...vars].reverse()) {
        output.push(globalNames.has(name) ? `global.set ${name}` : `set $${name}`);
      }
      continue;
    }

    const callM = t.match(/^(?:(\w+)\s+)?(\w+)\s*=\s*([^(]+)\((.*)\)$/);
    if (callM) {
      const [, maybeType, dest, rawOp, argsStr] = callM;
      const opStr = rawOp.trim();

      let type = maybeType;
      if (!type) {
        if (opStr.includes('i64')) type = 'i64';
        else if (opStr.includes('f32')) type = 'f32';
        else if (opStr.includes('f64')) type = 'f64';
        else type = 'i32';
      }

      if (!globalNames.has(dest) && !knownLocals.has(dest)) {
        knownLocals.add(dest);
        output.splice(exportIdx + 1, 0, `local ${type} ${dest}`);
        exportIdx++;
      }

      const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(a => a) : [];

      for (const arg of args) {
        if (arg.startsWith('"') || arg.startsWith('64"')) {
          const argIs64 = arg.startsWith('64"');
          const val     = arg.replace(/^(?:64)?"|"$/g, '');
          let constType = type;

          if (opStr.includes('i64')) constType = 'i64';
          else if (opStr.includes('f32')) constType = 'f32';
          else if (opStr.includes('f64')) constType = 'f64';
          else if (opStr.includes('i32')) constType = 'i32';
          else constType = (val.includes('.') || /[eE]/.test(val) ? 'f' : 'i') + (argIs64 ? '64' : '32');

          output.push(`const ${constType} ${val}`);
        } else {
          const name = arg.slice(1);
          output.push(globalNames.has(name) ? `global.get ${name}` : `get $${name}`);
        }
      }

      if (opStr.startsWith('callfn ')) {
        const fnIdx = parseInt(opStr.slice(7).trim(), 10);
        output.push(`call ${fnIdx}`);
        const retTypes = callReturnMap[fnIdx] ?? [];
        for (let i = 1; i < retTypes.length; i++) output.push('drop');
        output.push(globalNames.has(dest) ? `global.set ${dest}` : `set $${dest}`);
      } else {
        output.push(opStr);
        output.push(globalNames.has(dest) ? `global.set ${dest}` : `set $${dest}`);
      }
      continue;
    }

    const voidCallM = t.match(/^([^(]+)\((.*)\)$/);
    if (voidCallM) {
      const [, rawOp, argsStr] = voidCallM;
      const opStr = rawOp.trim();

      const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(a => a) : [];

      for (const arg of args) {
        if (arg.startsWith('"') || arg.startsWith('64"')) {
          const argIs64 = arg.startsWith('64"');
          const val     = arg.replace(/^(?:64)?"|"$/g, '');
          let constType = 'i32';

          if (opStr.includes('i64')) constType = 'i64';
          else if (opStr.includes('f32')) constType = 'f32';
          else if (opStr.includes('f64')) constType = 'f64';
          else constType = (val.includes('.') || /[eE]/.test(val) ? 'f' : 'i') + (argIs64 ? '64' : '32');

          output.push(`const ${constType} ${val}`);
        } else {
          const name = arg.slice(1);
          output.push(globalNames.has(name) ? `global.get ${name}` : `get $${name}`);
        }
      }

      if (opStr.startsWith('callfn ')) {
        const fnIdx = parseInt(opStr.slice(7).trim(), 10);
        output.push(`call ${fnIdx}`);
        const retTypes = callReturnMap[fnIdx] ?? [];
        for (let i = 0; i < retTypes.length; i++) output.push('drop');
      } else {
        const needsEmpty = ['if', 'block', 'loop'].includes(opStr);
        output.push(needsEmpty ? `${opStr} empty` : opStr);
      }
      continue;
    }

    const bare = t;
    if (['else', 'end'].includes(bare)) {
      output.push(`${bare} empty`);
    } else {
      output.push(line);
    }
  }

  function collapseSetGet(lines) {
    const result = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      const setM = t.match(/^set \$(\w+)$/);

      if (setM && i + 1 < lines.length) {
        const varName = setM[1];
        const getLine = `get $${varName}`;

        if (lines[i + 1].trim() === getLine) {
          const usedAnywhere = lines.some((l, idx) => idx !== i + 1 && l.trim() === getLine);
          if (usedAnywhere) {
            result.push(`tee $${varName}`);
          }
          i += 2;
          continue;
        }
      }
      result.push(lines[i]);
      i++;
    }
    return result;
  }

  function removeUnusedLocals(lines) {
    return lines.filter(line => {
      const localM = line.trim().match(/^local\s+\S+\s+(\w+)$/);
      if (!localM) return true;
      const varName = localM[1];
      const pattern = new RegExp(`^(get|set|tee) \\$${varName}$`);
      return lines.some(l => pattern.test(l.trim()));
    });
  }

  return removeUnusedLocals(collapseSetGet(output));
}

function artificialize(lines) {
  const globalIndexMap = {};
  let nextGlobalIndex = 0;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("global ")) {
      const tokens = t.split(/\s+/);
      let i = 1;
      if (tokens[i] === 'mut') i++;
      i++;
      const name = tokens[i];
      if (name && !(name in globalIndexMap)) {
        globalIndexMap[name] = nextGlobalIndex++;
      }
    }
  }

  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t.startsWith("export ")) {
      const globalGetM = t.match(/^global\.get\s+(\w+)$/);
      if (globalGetM) {
        result.push(`global.get ${globalIndexMap[globalGetM[1]] ?? 0}`);
        i++;
        continue;
      }

      const globalSetM = t.match(/^global\.set\s+(\w+)$/);
      if (globalSetM) {
        result.push(`global.set ${globalIndexMap[globalSetM[1]] ?? 0}`);
        i++;
        continue;
      }

      result.push(line);
      i++;
      continue;
    }

    const funcLines = [];
    funcLines.push(line);
    i++;

    while (i < lines.length && !lines[i].trim().startsWith("export ")) {
      funcLines.push(lines[i]);
      i++;
    }

    const indexMap = {};
    let nextIndex = 0;

    function assign(name) {
      if (!(name in indexMap)) {
        indexMap[name] = nextIndex++;
      }
    }

    const header = funcLines[0].trim();
    const headerTokens = header.replace(/^export\s+/, "").split(/\s+/);
    
    let j = 1;
    while (j < headerTokens.length && headerTokens[j] !== '=>') {
      const type = headerTokens[j];
      const name = headerTokens[j + 1];

      if (name && name !== '=>') {
        assign(name);
        j += 2;
      } else {
        break;
      }
    }

    for (const l of funcLines) {
      const tt = l.trim();

      if (tt.startsWith("export") || tt.startsWith("global ")) continue;

      const localDeclM = tt.match(/^local\s+\S+\s+(\w+)$/);
      if (localDeclM) {
        assign(localDeclM[1]);
        continue;
      }

      const lhsM = tt.match(/\$(\w+)\s*=/);
      if (lhsM) {
        assign(lhsM[1]);
      }
    }

    for (const l of funcLines) {
      const tt = l.trim();

      if (tt.startsWith("export") || tt.startsWith("global ")) {
        result.push(l);
        continue;
      }

      const globalGetM = tt.match(/^global\.get\s+(\w+)$/);
      if (globalGetM) {
        result.push(l.replace(globalGetM[1], globalIndexMap[globalGetM[1]] ?? 0));
        continue;
      }

      const globalSetM = tt.match(/^global\.set\s+(\w+)$/);
      if (globalSetM) {
        result.push(l.replace(globalSetM[1], globalIndexMap[globalSetM[1]] ?? 0));
        continue;
      }

      result.push(
        l.replace(/\$(\w+)/g, (_, name) => {
          assign(name);
          return String(indexMap[name]);
        })
      );
    }
  }

  return result;
}

function preprocess(code, libs = {}) {
  let lines = code
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => l.length > 0);

  lines = resolveIncludes(lines, libs);
  
  lines = reorder(lines);

  let temp = [];
  lines.forEach((line) => {
    if (line.startsWith("export") || line.startsWith("global") || line.startsWith("import")|| line.startsWith("memory") || line.startsWith("data")) {
      temp.push(line);
    } else {
      temp.push(...flatten(line));
    }
  });
  lines = temp;
  console.log("after flatten:", lines);

  let functionRegistry = registerFunctions(lines);
  console.log("function registry: ", functionRegistry);

  const callReturnMap = {};
  const callInputMap  = {};
  for (const entry of Object.values(functionRegistry)) {
    if (entry.index !== undefined) {
      callReturnMap[entry.index] = entry.outputs ?? (entry.output ? [entry.output] : []);
      callInputMap[entry.index]  = entry.inputTypes ?? [];
    }
  }

  lines = inferWasmTypes(lines, functionRegistry);
  console.log("after inferWasmTypes:", lines);

  lines = evaluate(lines, callReturnMap, callInputMap);
  console.log("after evaluate:", lines);

  lines = artificialize(lines);
  console.log("after artificialize:", lines);

  return lines;
}

export function compile(code, libs = {}) {

  const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  let types       = [],
      functions   = [],
      imports     = [],
      exports     = [],
      codes       = [],
      globals     = [],
      globalNames = [],
      dataSegs    = [],
      memory      = null,
      tmp         = null;

  function flushTmp() {
    if (tmp) {
      tmp.binary.push(0x0b);
      codes.push({ locals: tmp.locals, binary: tmp.binary });
      tmp = null;
    }
  }

  function encodeInitExpr(initType, initVal) {
    switch (initType) {
      case "i32": return [0x41, ...encodeSLEB128(initVal), 0x0b];
      case "i64": return [0x42, ...encodeSLEB128(initVal), 0x0b];
      case "f32": return [0x43, ...encodeF32(initVal),     0x0b];
      case "f64": return [0x44, ...encodeF64(initVal),     0x0b];
      default: throw new Error(`Unknown init type: ${initType}`);
    }
  }

  const lines = preprocess(code, libs);
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
        if (memory) {
          memory = {
            min: Math.max(memory.min ?? 0, min),
            max:
              max === null && memory.max === null
                ? null
                : Math.max(memory.max ?? 0, max ?? 0),
          };
        } else {
          memory = { min, max };
        }
        break;
      }

      case "import": {
        flushTmp();
        const dot = words[1]?.indexOf(".");
        if (!dot || dot === -1) throw new Error(`Import must be "module.name", got '${words[1]}'`);
        const module = words[1].slice(0, dot);
        const name   = words[1].slice(dot + 1);

        let j = 2;
        let localName = null;
        if (words[j] && TYPEMAP[words[j]] == null && words[j] !== "=>") {
          localName = words[j++];
        }

        let inputs = [], outputs = [], mode = "inputs";
        for (; j < words.length; j++) {
          if (words[j] === "=>") { mode = "outputs"; continue; }
          if (TYPEMAP[words[j]] != null) {
            if (mode === "inputs")  inputs.push(TYPEMAP[words[j]]);
            else                    outputs.push(TYPEMAP[words[j]]);
          }
        }

        types.push({ inputs, outputs });
        imports.push({ module, name, localName, typeIndex: types.length - 1 });
        break;
      }

      case "global": {
        flushTmp();
        let j = 1;
        const mutable = words[j] === "mut" ? (j++, true) : false;

        const gtypeStr = words[j++];
        const gtype = TYPEMAP[gtypeStr];
        if (gtype == null) throw new Error(`Unknown global type: '${gtypeStr}'`);

        let gname;
        if (words[j] !== undefined && isNaN(Number(words[j]))) {
          gname = words[j++];
        } else {
          gname = `$g${globals.length}`;
        }

        const initVal = Number(words[j] ?? 0);
        const initExpr = encodeInitExpr(gtypeStr, initVal);

        globalNames.push(gname);
        globals.push({ gname, gtype, mutable, initExpr });
        break;
      }

      case "data": {
        const offset = Number(words[1]);
        if (isNaN(offset)) throw new Error(`Invalid data offset: '${words[1]}'`);

        let bytes = [];
        const rest = line.slice(line.indexOf(words[1]) + words[1].length).trim();

        if (rest.startsWith('"')) {
          const str = rest.slice(1, rest.lastIndexOf('"'));
          for (let i = 0; i < str.length; i++) {
            if (str[i] === '\\' && i + 1 < str.length) {
              const esc = str[++i];
              if      (esc === 'n')  bytes.push(10);
              else if (esc === 'r')  bytes.push(13);
              else if (esc === 't')  bytes.push(9);
              else if (esc === '0')  bytes.push(0);
              else if (esc === '\\') bytes.push(92);
              else if (esc === '"')  bytes.push(34);
              else bytes.push(esc.charCodeAt(0));
            } else {
              bytes.push(str.charCodeAt(i));
            }
          }
        } else {
          bytes = words.slice(2).map(Number);
        }

        dataSegs.push({ offset, bytes });
        break;
      }

      case "export": {
        flushTmp();
        let inputs = [], outputs = [], mode = "inputs";
        const paramLocals = [];
        for (let j = 2; j < words.length; j++) {
          if (words[j] === "=>") { mode = "outputs"; continue; }
          if (TYPEMAP[words[j]] != null) {
            if (mode === "inputs") {
              inputs.push(TYPEMAP[words[j]]);
              const next = words[j + 1];
              if (next && next !== "=>" && TYPEMAP[next] == null) {
                paramLocals.push([next, TYPEMAP[words[j]]]);
                j++;
              } else {
                paramLocals.push([`$${inputs.length - 1}`, TYPEMAP[words[j]]]);
              }
            } else {
              outputs.push(TYPEMAP[words[j]]);
            }
          }
        }
        types.push({ inputs, outputs });
        functions.push(types.length - 1);
        exports.push({ name: words[1] });
        tmp = { locals: paramLocals, binary: [] };
        break;
      }

      case "local": {
        if (tmp) {
          const valtype = TYPEMAP[words[1]];
          if (valtype == null) throw new Error(`Unknown local type: ${words[1]}`);
          const name = words.length > 2 ? words[2] : `$${tmp.locals.length}`;
          tmp.locals.push([name, valtype]);
        }
        break;
      }

      default: {
        if (tmp) {
          tmp.binary.push(...encodeWasmInstruction(words));
        }
        break;
      }
    }
  }
  flushTmp();

  console.log(types, functions, imports, exports, codes, globals, globalNames, dataSegs, memory)

  const importFnCount = imports.length;

  {
    binary.push(0x01);
    let size = encodeULEB128(types.length).length;
    types.forEach((t) => { size += 1 + 1 + t.inputs.length + 1 + t.outputs.length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(types.length));
    types.forEach((t) => {
      binary.push(0x60, t.inputs.length, ...t.inputs, t.outputs.length, ...t.outputs);
    });
  }

  if (imports.length) {
    binary.push(0x02);
    const encImp = imports.map((imp) => {
      const mod = [...imp.module].map((c) => c.charCodeAt(0));
      const nm  = [...imp.name  ].map((c) => c.charCodeAt(0));
      return [mod.length, ...mod, nm.length, ...nm, 0x00, ...encodeULEB128(imp.typeIndex)];
    });
    let size = encodeULEB128(imports.length).length;
    encImp.forEach((e) => (size += e.length));
    binary.push(...encodeULEB128(size), ...encodeULEB128(imports.length));
    encImp.forEach((e) => binary.push(...e));
  }

  {
    binary.push(0x03);
    let size = encodeULEB128(functions.length).length;
    functions.forEach((f) => { size += encodeULEB128(f).length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(functions.length));
    functions.forEach((f) => binary.push(...encodeULEB128(f)));
  }

  if (memory) {
    const hasMax = memory.max != null;
    const minEnc = encodeULEB128(memory.min);
    const maxEnc = hasMax ? encodeULEB128(memory.max) : [];
    const size   = 1 + 1 + minEnc.length + maxEnc.length;
    binary.push(0x05, ...encodeULEB128(size));
    binary.push(0x01, hasMax ? 0x01 : 0x00, ...minEnc);
    if (hasMax) binary.push(...maxEnc);
  }

  if (globals.length) {
    binary.push(0x06);
    let size = encodeULEB128(globals.length).length;
    globals.forEach((g) => { size += 1 + 1 + g.initExpr.length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(globals.length));
    globals.forEach((g) => {
      binary.push(g.gtype, g.mutable ? 0x01 : 0x00, ...g.initExpr);
    });
  }

  if (exports.length) {
    binary.push(0x07);
    let size = encodeULEB128(exports.length).length;
    exports.forEach((e, idx) => {
      size += 1 + e.name.length + 1 + encodeULEB128(idx + importFnCount).length;
    });
    binary.push(...encodeULEB128(size), ...encodeULEB128(exports.length));
    exports.forEach((e, idx) => {
      binary.push(e.name.length, ...[...e.name].map((c) => c.charCodeAt(0)));
      binary.push(0x00, ...encodeULEB128(idx + importFnCount));
    });
  }

  {
    binary.push(0x0a);

    const bodies = codes.map((fn, fnIdx) => {
      const paramCount  = types[functions[fnIdx]].inputs.length;
      const localValues = fn.locals.slice(paramCount).map(([_, valtype]) => valtype);

      const groups = [];
      let i = 0;
      while (i < localValues.length) {
        let j = i;
        while (j < localValues.length && localValues[j] === localValues[i]) j++;
        groups.push([j - i, localValues[i]]);
        i = j;
      }
      const localDecls = groups.flatMap(([count, valtype]) => [...encodeULEB128(count), valtype]);
      const groupCount = encodeULEB128(groups.length);
      const body = [...groupCount, ...localDecls, ...fn.binary];
      return [...encodeULEB128(body.length), ...body];
    });

    let size = encodeULEB128(codes.length).length;
    bodies.forEach((b) => (size += b.length));
    binary.push(...encodeULEB128(size), ...encodeULEB128(codes.length));
    bodies.forEach((b) => binary.push(...b));
  }

  if (dataSegs.length) {
    binary.push(0x0b);
    const segs = dataSegs.map((seg) => [
      0x00,
      0x41, ...encodeSLEB128(seg.offset), 0x0b,
      ...encodeULEB128(seg.bytes.length),
      ...seg.bytes,
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

export function test(funct) {
  switch (funct) {
    case "flatten":
      const input = "x = add(mul(a,b), mul(c,d))";
      let result = "Flatten function tester - Input: ";
      result += input;
      result += "\nOutput: \n";
      result += flatten(input);
      console.log(result);
      return result;
    case "prepro":{
      const input = `
        export add2 f32 x f32 y => f32
          var = add(x, y)
          return var
        `.trim();

      return preprocess(input);
    }
    default:
      console.log("No test available for this function.");
      return "No test available for this function.";
  }
}

