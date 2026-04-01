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

const TYPEMAP = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

export function compile(code) {
    const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // magic + version
    let types    = [],  // [{inputs: [valtype], outputs: [valtype]}]
      functions= [],  // type index for each defined function
      imports  = [],  // [{module, name, typeIndex}]
      exports  = [],  // [{name}]
      codes    = [],  // [{locals: [valtype], binary: []}]
      globals  = [],  // [{gtype, mutable, initbinary}]
      dataSegs = [],  // [{offset, binary}]
      memory   = null,
      tmp      = null; // function body currently being assembled
    
    const lines = code
    .split("\n")
    .map((l) => l.replace(/;.*$/, "").trim()) // strip inline comments
    .filter((l) => l.length > 0);
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

            }
            default:
                break;
        }
    }
    
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
        const size   = 1 + 1 + minEnc.length + maxEnc.length; // count(1) + flag + min + [max]
        binary.push(0x05, ...encodeULEB128(size));
        binary.push(0x01, hasMax ? 0x01 : 0x00, ...minEnc);
        if (hasMax) binary.push(...maxEnc);
    }

    // ── Section 6: Global ─────────────────────────────────────────────────────
    if (globals.length) {
        binary.push(0x06);
        let size = encodeULEB128(globals.length).length;
        globals.forEach((g) => { size += 2 + g.initbinary.length; }); // valtype + mut + initExpr
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
        // Group consecutive same-type locals: [i32, i32, i64] → [(2,i32),(1,i64)]
        const groups = [];
        let i = 0;
        while (i < fn.locals.length) {
            let j = i;
            while (j < fn.locals.length && fn.locals[j] === fn.locals[i]) j++;
            groups.push([j - i, fn.locals[i]]);
            i = j;
        }
        const localDecls  = groups.flatMap(([count, valtype]) => [...encodeULEB128(count), valtype]);
        const groupCount  = encodeULEB128(groups.length);
        // body = localGroupCount + localDecls + instructions + end(0x0b)
        const body = [...groupCount, ...localDecls, ...fn.binary, 0x0b];
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
        // Each segment: memidx(0) + i32.const offset end + vec(binary)
        const segs = dataSegs.map((seg) => [
        0x00,                                       // memory index (always 0)
        0x41, ...encodeSLEB128(seg.offset), 0x0b,  // offset expression
        ...encodeULEB128(seg.binary.length),         // byte vector length
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