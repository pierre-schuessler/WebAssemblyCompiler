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
    memory = compile_declaration(declaration_code, functions, exports, imports.length, executables, dataSegs);
    
    compile_executables(executable_code, functions, executables, imports);

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
        
        const [module, name]               = pathPart.split(".").map(s => s.trim());

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

function parseDataSegment(spec, rawLine) {
    // Matches: <offset> "<string>"  OR  <offset> [<byte>, <byte>, ...]
    const match = /^(\d+)\s+(?:"((?:[^"\\]|\\.)*)"|\[([^\]]*)\])$/.exec(spec);
    if (!match) {
        throw new CompilationError(
            'Invalid data syntax. Expected: data: <offset> "string" or data: <offset> [b1, b2, ...]',
            "compile_declaration",
            rawLine
        );
    }

    const offset = Number(match[1]);
    let bytes = [];

    if (match[2] !== undefined) {
        // Unescape common sequences (\n, \r, \t, \0, \\, \") and encode as UTF-8
        const unescaped = match[2].replace(/\\([nrt0\\"'])/g, (_, esc) => {
            switch (esc) {
                case "n": return "\n";
                case "r": return "\r";
                case "t": return "\t";
                case "0": return "\0";
                default:  return esc;
            }
        });
        bytes = [...new TextEncoder().encode(unescaped)];
    } else if (match[3] !== undefined) {
        bytes = match[3]
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
            .map(n => Number(n) & 0xff);
    }

    return { offset, bytes };
}

