class CompilationError extends Error {
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
    this.name       = "CompilationError";
    this.stage      = stage;
    this.sourceLine = line;
    this.lineNo     = lineNo;
  }
}


export function compile(code, libs = {}) {

    let functions   = [],
        imports     = [],
        exports     = [],
        executables = [],
        globals     = [],
        dataSegs    = [],
        memory      = null;

    let { imports: import_code, declaration: declaration_code, bodies: bodies_code, macros: macros_code } = cleanup(code);
    let executable_code = merge_executables(bodies_code, macros_code);

    compile_imports(import_code, imports);
    memory = compile_declaration(declaration_code, functions, exports, imports.length, executables, memory);
    compile_executables(executable_code, functions, executables);

    const exportsForBinary = {};
    const meta = {};

    exports.forEach((e, idx) => {
        exportsForBinary[e.name] = e.index !== undefined ? e.index : idx;
        meta[e.name] = e.signature;
    });

    const result = formatBinary(functions, imports, exportsForBinary, executables, globals, dataSegs, memory);

    result.meta = meta;

    return result;
}

function cleanup(input) {
    input = input
        .split("\n")
        .map(l => l.replace(/#.*$/, "").trim())
        .filter(l => l.length > 0)
        .join("\n");

    const code = input.replace(/\r\n/g, "\n").trim();

    const requiredSections = [
        "// IMPORTS //",
        "// DECLARATIONS //",
        "// BODIES //",
        "// MACROS //"
    ];

    requiredSections.forEach(section => {
        if (!code.includes(section)) {
            throw new CompilationError(
                `Missing or misspelled section header. Expected to find exactly: ${section}`,
                "cleanup"
            );
        }
    });

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

    const imports     = extractSection("// IMPORTS //",      "// DECLARATIONS //");
    const declaration = extractSection("// DECLARATIONS //", "// BODIES //");
    const bodies      = extractSection("// BODIES //",       "// MACROS //");
    const macros      = extractSection("// MACROS //",       null);

    return { imports, declaration, bodies, macros };
}

function merge_executables(executable1, executable2) {
    if (executable2.trim()) throw new CompilationError(
        "Macros are not supported yet. Please remove any macro code.",
        "merge_executables"
    );
    return executable1;
}

function compile_imports(code, imports) {
    if (!code.trim()) return;

    code.split("\n").forEach((line) => {
        if (!line.trim()) return;

        const [definitionPart, outputPart] = line.split("=>").map(s => s.trim());
        const [pathPart, inputPart]        = definitionPart.split(":").map(s => s.trim());
        const [module, name]               = pathPart.split(".");

        const extractTypes = (typeString) => {
            if (!typeString) return [];
            const matches = [...typeString.matchAll(/\(([^)]+)\)/g)];
            return matches.map(match => encodeWasmInstruction(match[1]).opcode[0]);
        };

        imports.push({
            module,
            name,
            input:  extractTypes(inputPart),
            output: extractTypes(outputPart)
        });
    });
}

function compile_declaration(code, functions, exports, amountOfImports, executables) {
    if (!code.trim()) return;

    let service_name;
    const lines = code.split("\n");
    let memory = null;

    lines.forEach((line) => {
        if (!line.trim()) return;

        if (line.startsWith("@")) {
            service_name = line.substring(1).trim();
            if (service_name == "memory") memory = {};
            return;
        }

        if (service_name == "memory"){
            if(line.startsWith("min: ")) {
                memory.min = Number(line.substring(5))
            }
            if(line.startsWith("max: ")) {
                memory.max = Number(line.substring(5))
            }
            if(line.startsWith("open: ")) {
                memory.open = line.substring(6) === "true"
            }
            return;
        }
        

        if (!service_name) throw new CompilationError(
            "The declaration part must start with the opening of a new service via the @ syntax",
            "compile_declaration"
        );

        let clean_line;
        if      (line.startsWith("internal ")) clean_line = line.substring(9);
        else if (line.startsWith("endpoint "))  clean_line = line.substring(9);
        else throw new CompilationError(
            "Declarations must either be an endpoint or internal.",
            "compile_declaration"
        );

        const [definitionPart, outputPart] = clean_line.split("=>").map(s => s.trim());
        const [name, inputPart]            = definitionPart.split(":").map(s => s.trim());

        const extractTypes = (typeString) => {
            if (!typeString) return [];
            const matches = [...typeString.matchAll(/\(([^)]+)\)/g)];
            return matches.map(match => encodeWasmInstruction(match[1]).opcode[0]);
        };

        const signature = {
            input:  extractTypes(inputPart),
            output: extractTypes(outputPart)
        };

        executables.push(service_name.concat(".", name));
        functions.push(signature);

        if (line.startsWith("endpoint ")) {
            exports.push({
                name:      service_name.concat(".", name),
                index:     amountOfImports + (functions.length - 1),
                signature
            });
        }
    });
    return memory;
}

