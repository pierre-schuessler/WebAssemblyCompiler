# Language documentation

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

> **Important:** `if` checks for zero vs. non-zero — not positive vs. non-positive. A negative number is non-zero and therefore takes the true branch. To compare values properly you need a comparison instruction that produces a `1` or `0` (not yet supported — see Future features).

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