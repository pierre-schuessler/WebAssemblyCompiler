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
  let type = "i32";
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
    // ── Locals ───────────────────────────────────────────────────────────────
    get:          () => [0x20, ...encodeULEB128(a)],
    set:          () => [0x21, ...encodeULEB128(a)],
    tee:          () => [0x22, ...encodeULEB128(a)],
    // ── Globals ──────────────────────────────────────────────────────────────
    "global.get": () => [0x23, ...encodeULEB128(a)],
    "global.set": () => [0x24, ...encodeULEB128(a)],
    // ── Constants ────────────────────────────────────────────────────────────
    const:        () => ({f32: [0x43, ...encodeF32(a)], f64: [0x44, ...encodeF64(a)], i64: [0x42, ...encodeSLEB128(a)], i32: [0x41, ...encodeSLEB128(a)]})[type],
    // ── Control Flow ─────────────────────────────────────────────────────────
    nop:          () => [0x01],
    unreachable:  () => [0x00],
    return:       () => [0x0f],
    drop:         () => [0x1a],
    select:       () => [0x1b],
    call:         () => [0x10, ...encodeULEB128(a)],
    call_indirect:() => [0x11, ...encodeULEB128(a), 0x00],
    // ── Block Structures ─────────────────────────────────────────────────────
    block:        () => [0x02, bt[type]],
    loop:         () => [0x03, bt[type]],
    if:           () => [0x04, bt[type]],
    else:         () => [0x05],
    end:          () => [0x0b],
    // ── Branches ─────────────────────────────────────────────────────────────
    br:           () => [0x0c, ...encodeULEB128(a)],
    br_if:        () => [0x0d, ...encodeULEB128(a)],
    br_table:     () => { const t = words.slice(1).map(Number); const d = t.pop(); return [0x0e, ...encodeULEB128(t.length), ...t.flatMap(encodeULEB128), ...encodeULEB128(d)]; },
    // ── Memory Management ────────────────────────────────────────────────────
    "memory.size":() => [0x3f, 0x00],
    "memory.grow":() => [0x40, 0x00],
    // ── Memory Loads ─────────────────────────────────────────────────────────
    load:         () => [{ i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b }[type], ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    load8_s:      () => [{ i32: 0x2c, i64: 0x30 }[type],                        ...encodeULEB128(a ?? 0), ...encodeULEB128(b ?? 0)],
    load8_u:      () => [{ i32: 0x2d, i64: 0x31 }[type],                        ...encodeULEB128(a ?? 0), ...encodeULEB128(b ?? 0)],
    load16_s:     () => [{ i32: 0x2e, i64: 0x32 }[type],                        ...encodeULEB128(a ?? 1), ...encodeULEB128(b ?? 0)],
    load16_u:     () => [{ i32: 0x2f, i64: 0x33 }[type],                        ...encodeULEB128(a ?? 1), ...encodeULEB128(b ?? 0)],
    load32_s:     () => [{ i64: 0x34 }[type],                                    ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    load32_u:     () => [{ i64: 0x35 }[type],                                    ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    // ── Memory Stores ────────────────────────────────────────────────────────
    store:        () => [{ i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39 }[type],  ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    store8:       () => [{ i32: 0x3a, i64: 0x3c }[type],                         ...encodeULEB128(a ?? 0), ...encodeULEB128(b ?? 0)],
    store16:      () => [{ i32: 0x3b, i64: 0x3d }[type],                         ...encodeULEB128(a ?? 1), ...encodeULEB128(b ?? 0)],
    store32:      () => [{ i64: 0x3e }[type],                                     ...encodeULEB128(a ?? 2), ...encodeULEB128(b ?? 0)],
    // ── Arithmetic ───────────────────────────────────────────────────────────
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
    // ── Comparisons ──────────────────────────────────────────────────────────
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
    // ── Type Conversions ─────────────────────────────────────────────────────
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
  return [Number(instr)]; // raw opcode fallback
}


const TYPEMAP = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

function parseCall(str) {
  str = str.trim();

  const firstParen = str.indexOf('(');

  if (firstParen === -1) {
    return { type: "identifier", name: str };
  }

  const name = str.slice(0, firstParen).trim();
  let inside = str.slice(firstParen);

  if (inside.startsWith('(') && inside.endsWith(')')) {
    inside = inside.slice(1, -1).trim();
  }
  if (inside.startsWith('(') && inside.endsWith(')')) {
    inside = inside.slice(1, -1).trim();
  }

  const args = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < inside.length; i++) {
    const char = inside[i];
    if (char === '(') { depth++; current += char; }
    else if (char === ')') { depth--; current += char; }
    else if (char === ',' && depth === 0) { args.push(current.trim()); current = ''; }
    else { current += char; }
  }
  if (current) args.push(current.trim());

  return { type: "call", name, args };
}

function recursive_expand(expression, counter = { n: 0 }) {
    const parsed = parseCall(expression);
    const instructions = [];

    if (parsed.type === "identifier") {
        const t = counter.n++;
        if (parsed.name.startsWith('"') && parsed.name.endsWith('"')) {
            const value = parsed.name.slice(1, -1);
            instructions.push(`const ${value}`);
        }
        else if (parsed.name.startsWith('global')){
            const value = parsed.name.slice("global ".length);
            instructions.push(`global.get ${value}`);
        }
        else {
            instructions.push(`get ${parsed.name}`);
        }
        instructions.push(`set compiler_${t}`);
        return { instructions, tempIndex: t };
    }

    const argTemps = [];
    for (const arg of parsed.args) {
        const result = recursive_expand(arg, counter);
        instructions.push(...result.instructions);
        argTemps.push(result.tempIndex);
    }

    for (const t of argTemps) {
        instructions.push(`get compiler_${t}`);
    }
    instructions.push(parsed.name);
    const t = counter.n++;
    instructions.push(`set compiler_${t}`);

    return { instructions, tempIndex: t };
}

function flatten(line) {
  let output = [];
  let tempIndex = 0;

  let lhs = null;
  if (line.includes("=")) {
    const parts = line.split("=");
    lhs = parts[0].trim();
    line = parts[1].trim();
  }

  function _flatten(expr) {
    const args = [];
    let funct = "";
    let temp = "";
    let level = 0;
    let i = 0;

    while (i < expr.length && expr[i] !== "(") {
      funct += expr[i];
      i++;
    }
    funct = funct.trim();
    i++;

    for (; i < expr.length; i++) {
      const char = expr[i];
      if (char === "[") {
        level++;
        if (level > 1) temp += char;
      } else if (char === "]") {
        if (level > 1) temp += char;
        level--;
        if (level === 0) {
          args.push(temp.trim());
          temp = "";
        }
      } else if (char === "," && level === 0) {
        continue;
      } else if (char === ")" && level === 0) {
        break;
      } else {
        if (level >= 1) temp += char;
      }
    }

    const tempVars = [];
    for (let j = 0; j < args.length; j++) {
      const arg = args[j];
      const tempName = `temp_${tempIndex++}`;
      if (arg.includes("(")) {
        const innerExpr = _flatten(arg);
        output.push(`${tempName} = ${innerExpr}`);
      } else {
        output.push(`${tempName} = [${arg}]`);
      }
      tempVars.push(tempName);
    }

    return `${funct}(${tempVars.map(v => `[${v}]`).join(", ")})`;
  }

  const resultExpr = _flatten(line);
  if (lhs) {
    output.push(`${lhs} = ${resultExpr}`);
  } else {
    output.push(resultExpr);
  }

  return output;
}

function inferWasmTypes(lines) {
  const typeMap = {};

  for (const line of lines) {
    const t = line.trim();
    const globalM = t.match(/^global\s+(\S+)\s+(\S+)/);
    if (globalM) { typeMap[globalM[2]] = globalM[1]; continue; }

    if (t.startsWith('export ')) {
      const tokens = t.slice(7).trim().split(/\s+/);
      let i = 1;
      while (i < tokens.length && tokens[i] !== '=>') {
        if (tokens[i + 1] && tokens[i + 1] !== '=>') typeMap[tokens[i + 1]] = tokens[i];
        i += 2;
      }
      if (tokens[i] === '=>' && tokens[i + 1]) typeMap['__return__'] = tokens[i + 1];
    }
  }

  return lines.map(line => {
    const indent = line.match(/^(\s*)/)[1];
    const t = line.trim();

    // Shape 1: temp_0 = [arg2]
    const copyM = t.match(/^(\w+)\s*=\s*\[(\w+)\]$/);
    if (copyM) {
      const [, varName, ref] = copyM;
      const inferredType = typeMap[ref];
      if (!inferredType) return line;
      typeMap[varName] = inferredType;
      return `${indent}${inferredType} ${varName} = [${ref}]`;
    }

    // Shape 2: var = operation([a], [b])
    const callM = t.match(/^(\w+)\s*=\s*(\w+)(\s*)\((.+)\)\s*$/);
    if (!callM) return line;
    const [, varName, operation, spacer, argsStr] = callM;
    const refs = [...argsStr.matchAll(/\[(\w+)\]/g)].map(m => m[1]);
    const inferredType = refs.map(r => typeMap[r]).find(t => t !== undefined);
    if (!inferredType) return line;
    typeMap[varName] = inferredType;
    return `${indent}${inferredType} ${varName} = ${operation} ${inferredType}${spacer}(${argsStr})`;
  });
}

function evaluate(lines) {
  const output = [];
  const knownLocals = new Set();
  let exportIdx = -1;

  for (const line of lines) {
    const t = line.trim();

    if (t.startsWith("global") || t.startsWith("export")) {
      // register params so we don't re-declare them
      if (t.startsWith("export")) {
        exportIdx = output.length;
        const tokens = t.slice(7).trim().split(/\s+/);
        let i = 1;
        while (i < tokens.length && tokens[i] !== '=>') {
          if (tokens[i + 1] && tokens[i + 1] !== '=>' && !["i32","i64","f32","f64"].includes(tokens[i + 1])) {
            knownLocals.add(tokens[i + 1]);
            i += 2;
          } else { i++; }
        }
      }
      output.push(line);
      continue;
    }

    const returnM = t.match(/^return\s+(\w+)$/);
    if (returnM) {
      output.push(`get ${returnM[1]}`);
      output.push(`return`);
      continue;
    }

    // Shape 1 — typed copy:  f32 temp_0 = [arg2]
    const copyM = t.match(/^(\w+)\s+(\w+)\s*=\s*\[(\w+)\]$/);
    if (copyM) {
      const [, type, dest, src] = copyM;
      if (!knownLocals.has(dest)) {
        knownLocals.add(dest);
        output.splice(exportIdx + 1, 0, `local ${type} ${dest}`);
        exportIdx++;
      }
      output.push(`get ${src}`);
      output.push(`set ${dest}`);
      continue;
    }

    // Shape 2 — typed call:  f32 var = operation f32([a], [b])
    const callM = t.match(/^(\w+)\s+(\w+)\s*=\s*(\w+)\s+(\w+)\s*\((.+)\)$/);
    if (callM) {
      const [, type, dest, operation, _opType, argsStr] = callM;
      if (!knownLocals.has(dest)) {
        knownLocals.add(dest);
        output.splice(exportIdx + 1, 0, `local ${type} ${dest}`);
        exportIdx++;
      }
      const args = [...argsStr.matchAll(/\[(\w+)\]/g)].map(m => m[1]);
      for (const arg of args) output.push(`get ${arg}`);
      output.push(`${type} ${operation}`);
      output.push(`set ${dest}`);
      continue;
    }

    output.push(line);
  }

  return output;
}

function artificialize(lines) {
  // Collect all local variable names in order of first appearance.
  // Parameters from `export` come first (they occupy the first local indices in WASM),
  // then every other variable in declaration order.
  const indexMap = {};
  let nextIndex = 0;

  function assign(name) {
    if (!(name in indexMap)) indexMap[name] = nextIndex++;
  }

  // First pass: register params from export declaration first
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("export ")) {
      const tokens = t.slice(7).trim().split(/\s+/);
      let i = 1;
      while (i < tokens.length && tokens[i] !== '=>') {
        if (tokens[i + 1] && tokens[i + 1] !== '=>') assign(tokens[i + 1]);
        i += 2;
      }
    }
  }

  // Second pass: register everything else in order
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("export") || t.startsWith("global")) continue;
    const allVars = [...t.matchAll(/\$?(\b\w+\b)/g)]
      .map(m => m[1])
      .filter(n => n in indexMap || /^(temp_\d+|var\b)/.test(n));
    for (const name of allVars) assign(name);
    // Also catch lhs of assignments directly
    const lhsM = t.match(/(?:\w+\s+)?(\w+)\s*=/);
    if (lhsM) assign(lhsM[1]);
  }

  // Replace every $name reference and local.get/set targets
  return lines.map(line => {
    const t = line.trim();
    if (t.startsWith("export") || t.startsWith("global")) return line;

    return line.replace(/\$(\w+)/g, (_, name) => {
      assign(name); // ensure late-seen names still get an index
      return String(indexMap[name]);
    });
  });
}

