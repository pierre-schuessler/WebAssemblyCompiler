# WebAssembly Compiler

A lightweight in-browser WebAssembly assembler and runtime. Write a simple, human-readable assembly language in the textarea, hit **Assemble & Run**, and the tool compiles it to a valid `.wasm` binary on the fly, instantiates it in your browser, and calls every exported function with test arguments.

---

## How it works

The assembler reads your source line by line. Each line is either a **directive** (starting with `import` or `export`) or an **instruction**. Directives define the module's interface; instructions are the function bodies between them.

Functions are defined implicitly: every `export` line opens a new function, and all instruction lines that follow belong to it until the next `export` (or end of file). `import` lines must come before any `export`.

---

## Syntax

### Import

```
import <module> <name> <param types> => <result types>
```

Declares an external function the module can call. The function is made available at `call` index `0`, `1`, etc. in declaration order.

```
import env pow i32 i32 => i32
import env log i32 => i32
```

### Export

```
export <name> <param types> => <result types>
```

Opens a new exported function with the given name and signature. All instruction lines that follow belong to this function until the next `export` or end of file.

```
export add i32 i32 => i32
```

### Types

The following value types are supported everywhere a type is expected:

| Keyword | WASM type |
|---------|-----------|
| `i32` | 32-bit integer |
| `i64` | 64-bit integer |
| `f32` | 32-bit float |
| `f64` | 64-bit float |
| `empty` | no value (used with `if`) |

---

## Instructions

Most instructions optionally take a type as their second word (e.g. `add i32`). The default type is `i32` when omitted.

### Stack

| Instruction | Description |
|-------------|-------------|
| `const <type> <value>` | Push a literal value onto the stack |
| `drop` | Discard the top value on the stack |

```
const i32 42
const f32 3
drop
```

### Local variables

Parameters are available as locals, indexed from `0`.

| Instruction | Description |
|-------------|-------------|
| `get <index>` | Push the value of local `<index>` onto the stack |

```
get 0    ; push first parameter
get 1    ; push second parameter
```

### Arithmetic

All arithmetic instructions pop two values and push one result. The type qualifier selects the opcode.

| Instruction | Operation |
|-------------|-----------|
| `add <type>` | Addition |
| `sub <type>` | Subtraction |
| `mul <type>` | Multiplication |
| `div <type>` | Division (signed for `i32`/`i64`) |

```
get 0
get 1
add i32    ; pushes (param0 + param1)
```

### Control flow

```
if <type>
  ...true branch instructions...
else
  ...false branch instructions...
end
```

`if` pops the top of the stack. If the value is **non-zero**, the true branch executes; if it is **zero**, the false branch executes. The `else` clause is optional. The type declares what value (if any) the block leaves on the stack when it exits — use `empty` if neither branch produces a value.

> **Important:** `if` checks for zero vs. non-zero — not positive vs. non-positive. A negative number is non-zero and therefore takes the true branch. To compare values properly you need a comparison instruction that produces a `1` or `0` (not yet supported — see [Limitations](#limitations)).

```
; push a condition (non-zero = true, zero = false)
get 0
if i32
  const i32 1
else
  const i32 0
end
```

### Functions

| Instruction | Description |
|-------------|-------------|
| `call <index>` | Call a function by index (imports first, then exports) |
| `return` | Return from the current function |

```
get 0
get 1
call 0     ; call the first imported function
return
```

---

## Full example

```
import env pow i32 i32 => i32

export add i32 i32 => i32
get 0
get 1
add i32
return

export square i32 => i32
get 0
get 0
mul i32
return

export isZero i32 => i32
get 0
if i32
  const i32 0
else
  const i32 1
end
return

export pow i32 i32 => i32
get 0
get 1
call 0
return
```

The assembler displays the compiled binary (hex), instantiates the module, and calls each exported function with arguments `(5, 3)`.

---

## Imported environment functions

The runtime provides two built-in imports under the `env` module:

| Name | Signature | Behaviour |
|------|-----------|-----------|
| `pow` | `i32 i32 => i32` | Returns `x ** y` |
| `log` | `i32 => i32` | Logs the value to the console and returns it |

---

## Future features

- **Comparison opcodes** — `eq`, `ne`, `lt`, `gt`, `le`, `ge` for proper branching on comparisons
- **Local variable declarations** — declaring additional locals beyond function parameters
- **Memory instructions** — `load`, `store`, and a memory section
- **LEB-128 encoding** — proper variable-length encoding to support values above `127`