function extractTypes(typeString) {
    if (!typeString) return [];
    const matches = [...typeString.matchAll(/\(([^)]+)\)/g)];
    return matches.map(match => encodeWasmInstruction(match[1]).opcode[0]);
}

function parseFunctionSignature(line, serviceName, functions, executables) {
    const cleanLine = line.substring(9);
    const [definitionPart, outputPart] = cleanLine.split("=>").map(s => s.trim());
    const [name, inputPart]            = definitionPart.split(":").map(s => s.trim());

    if (!name) throw new CompilationError(
        "You must specify the name of the function.",
        "compile_executables", line
    );

    if (inputPart === undefined || outputPart === undefined) throw new CompilationError(
        `Missing signature. Expected format: endpoint ${name}: (type)... => (type)...`,
        "compile_executables", line
    );

    const bodyInput  = extractTypes(inputPart);
    const bodyOutput = extractTypes(outputPart);

    const key = `${serviceName}.${name}`;
    const functionIndex = executables.indexOf(key);

    if (functionIndex === -1) throw new CompilationError(
        `Function "${key}" was not found in the declaration.`,
        "compile_executables"
    );

    const declared = functions[functionIndex];
    if (
        JSON.stringify(bodyInput)  !== JSON.stringify(declared.input) ||
        JSON.stringify(bodyOutput) !== JSON.stringify(declared.output)
    ) throw new CompilationError(
        `Signature mismatch for "${key}". ` +
        `Body says (${bodyInput}) => (${bodyOutput}) ` +
        `but declaration says (${declared.input}) => (${declared.output}).`,
        "compile_executables", line
    );

    const initialLocals = bodyInput.map((type, index) => ({ name: `arg${index}`, type }));
    return { key, functionIndex, initialLocals };
}

