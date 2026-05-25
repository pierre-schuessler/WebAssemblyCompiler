class PreprocessError extends Error {
  /**
   * @param {string} message   Human-readable description
   * @param {string} stage     Pipeline stage where the error occurred
   * @param {string} [line]    Source line that triggered the error (optional)
   * @param {number} [lineNo]  1-based line index in the *original* source (optional)
   */
  constructor(message, stage, line = null, lineNo = null) {
    const loc  = lineNo != null ? ` (line ${lineNo})` : "";
    const src  = line   != null ? `\n  → ${line}`     : "";
    super(`[${stage}]${loc} ${message}${src}`);
    this.name      = "PreprocessError";
    this.stage     = stage;
    this.sourceLine = line;
    this.lineNo    = lineNo;
  }
}


export function compile(code, libs = {}) {

    let functions   = [],
    imports     = [], 
    exports     = [],
    codes       = [],
    globals     = [],
    dataSegs    = [],
    memory      = null;

    let { imports: import_code, declaration: declaration_code, services: services_code, macros: macros_code } = cleanup(code);
    let executable_code = merge_executables(services_code, macros_code);

    compile_imports(import_code, imports);
    compile_declaration(declaration_code, functions, exports, imports.length);
    compile_executables(executable_code, functions, codes);

    const exportsForBinary = {};
    const meta = {};

    exports.forEach((e, idx) => {
        exportsForBinary[e.name] = e.index !== undefined ? e.index : idx; 
        meta[e.name] = e.signature;
    });

    const result = formatBinary(functions, imports, exportsForBinary, codes, globals, dataSegs, memory);

    result.meta = meta;

    return result;
}

function cleanup(input) {
    const code = input.replace(/\r\n/g, "\n").trim();

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
            .replace(/\n+/g, "\n")
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s+/g, "\n")
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

function merge_executables(executable1, executable2){
    if (!executable2.trim()) throw new PreprocessError("Macros are not supported yet. Please remove any macro code.", "merge_executables")
    return executable1;
}

function compile_imports(code, imports){
    code.split("\n").forEach((line)=>{
        const [definitionPart, outputPart] = line.split('=>').map(s => s.trim());

        const [pathPart, inputPart] = definitionPart.split(':').map(s => s.trim());

        
        const [module, name] = pathPart.split('.');

        
        const extractTypes = (typeString) => {
            if (!typeString) return [];
            const matches = [...typeString.matchAll(/\(([^)]+)\)/g)];
            return matches.map(match => encodeWasmInstruction(match[1]));
        };

        imports.push({
            module: module,
            name: name,
            input: extractTypes(inputPart),
            output: extractTypes(outputPart)
        });
    })
}

function compile_declaration(code, functions, exports, AmountOfImports){
    let service_name = null
    const lines = code.split("\n")
    lines.forEach((line)=>{
        if (line.startsWith("@")) service_name = line.substring(1).trim()
        else {
            if (!service_name) throw new PreprocessError("The declaration part must start with the opening of a new service via the @ syntax", "compile_declaration")
            const [definitionPart, outputPart] = line.split('=>').map(s => s.trim());

            const [name, inputPart] = definitionPart.split(':').map(s => s.trim());

            const extractTypes = (typeString) => {
                if (!typeString) return [];
                const matches = [...typeString.matchAll(/\(([^)]+)\)/g)];
                return matches.map(match => encodeWasmInstruction(match[1]));
            };

            functions.push({
                input: extractTypes(inputPart),
                output: extractTypes(outputPart)
            })
            exports.push({
                name: service_name.concat(".", name),
                index: AmountOfImports + (functions.length - 1)
            });
        }
    })
}
function compile_executables(executable_code, functions, codes){}



