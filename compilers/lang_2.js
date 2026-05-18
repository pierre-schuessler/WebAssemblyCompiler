export function compile(code, libs = {}) {
    /*
        // DECLARATION //
        @service1
        endpoint1 : (int32) (int32) (int32) => (int32)


        // SERVICES //
        @service1
        endpoint endpoint1 (a, b, c)
        {
            temp = add(a, b)
            temp = sub(temp, c)
            return (temp)
        }

        function sub (int32 a, int32 b)
        {
            return (a - b)
        }

        // MACROS //
        add (int32 a, int32 b)
        {
            return (a + b)
        } 
    */

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

    let import_code, declaration_code, services_code, macros_code  = cleanup(code);
    imports = compile_imports(import_code)
    types, functions, exports = compile_declaration(declaration_code);
    let executable_code = merge_executables(services_code, macros_code)
    codes = compile_executables(executable_code);
    

    const result = formatBinary(types, functions, imports, exports, codes, globals, globalNames, dataSegs, memory, tmp);

    const meta = {};
    exports.forEach((e, idx) => { meta[e.name] = types[functions[idx]].inputs.length; });
    result.meta = meta;

    return result;
}

function cleanup(input) {
    // Normalize line endings and trim outer whitespace
    const code = input.replace(/\r\n/g, "\n").trim();

    // Helper: extract a block between a header and the next header
    function extractSection(startTag, endTag) {
        const startIndex = code.indexOf(startTag);
        if (startIndex === -1) return "";

        const from = startIndex + startTag.length;
        let endIndex = code.length;

        if (endTag) {
            const nextIndex = code.indexOf(endTag, from);
            if (nextIndex !== -1) endIndex = nextIndex;
        }

        return code
            .slice(from, endIndex)
            .replace(/\n+/g, "\n")     // collapse multiple newlines
            .replace(/[ \t]+/g, " ")   // collapse spaces/tabs
            .replace(/\n\s+/g, "\n")   // trim leading spaces per line
            .trim();
    }
    const imports = extractSection("// IMPORTS //", "// DECLARATION //");
    const declaration = extractSection("// DECLARATION //", "// SERVICES //");
    const services = extractSection("// SERVICES //", "// MACROS //");
    const macros = extractSection("// MACROS //", null);

    return {
        imports,
        declaration,
        services,
        macros
    };
}

function compile_declaration(code){
    let types = [], functions = [], exports = []
    code = code.split('\n')
    for (let i = 0; i < code.length; i++){
        if (code[i].startsWith("@")){
            types.push();
        }
    }
}

function formatBinary(types = [], functions = [], imports = [], exports = [], codes = [], globals = [], globalNames = [], dataSegs = [], memory = null, tmp = null){
    const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
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

    if (exports.length || memory?.open) {
        binary.push(0x07);

        const memExportName = "memory";
        const memExportNameBytes = [...memExportName].map((c) => c.charCodeAt(0));
        const totalExports = exports.length + (memory?.open ? 1 : 0);

        let size = encodeULEB128(totalExports).length;
        exports.forEach((e, idx) => {
        size += 1 + e.name.length + 1 + encodeULEB128(idx + importFnCount).length;
        });
        if (memory?.open) {
        size += 1 + memExportName.length + 1 + 1;
        }

        binary.push(...encodeULEB128(size), ...encodeULEB128(totalExports));
        exports.forEach((e, idx) => {
        binary.push(e.name.length, ...[...e.name].map((c) => c.charCodeAt(0)));
        binary.push(0x00, ...encodeULEB128(idx + importFnCount));
        });
        if (memory?.open) {
        binary.push(memExportName.length, ...memExportNameBytes);
        binary.push(0x02, 0x00);
        }
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

    return ( new Uint8Array(binary) );
}


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

function encodeWasmInstruction(instruction){
    const bt = { empty: 0x40, i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
    if (instruction in bt){
        return bt[instruction];
    }
}