function handleVariableCreation(line, executable, fullFunctionName) {
    const remainder    = line.slice(7).trimStart();
    const nameEndMatch = remainder.match(/[\s(]/);
    const nameEndIndex = nameEndMatch ? nameEndMatch.index : remainder.length;
    const name         = remainder.slice(0, nameEndIndex);

    if (executable.locals.some(l => l.name === name)) {
        throw new CompilationError(
            `Local variable '${name}' was already defined in function '${fullFunctionName}'`,
            "compile_executables", line
        );
    }

    const typeStart = line.indexOf("(");
    const typeEnd   = line.indexOf(")", typeStart);

    if (typeStart === -1 || typeEnd === -1) {
        throw new CompilationError(
            "Missing parentheses for type declaration",
            "compile_executables", line
        );
    }

    const rawType = line.slice(typeStart + 1, typeEnd).trim();
    const type    = encodeWasmInstruction(rawType).opcode[0];

    executable.locals.push({ name, type });
}


function handleInstruction(instructionName, binary, stacktypes, line, notFoundMessage) {
    const instructionData = encodeWasmInstruction(instructionName, stacktypes);
    if (instructionData) {
        binary.push(...instructionData.opcode);
        if (instructionData.popCount !== undefined) {
            for (let p = 0; p < instructionData.popCount; p++) stacktypes.pop();
            if (instructionData.pushType) stacktypes.push(instructionData.pushType);
        }
    } else {
        throw new CompilationError(notFoundMessage, "compile_executables", line);
    }
}

function handleImmediateInstruction(instructionName, immediates, binary, stacktypes, locals, line) {
    const result = encodeWasmInstruction(instructionName, stacktypes, immediates);
    if (!result) throw new CompilationError(
        `Unknown immediate instruction: '${instructionName}'`,
        "compile_executables", line
    );
    binary.push(...result.opcode);
    for (let i = 0; i < (result.popCount ?? 0); i++) stacktypes.pop();
    if (result.pushType != null) stacktypes.push(result.pushType);
}

function handleFunctionCall(element, executables, functions, binary, stacktypes, line) {
    const targetFunctionIndex = executables.indexOf(element);
    if (targetFunctionIndex !== -1) {
        binary.push(...encodeWasmInstruction("call", stacktypes, [targetFunctionIndex]).opcode);
        
        const targetSig = functions[targetFunctionIndex];
        for (let p = 0; p < targetSig.input.length; p++) stacktypes.pop();
        for (let p = 0; p < targetSig.output.length; p++) stacktypes.push(targetSig.output[p]);
    } else {
        handleInstruction(element, binary, stacktypes, line, `Function '${element}' not found.`);
    }
}

function handleConstant(token, binary, stacktypes, line) {
    const constMatch = /^\((\w+)\)(.+)$/.exec(token);
    if (!constMatch) return false;

    const typeName = constMatch[1];
    const valueStr = constMatch[2].trim();
    const typeCode = encodeWasmInstruction(typeName).opcode[0];

    if (typeCode === undefined)
        throw new CompilationError(`Unknown type '${typeName}' in constant`, "compile_executables", line);

    const constRes = encodeWasmInstruction("const", [], typeName);
    const constOpcode = constRes.opcode ? constRes.opcode : constRes;
    if (!constOpcode)
        throw new CompilationError(`Type '${typeName}' does not support const`, "compile_executables", line);

    binary.push(...constOpcode);

    if      (typeName === "int32")   binary.push(...encodeSLEB128(parseInt(valueStr, 10)));
    else if (typeName === "int64")   binary.push(...encodeSLEB128(parseInt(valueStr, 10)));
    else if (typeName === "float32") binary.push(...encodeF32(parseFloat(valueStr)));
    else if (typeName === "float64") binary.push(...encodeF64(parseFloat(valueStr)));

    stacktypes.push(typeCode);
    return true;
}

function handleToken(token, isOutput, locals, binary, stacktypes, line) {
    const localIndex = locals.findIndex(l => l.name === token);

    
    if (localIndex !== -1) {
        if (isOutput) {
            binary.push(...encodeWasmInstruction("local.set", stacktypes, [localIndex]).opcode);
            stacktypes.pop();
        } else {
            binary.push(...encodeWasmInstruction("local.get", stacktypes, [localIndex]).opcode);
            stacktypes.push(locals[localIndex].type);
        }
        return;
    }
    
    if (!isOutput && handleConstant(token, binary, stacktypes, line)) {
        return;
    }

    
    handleInstruction(token, binary, stacktypes, line, `Local variable '${token}' not found.`);
}


function compile_executables(code, functions, executables) {
    if (!code.trim()) return;

    let serviceName;
    let functionIndex;
    let depth = 0;
    const lines = code.split("\n");
    let fullFunctionName;
    let stacktypes = [];

    lines.forEach((line) => {
        if (!line.trim()) return;

        const isDepth0Line = line.startsWith("@") || line.startsWith("internal ") || line.startsWith("endpoint ");
        if (isDepth0Line && depth !== 0) throw new CompilationError("One function must be closed before beginning another.", "compile_executables", line);
        if (!isDepth0Line && depth === 0 && line !== '{' && line !== '}') throw new CompilationError("The functions body must be enclosed in { }", "compile_executables", line);

        if (line.startsWith("@")) {
            serviceName = line.substring(1).trim();

        } else if (line.startsWith("internal ") || line.startsWith("endpoint ")) {
            const parsedInfo = parseFunctionSignature(line, serviceName, functions, executables);
            
            functionIndex    = parsedInfo.functionIndex;
            fullFunctionName = parsedInfo.key;
            stacktypes       = [];
            
            executables[functionIndex] = { locals: parsedInfo.initialLocals, binary: [] };

        } else {
            if (line === '{') {
                depth++;
            } else if (line === '}') {
                depth--;
                if (depth === 0) {
                    executables[functionIndex].binary.push(encodeWasmInstruction("end").opcode[0]);
                }
            } else {
                const executable = executables[functionIndex];
                const binary     = executable.binary;
                const locals     = executable.locals;

                if (line.startsWith("create ")) {
                    handleVariableCreation(line, executable, fullFunctionName);
                } else {
                    const computationalElements = line.split("=>").map(el => el.trim());

                    for (let i = 0; i < computationalElements.length; i++) {
                        const element = computationalElements[i];
                        const isConstantElement = /^\((\w+)\)/.test(element);
                        const isOutput = (i === computationalElements.length - 1);

                        const immMatch = /^([\w.]+)\(([^)]*)\)$/.exec(element);
                        if (immMatch) {
                            const instrName = immMatch[1];
                            const rawArgs   = immMatch[2].trim();
                            const immediates      = rawArgs.length ? rawArgs.split(",").map(s => s.trim()) : [];
                            handleImmediateInstruction(instrName, immediates, binary, stacktypes, locals, line);
                        } else if (!isConstantElement && element.includes(".")) {
                            handleFunctionCall(element, executables, functions, binary, stacktypes, line);
                        } else {
                            element.split(",").map(v => v.trim()).forEach(token => {
                                handleToken(token, isOutput, locals, binary, stacktypes, line);
                            });
                        }
                    }
                }
            }
        }
    });
}