/*
FormatBinary arguments
functions: Array of function signatures defined in this module.
           Example: [ { input: [127, 127], output: [127] } ] (where 127 is i32)
imports: Array of functions to import from the host environment.
         Example: [ { module: "env", name: "log", input: [127], output: [] } ]
exports: Object mapping export names to their absolute function indices.
         Example: { main: 0, "test": 2 }
         Note: The index is absolute. If you have 1 import, your first internal function is at index 1.
codes: Array of function bodies matching the `functions` array.
       Example: [ { locals: [["x", 127], ["y", 127]], binary: [0x20, 0x00, 0x0b] } ]
       Note: `locals` must include the function parameters first, followed by internal locals.
globals: Array of global variable definitions.
         Example: [ { gtype: 127, mutable: true, initExpr: [0x41, 0x00, 0x0b] } ]
dataSegs: Array of data segments to initialize memory.
          Example: [ { offset: [0x41, 0x00, 0x0b], bytes: [0x68, 0x69] } ]
memory: Object defining memory requirements.
        Example: { min: 1, max: 2, open: true } (open defines if "memory" is exported)
*/
function formatBinary(functions = [], imports = [], exports = {}, codes = [], globals = [], dataSegs = [], memory = null) {
    const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    const types = [];
    const getOrAddType = (input = [], output = []) => {
        const sig = JSON.stringify({ input, output });
        const idx = types.findIndex(t => JSON.stringify({ input: t.input, output: t.output }) === sig);
        if (idx !== -1) return idx;
        types.push({ input, output });
        return types.length - 1;
    };

    const mappedImports = imports.map(imp => ({
        ...imp,
        typeIndex: getOrAddType(imp.input, imp.output)
    }));
    
    const funcTypeIndices = functions.map(fn => getOrAddType(fn.input, fn.output));

    if (types.length) {
        binary.push(0x01);
        let size = encodeULEB128(types.length).length;
        types.forEach((t) => { size += 1 + 1 + t.input.length + 1 + t.output.length; });
        binary.push(...encodeULEB128(size), ...encodeULEB128(types.length));
        types.forEach((t) => {
            binary.push(0x60, t.input.length, ...t.input, t.output.length, ...t.output);
        });
    }

    if (mappedImports.length) {
        binary.push(0x02);
        const encImp = mappedImports.map((imp) => {
            const mod = [...imp.module].map((c) => c.charCodeAt(0));
            const nm  = [...imp.name].map((c) => c.charCodeAt(0));
            return [mod.length, ...mod, nm.length, ...nm, 0x00, ...encodeULEB128(imp.typeIndex)];
        });
        let size = encodeULEB128(mappedImports.length).length;
        encImp.forEach((e) => (size += e.length));
        binary.push(...encodeULEB128(size), ...encodeULEB128(mappedImports.length));
        encImp.forEach((e) => binary.push(...e));
    }

    if (funcTypeIndices.length) {
        binary.push(0x03);
        let size = encodeULEB128(funcTypeIndices.length).length;
        funcTypeIndices.forEach((typeIdx) => { size += encodeULEB128(typeIdx).length; });
        binary.push(...encodeULEB128(size), ...encodeULEB128(funcTypeIndices.length));
        funcTypeIndices.forEach((typeIdx) => binary.push(...encodeULEB128(typeIdx)));
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

    const exportEntries = Object.entries(exports);
    if (exportEntries.length || memory?.open) {
        binary.push(0x07);

        const memExportName = "memory";
        const memExportNameBytes = [...memExportName].map((c) => c.charCodeAt(0));
        const totalExports = exportEntries.length + (memory?.open ? 1 : 0);

        let size = encodeULEB128(totalExports).length;
        exportEntries.forEach(([name, idx]) => {
            size += 1 + name.length + 1 + encodeULEB128(idx).length;
        });
        if (memory?.open) {
            size += 1 + memExportName.length + 1 + 1;
        }

        binary.push(...encodeULEB128(size), ...encodeULEB128(totalExports));
        exportEntries.forEach(([name, idx]) => {
            binary.push(name.length, ...[...name].map((c) => c.charCodeAt(0)));
            binary.push(0x00, ...encodeULEB128(idx));
        });
        if (memory?.open) {
            binary.push(memExportName.length, ...memExportNameBytes);
            binary.push(0x02, 0x00);
        }
    }

    if (codes.length) {
        binary.push(0x0a);

        const bodies = codes.map((fn, fnIdx) => {
            const paramCount  = functions[fnIdx].input.length; 
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

    return new Uint8Array(binary);
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
    const bt = { empty: 0x40, int32: 0x7f, int64: 0x7e, float32: 0x7d, float64: 0x7c };
    if (instruction in bt){
        return bt[instruction];
    }
}