function compile_declaration(code, functions, exports, amountOfImports, executables, dataSegs = []) {
    if (!code.trim()) return null;

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

        if (service_name == "memory") {
            if (line.startsWith("min: ")) {
                memory.min = Number(line.substring(5));
            }
            if (line.startsWith("max: ")) {
                memory.max = Number(line.substring(5));
            }
            if (line.startsWith("open: ")) {
                memory.open = ["true", "yes", "y"].includes(line.substring(6).toLowerCase());
            }
            if (line.startsWith("data: ")) {
                dataSegs.push(parseDataSegment(line.substring(6).trim(), line));
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

    if (dataSegs.length > 0 && memory?.min == null) {
        throw new CompilationError(
            "Cannot define memory data segments without setting 'min:' in @memory.",
            "compile_declaration"
        );
    }

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

    const name = line.slice(typeEnd + 1).trim();

    if (!name) {
        throw new CompilationError(
            "Missing variable name after type declaration", 
            "compile_executables", line
        );
    }

    if (executable.locals.some(l => l.name === name)) {
        throw new CompilationError(
            `Local variable '${name}' was already defined in function '${fullFunctionName}'`,
            "compile_executables", line
        );
    }

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


function handleFunctionCall(rawElement, executableNames, functions, imports, binary, stacktypes, line) {
    const element = rawElement.trim();
    
    let targetIndex = imports.findIndex(imp => imp.name === element || `${imp.module}.${imp.name}` === element);
    let targetSig = null;

    if (targetIndex !== -1) {
        targetSig = imports[targetIndex];
    } else {
        const internalIndex = executableNames.indexOf(element);
        if (internalIndex !== -1) {
            targetIndex = imports.length + internalIndex; 
            targetSig = functions[internalIndex];
        }
    }

    if (targetIndex !== -1 && targetSig) {
        binary.push(...encodeWasmInstruction("call", stacktypes, [targetIndex]).opcode);
        
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


function compile_executables(code, functions, executables, imports) {
    if (!code.trim()) return;

    const executableNames = [...executables];

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
            const parsedInfo = parseFunctionSignature(line, serviceName, functions, executableNames);
            
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
                    const trimmedLine = line.trim();
                    const endsWithArrow = trimmedLine.endsWith("=>");
                    
                    const computationalElements = trimmedLine.split("=>").map(el => el.trim());
                    if (endsWithArrow) computationalElements.pop();

                    for (let i = 0; i < computationalElements.length; i++) {
                        const element = computationalElements[i];
                        const isOutput = !endsWithArrow && (i === computationalElements.length - 1);
                        
                        const isConstantElement = /^\((\w+)\)/.test(element);
                        const immMatch = /^([\w.]+)\(([^)]*)\)$/.exec(element);
                        
                        const isFunctionCall = !isConstantElement && (
                            element.includes(".") || 
                            executableNames.includes(element) || // FIX: check against safe names
                            imports.some(imp => imp.name === element || `${imp.module}.${imp.name}` === element)
                        );

                        if (immMatch) {
                            const instrName = immMatch[1];
                            const rawArgs   = immMatch[2].trim();
                            const immediates = rawArgs.length ? rawArgs.split(",").map(s => s.trim()) : [];
                            handleImmediateInstruction(instrName, immediates, binary, stacktypes, locals, line);
                        } else if (isFunctionCall) {
                            handleFunctionCall(element, executableNames, functions, imports, binary, stacktypes, line);
                        } else {
                            element.split(",").map(v => v.trim()).forEach(token => {
                                if (token) {
                                    handleToken(token, isOutput, locals, binary, stacktypes, line);
                                }
                            });
                        }
                    }

                    const lastElement = computationalElements[computationalElements.length - 1];
                    const lastToken = lastElement ? lastElement.split(",").pop().trim() : "";
                    const isReturn = (lastToken === "return");

                    if (!endsWithArrow && !isReturn && stacktypes.length > 0) {
                        throw new CompilationError(
                            "Unconsumed items left on the stack. Append '=>' to the end of the line if you intend to carry them forward.",
                            "compile_executables", 
                            line
                        );
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

        const bodies = executables.map((fn, index) => {
            if (typeof fn === 'string' || fn instanceof String)
                throw new CompilationError(`Could not find an executable for '${fn}'`, "formatBinary");

            const paramCount = functions[index].input.length;
            
            const local_values = fn.locals.slice(paramCount).map(l => l.type);

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
    const args = Array.isArray(arg) ? arg : [arg];

    const resolvePolymorphicOp = (arity, push, opcodes) => {
        if (stack.length < arity) throw new Error(`Stack underflow: '${inst}' requires ${arity} operand(s)`);
        
        const operands = stack.slice(-arity);
        const targetType = operands[0];
        
        if (!operands.every(op => op === targetType)) throw new Error(`Type mismatch for '${inst}'`);


        const typeMap = { 127: "int32", 126: "int64", 125: "float32", 124: "float64" };
        const targetTypeStr = typeMap[targetType] || targetType;
        
        const finalOpcode = opcodes[targetTypeStr];
        if (!finalOpcode) throw new Error(`Unsupported type '${targetTypeStr}' for '${inst}'`);
        
        const reverseTypeMap = { "int32": 127, "int64": 126, "float32": 125, "float64": 124 };
        const pushVal = push === "same" ? targetType : (reverseTypeMap[push] || push);

        return { 
            opcode: finalOpcode, 
            popCount: arity, 
            pushType: pushVal 
        };
    };

    switch (inst) {
        case "empty":   return { opcode: [0x40] };
        case "int32":   return { opcode: [0x7f] };
        case "int64":   return { opcode: [0x7e] };
        case "float32": return { opcode: [0x7d] };
        case "float64": return { opcode: [0x7c] };

        case "nop":     return { opcode: [0x01], popCount: 0, pushType: null };
        case "return":  return { opcode: [0x0f], popCount: 0, pushType: null };
        case "end":     return { opcode: [0x0b], popCount: 0, pushType: null };

        case "call":      return { opcode: [0x10, ...encodeULEB128(parseInt(args[0]))], popCount: 0, pushType: null };
        case "local.get": return { opcode: [0x20, ...encodeULEB128(parseInt(args[0]))], popCount: 0, pushType: null };
        case "local.set": return { opcode: [0x21, ...encodeULEB128(parseInt(args[0]))], popCount: 1, pushType: null };
        case "local.tee": return { opcode: [0x22, ...encodeULEB128(parseInt(args[0]))], popCount: 0, pushType: null };
        case "br":        return { opcode: [0x0c, ...encodeULEB128(parseInt(args[0]))], popCount: 0, pushType: null };
        case "br_if":     return { opcode: [0x0d, ...encodeULEB128(parseInt(args[0]))], popCount: 1, pushType: null };
        
        case "memory.grow": return { opcode: [0x40, 0x00], popCount: 1, pushType: "int32" };
        case "memory.size": return { opcode: [0x3f, 0x00], popCount: 0, pushType: "int32" };

        case "store": {
            if (stack.length < 2) throw new Error("Stack underflow: 'store' requires [address, value]");
            
            const valueType = stack[stack.length - 1]; 
            const bits = args[0] ? parseInt(args[0]) : null;
            
            const align = encodeULEB128(parseInt(args[1] ?? (bits ? Math.log2(bits/8) : (valueType === "int64" || valueType === "float64" ? 3 : 2))));
            const offset = encodeULEB128(parseInt(args[2] ?? 0));
            const memArgs = [...align, ...offset];

            if (valueType === "int32") {
                if (bits === 8)  return { opcode: [0x3a, ...memArgs], popCount: 2, pushType: null };
                if (bits === 16) return { opcode: [0x3b, ...memArgs], popCount: 2, pushType: null };
                if (!bits || bits === 32) return { opcode: [0x36, ...memArgs], popCount: 2, pushType: null };
            } else if (valueType === "int64") {
                if (bits === 8)  return { opcode: [0x3c, ...memArgs], popCount: 2, pushType: null };
                if (bits === 16) return { opcode: [0x3d, ...memArgs], popCount: 2, pushType: null };
                if (bits === 32) return { opcode: [0x3e, ...memArgs], popCount: 2, pushType: null };
                if (!bits || bits === 64) return { opcode: [0x37, ...memArgs], popCount: 2, pushType: null };
            } else if (valueType === "float32" && (!bits || bits === 32)) {
                return { opcode: [0x38, ...memArgs], popCount: 2, pushType: null };
            } else if (valueType === "float64" && (!bits || bits === 64)) {
                return { opcode: [0x39, ...memArgs], popCount: 2, pushType: null };
            }
            throw new Error(`Invalid bit width ${bits} or type '${valueType}' for store`);
        }

        case "load": {
            if (stack.length < 1) throw new Error("Stack underflow: 'load' requires [address]");
            
            const bits = args[0] ? parseInt(args[0]) : null;
            const targetTypeStr = args[1] || "int32";
            
            const align = encodeULEB128(parseInt(args[2] ?? (bits ? Math.log2(bits/8) : (targetTypeStr === "int64" || targetTypeStr === "float64" ? 3 : 2))));
            const offset = encodeULEB128(parseInt(args[3] ?? 0));
            const memArgs = [...align, ...offset];

            if (targetTypeStr === "int32") {
                if (bits === 8)  return { opcode: [0x2d, ...memArgs], popCount: 1, pushType: "int32" };
                if (bits === 16) return { opcode: [0x2f, ...memArgs], popCount: 1, pushType: "int32" };
                if (!bits || bits === 32) return { opcode: [0x28, ...memArgs], popCount: 1, pushType: "int32" };
            } else if (targetTypeStr === "int64") {
                if (bits === 8)  return { opcode: [0x31, ...memArgs], popCount: 1, pushType: "int64" };
                if (bits === 16) return { opcode: [0x33, ...memArgs], popCount: 1, pushType: "int64" };
                if (bits === 32) return { opcode: [0x35, ...memArgs], popCount: 1, pushType: "int64" };
                if (!bits || bits === 64) return { opcode: [0x29, ...memArgs], popCount: 1, pushType: "int64" };
            } else if (targetTypeStr === "float32" && (!bits || bits === 32)) {
                return { opcode: [0x2a, ...memArgs], popCount: 1, pushType: "float32" };
            } else if (targetTypeStr === "float64" && (!bits || bits === 64)) {
                return { opcode: [0x2b, ...memArgs], popCount: 1, pushType: "float64" };
            }
            throw new Error(`Invalid bit width ${bits} for ${targetTypeStr} load`);
        }

        case "const": {
            const type = args[0];
            switch (type) {
                case "int32":   return { opcode: [0x41], popCount: 0, pushType: "int32" };
                case "int64":   return { opcode: [0x42], popCount: 0, pushType: "int64" };
                case "float32": return { opcode: [0x43], popCount: 0, pushType: "float32" };
                case "float64": return { opcode: [0x44], popCount: 0, pushType: "float64" };
                default: throw new Error(`Unknown type '${type}' for const`);
            }
        }

        case "clz":      return resolvePolymorphicOp(1, "same", { "int32": [0x67], "int64": [0x79] });
        case "eqz":      return resolvePolymorphicOp(1, "int32", { "int32": [0x45], "int64": [0x50] });
        case "add":      return resolvePolymorphicOp(2, "same", { "int32": [0x6a], "int64": [0x7c], "float32": [0x92], "float64": [0xa0] });
        case "sub":
        case "subtract": return resolvePolymorphicOp(2, "same", { "int32": [0x6b], "int64": [0x7d], "float32": [0x93], "float64": [0xa1] });
        case "mul":      return resolvePolymorphicOp(2, "same", { "int32": [0x6c], "int64": [0x7e], "float32": [0x94], "float64": [0xa2] });

        case "if":      return { opcode: [0x04, 0x40], popCount: 1, pushType: null };
        case "else":    return { opcode: [0x05], popCount: 0, pushType: null };

        // Comparisons (Takes 2 values, returns 1 int32 boolean)
        case "eq":   return resolvePolymorphicOp(2, "int32", { "int32": [0x46], "int64": [0x51], "float32": [0x5b], "float64": [0x61] });
        case "ne":   return resolvePolymorphicOp(2, "int32", { "int32": [0x47], "int64": [0x52], "float32": [0x5c], "float64": [0x62] });
        case "lt_s": return resolvePolymorphicOp(2, "int32", { "int32": [0x48], "int64": [0x53] });
        case "lt_u": return resolvePolymorphicOp(2, "int32", { "int32": [0x49], "int64": [0x54] });
        case "gt_s": return resolvePolymorphicOp(2, "int32", { "int32": [0x4a], "int64": [0x55] });
        case "gt_u": return resolvePolymorphicOp(2, "int32", { "int32": [0x4b], "int64": [0x56] });
        case "le_s": return resolvePolymorphicOp(2, "int32", { "int32": [0x4c], "int64": [0x57] });
        case "le_u": return resolvePolymorphicOp(2, "int32", { "int32": [0x4d], "int64": [0x58] });
        case "ge_s": return resolvePolymorphicOp(2, "int32", { "int32": [0x4e], "int64": [0x59] });
        case "ge_u": return resolvePolymorphicOp(2, "int32", { "int32": [0x4f], "int64": [0x5a] });
        
        // Float-specific comparisons
        case "lt":   return resolvePolymorphicOp(2, "int32", { "float32": [0x5d], "float64": [0x63] });
        case "gt":   return resolvePolymorphicOp(2, "int32", { "float32": [0x5e], "float64": [0x64] });
        case "le":   return resolvePolymorphicOp(2, "int32", { "float32": [0x5f], "float64": [0x65] });
        case "ge":   return resolvePolymorphicOp(2, "int32", { "float32": [0x60], "float64": [0x66] });

        // Integer-only Math & Bitwise (Takes 2 values, returns same type)
        case "div_s": return resolvePolymorphicOp(2, "same", { "int32": [0x6d], "int64": [0x7f] });
        case "div_u": return resolvePolymorphicOp(2, "same", { "int32": [0x6e], "int64": [0x80] });
        case "rem_s": return resolvePolymorphicOp(2, "same", { "int32": [0x6f], "int64": [0x81] });
        case "rem_u": return resolvePolymorphicOp(2, "same", { "int32": [0x70], "int64": [0x82] });
        case "and":   return resolvePolymorphicOp(2, "same", { "int32": [0x71], "int64": [0x83] });
        case "or":    return resolvePolymorphicOp(2, "same", { "int32": [0x72], "int64": [0x84] });
        case "xor":   return resolvePolymorphicOp(2, "same", { "int32": [0x73], "int64": [0x85] });
        case "shl":   return resolvePolymorphicOp(2, "same", { "int32": [0x74], "int64": [0x86] });
        case "shr_s": return resolvePolymorphicOp(2, "same", { "int32": [0x75], "int64": [0x87] });
        case "shr_u": return resolvePolymorphicOp(2, "same", { "int32": [0x76], "int64": [0x88] });
        case "rotl":  return resolvePolymorphicOp(2, "same", { "int32": [0x77], "int64": [0x89] });
        case "rotr":  return resolvePolymorphicOp(2, "same", { "int32": [0x78], "int64": [0x8a] });
        
        // Integer unary operations (Takes 1 value, returns same type)
        case "ctz":   return resolvePolymorphicOp(1, "same", { "int32": [0x68], "int64": [0x7a] });
        case "popcnt":return resolvePolymorphicOp(1, "same", { "int32": [0x69], "int64": [0x7b] });

        // Float-only Math (Takes 1 or 2 values, returns same type)
        case "div":      return resolvePolymorphicOp(2, "same", { "float32": [0x95], "float64": [0xa3] });
        case "abs":      return resolvePolymorphicOp(1, "same", { "float32": [0x8b], "float64": [0x99] });
        case "neg":      return resolvePolymorphicOp(1, "same", { "float32": [0x8c], "float64": [0x9a] });
        case "ceil":     return resolvePolymorphicOp(1, "same", { "float32": [0x8d], "float64": [0x9b] });
        case "floor":    return resolvePolymorphicOp(1, "same", { "float32": [0x8e], "float64": [0x9c] });
        case "trunc":    return resolvePolymorphicOp(1, "same", { "float32": [0x8f], "float64": [0x9d] });
        case "nearest":  return resolvePolymorphicOp(1, "same", { "float32": [0x90], "float64": [0x9e] });
        case "sqrt":     return resolvePolymorphicOp(1, "same", { "float32": [0x91], "float64": [0x9f] });
        case "min":      return resolvePolymorphicOp(2, "same", { "float32": [0x96], "float64": [0xa4] });
        case "max":      return resolvePolymorphicOp(2, "same", { "float32": [0x97], "float64": [0xa5] });
        case "copysign": return resolvePolymorphicOp(2, "same", { "float32": [0x98], "float64": [0xa6] });

        // Control Flow 
        case "block": return { opcode: [0x02, 0x40], popCount: 0, pushType: null };
        case "loop":  return { opcode: [0x03, 0x40], popCount: 0, pushType: null };

        // Globals (Requires immediates just like local.get/set)
        case "global.get": return { opcode: [0x23, ...encodeULEB128(parseInt(args[0]))], popCount: 0, pushType: null }; 
        case "global.set": return { opcode: [0x24, ...encodeULEB128(parseInt(args[0]))], popCount: 1, pushType: null };

        default:
            return null;
    }
}