/*
FormatBinary arguments
functions:   Array of function signatures defined in this module.
             Example: [ { input: [127, 127], output: [127] } ]  (127 = i32)
imports:     Array of functions to import from the host environment.
             Example: [ { module: "env", name: "log", input: [127], output: [] } ]
exports:     Object mapping export names to their absolute function indices.
             Example: { main: 0, "test": 2 }
             Note: index is absolute — if you have 1 import, your first internal fn is index 1.
executables: Array of function bodies matching the `functions` array.
             Example: [ { locals: [{ name: "x", type: 127 }], binary: [0x20, 0x00, 0x0b] } ]
globals:     Array of global variable definitions.
             Example: [ { gtype: 127, mutable: true, initExpr: [0x41, 0x00, 0x0b] } ]
dataSegs:    Array of data segments to initialise memory.
             Example: [ { offset: 0, bytes: [0x68, 0x69] } ]
memory:      Object defining memory requirements.
             Example: { min: 1, max: 2, open: true }  (open = export "memory")
*/
function formatBinary(functions = [], imports = [], exports = {}, executables = [], globals = [], dataSegs = [], memory = null) {
    const binary = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    const types = [];
    const getOrAddType = (input = [], output = []) => {
        const sig = JSON.stringify({ input, output });
        const idx = types.findIndex(t => JSON.stringify({ input: t.input, output: t.output }) === sig);
        if (idx !== -1) return idx;
        types.push({ input, output });
        return types.length - 1;
    };

    const mapped_imports    = imports.map(imp => ({ ...imp, typeIndex: getOrAddType(imp.input, imp.output) }));
    const func_type_indices = functions.map(fn  => getOrAddType(fn.input, fn.output));

    // Section 1 — Type
    if (types.length) {
        binary.push(0x01);
        let size = encodeULEB128(types.length).length;
        types.forEach((t) => { size += 1 + 1 + t.input.length + 1 + t.output.length; });
        binary.push(...encodeULEB128(size), ...encodeULEB128(types.length));
        types.forEach((t) => {
            binary.push(0x60, t.input.length, ...t.input, t.output.length, ...t.output);
        });
    }

    // Section 2 — Import
    if (mapped_imports.length) {
        binary.push(0x02);
        const enc_imp = mapped_imports.map((imp) => {
            const mod = [...imp.module].map((c) => c.charCodeAt(0));
            const nm  = [...imp.name].map((c)   => c.charCodeAt(0));
            return [mod.length, ...mod, nm.length, ...nm, 0x00, ...encodeULEB128(imp.typeIndex)];
        });
        let size = encodeULEB128(mapped_imports.length).length;
        enc_imp.forEach((e) => (size += e.length));
        binary.push(...encodeULEB128(size), ...encodeULEB128(mapped_imports.length));
        enc_imp.forEach((e) => binary.push(...e));
    }

    // Section 3 — Function
    if (func_type_indices.length) {
        binary.push(0x03);
        let size = encodeULEB128(func_type_indices.length).length;
        func_type_indices.forEach((type_idx) => { size += encodeULEB128(type_idx).length; });
        binary.push(...encodeULEB128(size), ...encodeULEB128(func_type_indices.length));
        func_type_indices.forEach((type_idx) => binary.push(...encodeULEB128(type_idx)));
    }

    // Section 5 — Memory
    if (memory) {
        const has_max = memory.max != null;
        const min_enc = encodeULEB128(memory.min);
        const max_enc = has_max ? encodeULEB128(memory.max) : [];
        const size    = 1 + 1 + min_enc.length + max_enc.length;
        binary.push(0x05, ...encodeULEB128(size));
        binary.push(0x01, has_max ? 0x01 : 0x00, ...min_enc);
        if (has_max) binary.push(...max_enc);
    }

    // Section 6 — Global
    if (globals.length) {
        binary.push(0x06);
        let size = encodeULEB128(globals.length).length;
        globals.forEach((g) => { size += 1 + 1 + g.initExpr.length; });
        binary.push(...encodeULEB128(size), ...encodeULEB128(globals.length));
        globals.forEach((g) => {
            binary.push(g.gtype, g.mutable ? 0x01 : 0x00, ...g.initExpr);
        });
    }

    // Section 7 — Export
    const export_entries = Object.entries(exports);
    if (export_entries.length || memory?.open) {
        binary.push(0x07);

        const mem_export_name       = "memory";
        const mem_export_name_bytes = [...mem_export_name].map((c) => c.charCodeAt(0));
        const total_exports         = export_entries.length + (memory?.open ? 1 : 0);

        let size = encodeULEB128(total_exports).length;
        export_entries.forEach(([name, idx]) => {
            size += 1 + name.length + 1 + encodeULEB128(idx).length;
        });
        if (memory?.open) size += 1 + mem_export_name.length + 1 + 1;

        binary.push(...encodeULEB128(size), ...encodeULEB128(total_exports));
        export_entries.forEach(([name, idx]) => {
            binary.push(name.length, ...[...name].map((c) => c.charCodeAt(0)));
            binary.push(0x00, ...encodeULEB128(idx));
        });
        if (memory?.open) {
            binary.push(mem_export_name.length, ...mem_export_name_bytes);
            binary.push(0x02, 0x00);
        }
    }

    // Section 10 — Code
    if (executables.length) {
        binary.push(0x0a);

        const bodies = executables.map((fn) => {
            if (typeof fn === 'string' || fn instanceof String)
                throw new CompilationError(`Could not find an executable for '${fn}'`, "formatBinary");

            const local_values = fn.locals.map(l => l.type);

            // Run-length encode locals by type
            const groups = [];
            let i = 0;
            while (i < local_values.length) {
                let j = i;
                while (j < local_values.length && local_values[j] === local_values[i]) j++;
                groups.push([j - i, local_values[i]]);
                i = j;
            }
            const local_decls = groups.flatMap(([count, valtype]) => [...encodeULEB128(count), valtype]);
            const group_count = encodeULEB128(groups.length);
            const body = [...group_count, ...local_decls, ...fn.binary];
            return [...encodeULEB128(body.length), ...body];
        });

        let size = encodeULEB128(executables.length).length;
        bodies.forEach((b) => (size += b.length));
        binary.push(...encodeULEB128(size), ...encodeULEB128(executables.length));
        bodies.forEach((b) => binary.push(...b));
    }

    // Section 11 — Data
    if (dataSegs.length) {
        binary.push(0x0b);

        const I32_CONST = encodeWasmInstruction("const", [], "int32").opcode[0];
        const END       = encodeWasmInstruction("end").opcode[0];

        const segs = dataSegs.map((seg) => [
            0x00,
            I32_CONST, ...encodeSLEB128(seg.offset), END,
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


function encodeWasmInstruction(inst, stack = [], arg = null) {

    const valueTypes = {
        empty:   { opcode: [0x40] },
        int32:   { opcode: [0x7f] },
        int64:   { opcode: [0x7e] },
        float32: { opcode: [0x7d] },
        float64: { opcode: [0x7c] },
    };
    if (valueTypes[inst] !== undefined) return valueTypes[inst];

    if (Array.isArray(arg)) {
        const immediateOps = {
            "call":        { opcode: [0x10], encodeArg: (args) => encodeULEB128(parseInt(args[0])), popCount: 0, pushType: null },
            "local.get":   { opcode: [0x20], encodeArg: (args) => encodeULEB128(parseInt(args[0])), popCount: 0, pushType: null },
            "local.set":   { opcode: [0x21], encodeArg: (args) => encodeULEB128(parseInt(args[0])), popCount: 1, pushType: null },
            "local.tee":   { opcode: [0x22], encodeArg: (args) => encodeULEB128(parseInt(args[0])), popCount: 0, pushType: null },
            "br":          { opcode: [0x0c], encodeArg: (args) => encodeULEB128(parseInt(args[0])), popCount: 0, pushType: null },
            "br_if":       { opcode: [0x0d], encodeArg: (args) => encodeULEB128(parseInt(args[0])), popCount: 1, pushType: null },
            "memory.grow": { opcode: [0x40], encodeArg: (_) => [0x00], popCount: 1, pushType: 0x7f },
            "memory.size": { opcode: [0x3f], encodeArg: (_) => [0x00], popCount: 0, pushType: 0x7f },
            
            "i32.load":    { opcode: [0x28], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 2)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 1, pushType: 0x7f },
            "i64.load":    { opcode: [0x29], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 3)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 1, pushType: 0x7e },
            "f32.load":    { opcode: [0x2a], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 2)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 1, pushType: 0x7d },
            "f64.load":    { opcode: [0x2b], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 3)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 1, pushType: 0x7c },
            
            "i32.store":   { opcode: [0x36], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 2)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 2, pushType: null },
            "i64.store":   { opcode: [0x37], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 3)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 2, pushType: null },
            "f32.store":   { opcode: [0x38], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 2)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 2, pushType: null },
            "f64.store":   { opcode: [0x39], encodeArg: (args) => [...encodeULEB128(parseInt(args[0] ?? 3)), ...encodeULEB128(parseInt(args[1] ?? 0))], popCount: 2, pushType: null },
        };

        const entry = immediateOps[inst];
        if (!entry) return null;

        return {
            opcode:   [...entry.opcode, ...entry.encodeArg(arg)],
            popCount: entry.popCount,
            pushType: entry.pushType,
        };
    }

    const simpleOps = {
        nop:          { opcode: [0x01] },
        "return":     { opcode: [0x0f] },
        end:          { opcode: [0x0b] }
    };
    if (simpleOps[inst] !== undefined) return simpleOps[inst];

    if (inst === "const") {
        const constOpcodes = {
            int32:   [0x41],
            int64:   [0x42],
            float32: [0x43],
            float64: [0x44],
        };
        if (constOpcodes[arg] !== undefined) return { opcode: constOpcodes[arg], popCount: 0, pushType: valueTypes[arg].opcode[0] };
        throw new CompilationError(`Unknown type '${arg}' for const instruction`);
    }

    const I32 = encodeWasmInstruction("int32").opcode[0];

    const numericOps = {
        clz:      { arity: 1, push: "same", opcodes: { 0x7f: [0x67], 0x7e: [0x79] } },
        eqz:      { arity: 1, push: I32,    opcodes: { 0x7f: [0x45], 0x7e: [0x50] } },
        add:      { arity: 2, push: "same", opcodes: { 0x7f: [0x6a], 0x7e: [0x7c], 0x7d: [0x92], 0x7c: [0xa0] } },
        sub:      { arity: 2, push: "same", opcodes: { 0x7f: [0x6b], 0x7e: [0x7d], 0x7d: [0x93], 0x7c: [0xa1] } },
        subtract: { arity: 2, push: "same", opcodes: { 0x7f: [0x6b], 0x7e: [0x7d], 0x7d: [0x93], 0x7c: [0xa1] } },
        mul:      { arity: 2, push: "same", opcodes: { 0x7f: [0x6c], 0x7e: [0x7e], 0x7d: [0x94], 0x7c: [0xa2] } },
    };

    const operation = numericOps[inst];
    if (!operation) return null;

    const { arity, push, opcodes } = operation;

    if (stack.length < arity)
        throw new CompilationError(`Stack underflow: '${inst}' requires ${arity} operand(s)`);

    const operands   = stack.slice(-arity);
    const targetType = operands[0];

    if (!operands.every(op => op === targetType)) {
        const typesStr = operands.map(op => `0x${op.toString(16)}`).join(", ");
        throw new CompilationError(`Type mismatch for '${inst}': all ${arity} operands must match. Got [${typesStr}]`);
    }

    const finalOpcode = opcodes[targetType];
    if (!finalOpcode)
        throw new CompilationError(`Unsupported type 0x${targetType.toString(16)} for '${inst}'`);

    return {
        opcode:   finalOpcode,
        popCount: arity,
        pushType: push === "same" ? targetType : push,
    };
}