function preprocess(code) {
  let lines = code
    .split("\n")
    .map((l) => l.replace(/;.*$/, "").trim())
    .filter((l) => l.length > 0);

  // Flatten nested calls into temp vars
  let temp = [];
  lines.forEach((line) => {
    if (line.startsWith("export") || line.startsWith("global") || line.startsWith("return")) {
      temp.push(line);
    } else {
      temp.push(...flatten(line));
    }
  });
  lines = temp;
  console.log("after flatten:", lines);

  // Annotate variables with WASM types
  lines = inferWasmTypes(lines);
  console.log("after inferWasmTypes:", lines);

  // Emit stack machine instructions
  lines = evaluate(lines);
  console.log("after evaluate:", lines);

  // Replace variable names with numeric indices
  lines = artificialize(lines);
  console.log("after artificialize:", lines);

  return lines.join("\n");
}

export function compile(code) {

  const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // magic + version
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

        let gname;
        if (TYPEMAP[words[j]] == null) {
          gname = words[j++];
        } else {
          gname = `$g${globals.length}`;
        }

        const gtypeStr = words[j++];
        const gtype = TYPEMAP[gtypeStr];
        if (gtype == null) throw new Error(`Unknown global type: '${gtypeStr}'`);

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
          const valtype = TYPEMAP[words[words.length - 1]];
          const name = words.length > 2 ? words[1] : `$${tmp.locals.length}`;
          if (valtype == null) throw new Error(`Unknown local type: ${words[words.length - 1]}`);
          tmp.locals.push([name, valtype]);
        }
        break;
      }

      default: {
        if (tmp) {
          tmp.binary.push(...encodeWasmInstruction(process(words, tmp, globalNames, imports)));
        }
        break;
      }
    }
  }
  flushTmp();

  const importFnCount = imports.length;

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
    globals.forEach((g) => { size += 1 + 1 + g.initExpr.length; });
    binary.push(...encodeULEB128(size), ...encodeULEB128(globals.length));
    globals.forEach((g) => {
      binary.push(g.gtype, g.mutable ? 0x01 : 0x00, ...g.initExpr);
    });
  }

  // ── Section 7: Export ─────────────────────────────────────────────────────
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

  // ── Section 10: Code ──────────────────────────────────────────────────────
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

  // ── Section 11: Data ──────────────────────────────────────────────────────
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
      const input = "x = add([mul([a],[b])], [mul([c],[d])])";
      let result = "Flatten function tester - Input: ";
      result += input;
      result += "\nOutput: \n";
      // Make sure flatten is defined
      result += flatten(input);
      console.log(result); // or return result;
      return result; // return the result if you want
    case "prepro":{
      const input = `
        export add2 f32 x f32 y => f32
          var = add([x], [y])
          return var
        `.trim();

      return preprocess(input);
    }
    default:
      console.log("No test available for this function.");
      return "No test available for this function.";
  }
}