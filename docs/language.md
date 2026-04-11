# Language Reference

---

## Top-level directives

### `#include`

```
#include <libname>
```

Includes a named library, inserting its lines in place of the directive before compilation begins. Library names have no extension — they are looked up by name in the compiler's library map. Include directives are resolved first, before any other processing, so included code may itself contain `import`, `global`, `export`, and other top-level directives.

```
#include <math>
#include <string>
```

If the named library is not registered with the compiler, an error is thrown at compile time.

---

### `memory`

```
memory <min>[-<max>]
```

Declares a linear memory. Sizes are in **pages** (1 page = 64 KB). At most one `memory` directive is allowed per module.

```
memory 1        // 1 page, no maximum
memory 1-16     // 1 page minimum, 16 page maximum
```

---

### `import`

```
import <module>.<n> <localAlias> [<paramType> ...] => [<returnType>]
```

Declares an external function the module can call. `<module>.<n>` is the import path (e.g. `env.log`). `<localAlias>` is the name used to call it inside function bodies. Parameter types and return type follow the same convention as `export`. Imports with no return value omit the `=>` clause entirely.

```
import env.log   log   i32       => i32   // one i32 param, returns i32
import env.print print i32               // one i32 param, no return
import env.pow   pow   i32 i32   => i32  // two i32 params, returns i32
```

---

### `global`

```
global [mut] <type> <n> [<initValue>]
```

Declares a module-level global variable. `mut` makes it writable. The initial value defaults to `0` if omitted.

```
global     i32 MAX_SIZE 100   // immutable i32, initial value 100
global mut i32 counter   0    // mutable i32, initial value 0
global mut f32 ratio     0    // mutable f32, initial value 0
```

Global names are visible across all functions in the file. Reading or writing a global inside a function body uses the same assignment syntax as local variables — the compiler distinguishes them automatically.

---

### `export`

```
export <funcName> [<type> <paramName> ...] => [<returnType>]
```

Opens a new exported function. All body lines that follow (until the next `export` or end of file) belong to this function. Functions with no parameters or no return value simply omit those parts.

```
export add    i32 a  i32 b  => i32   // (i32, i32) → i32
export negate i32 x         => i32   // (i32)       → i32
export init                          // ()          → void
```

---

### `data`

```
data <offset> "<string>"
data <offset> <byte> [<byte> ...]
```

Writes bytes into linear memory at compile time. Requires a `memory` declaration. String form interprets `\n`, `\r`, `\t`, `\0`, `\\`, and `\"`. Byte form accepts decimal integers.

```
data 0 "Hello, world!\0"
data 64 72 101 108 108 111   // H e l l o
```

---

## Function bodies

Function bodies use an **expression-based** syntax for arithmetic and function calls. You write named assignments and the compiler lowers them to stack instructions automatically. Control flow and memory access use the same argument-passing style — the compiler handles all stack management for you. You never need to think about what is on the stack.

---

### Assignments

```
result = operation(arg1, arg2)
```

Evaluates an operation on the given arguments and stores the result. Variable names must be identifiers. The type of `result` is inferred from the types of the arguments and propagated to any later expressions that use it.

Parameters declared in the `export` header and globals declared at the top level are available by name immediately. Intermediate variables spring into existence the first time they appear on the left-hand side of an assignment.

```
export hyp i32 a i32 b => i32
  aa  = mul(a, a)        // aa  : i32  (inferred from a)
  bb  = mul(b, b)        // bb  : i32  (inferred from b)
  sum = add(aa, bb)      // sum : i32
  return sum
```

---

### Constant literals

Numeric constants must be written as **quoted strings** in expression arguments. A constant is treated as an integer if it contains no decimal point or exponent, and as a float otherwise. By default, they are 32-bit. They can be prefixed with `64` to become 64-bit.

```
n  = add(x, "10")        // x + 10  (i32)
r  = mul(x, "0.5")       // x * 0.5 (f32)
k  = "42"                // constant 42 assigned to k (i32)
pi = 64"3.14159"         // constant pi assigned (f64)
```

---

### Nested expressions

Nested calls are flattened automatically into temp variables. You can write them directly without intermediate names.

```
result = add(mul(a, b), mul(c, d))
// equivalent to:
//   _t0 = mul(a, b)
//   _t1 = mul(c, d)
//   result = add(_t0, _t1)
```

---

### Reading and writing globals

Globals are read and written with the same assignment syntax as locals. The compiler emits `global.get` / `global.set` automatically when it recognises a global name.

```
global mut i32 counter 0

export increment => i32
  n = add(counter, "1")  // reads global counter
  counter = n             // writes global counter
  return n
```

---

### Calling imported functions

Call an imported function by its local alias. If the import returns a value, assign it; if it is void, write it as a bare call.

```
import env.log log i32 => i32

export demo i32 x => i32
  r = log(x)             // call log, store return value
  return r

import env.print print i32

export demo2 i32 x
  print(x)               // void call — no assignment
```

---

### `return`

```
return <varName>
```

Returns the value of a local or global variable. This must be the last expression in a function that declares a return type; functions that return `void` can simply fall off the end.

```
export double i32 x => i32
  r = mul(x, "2")
  return r
```

---

## Control flow

Control flow instructions use the same argument-passing syntax as the rest of the language. Pass variables directly as arguments — the compiler handles all stack management for you.

### `block`, `loop`

```
block()
loop()
```

Open a structured control block. Every opened block must be closed with a matching `end`.

- `block()` — a non-looping block used as a break target. Branching from inside exits to after its `end`.
- `loop()` — a loop block. `br 0` from inside jumps back to the top.

```
block()
  loop()
    // body
  end
end
```

---

### `if`, `else`, `end`

```
if(<condition>)
else
end
```

`if` takes an `i32` condition variable as its argument. If the condition is zero, execution jumps to the matching `else` or `end`.

`else` is optional. `end` closes the nearest open `block`, `loop`, or `if`.

```
export clamp i32 x => i32
  too_low  = lt_s(x, "0")
  too_high = gt_s(x, "100")
  if(too_low)
    x = "0"
  else
    if(too_high)
      x = "100"
    end
  end
  return x
```

---

### `br`, `br_if`

```
br    <depth>
br_if <depth>(<condition>)
```

Branch to an enclosing block at the given nesting depth (0 = innermost). For a `loop`, branching returns to the top; for a `block` or `if`, branching exits to after the `end`.

`br` is unconditional and takes no arguments. `br_if` takes an `i32` condition variable and branches only if it is non-zero.

```
loop empty()
  done = eq(x, "0")
  br_if 1(done)    // exit loop if done (targets enclosing block)
  br 0             // repeat loop (targets this loop)
end
```

---

### `br_table`

```
br_table <depth> [<depth> ...] <defaultDepth>
```

Branches to the depth at position `<index>` in the list, where `<index>` is an `i32` value. If the index is out of range, branches to `<defaultDepth>`.

```
br_table 0 1 2 3   // index 0→depth 0, 1→depth 1, 2→depth 2, else→depth 3
```

---

### Full control flow example

```
// while (counter < 10) { counter++ }
block()
  loop()
    cond = lt_s(counter, "10")
    if(cond)
      counter = add(counter, "1")
    else
      br 2          // exit outer block
    end
    br 0            // repeat loop
  end
end
```

Depth reference for `br` here:
- `br 0` → back to top of `loop`
- `br 1` → exit `loop` (after loop's `end`)
- `br 2` → exit `block` (after block's `end`)

---

## Memory operations

Memory instructions follow the same argument-passing convention. A `memory` directive must be present.

### Load

```
result = load    <type>(<address>)
result = load8_s  <type>(<address>)
result = load8_u  <type>(<address>)
result = load16_s <type>(<address>)
result = load16_u <type>(<address>)
result = load32_s <type>(<address>)
result = load32_u <type>(<address>)
```

Reads from linear memory at `<address>` (an `i32` expression) and produces a value of the given type.

| Instruction | Types | Description |
|-------------|-------|-------------|
| `load` | i32, i64, f32, f64 | Load natural-width value |
| `load8_s` | i32, i64 | Load 8-bit, sign-extend |
| `load8_u` | i32, i64 | Load 8-bit, zero-extend |
| `load16_s` | i32, i64 | Load 16-bit, sign-extend |
| `load16_u` | i32, i64 | Load 16-bit, zero-extend |
| `load32_s` | i64 | Load 32-bit, sign-extend |
| `load32_u` | i64 | Load 32-bit, zero-extend |

```
addr = "0"
val  = load i32(addr)      // read i32 from address 0
b    = load8_u i32(addr)   // read unsigned byte from address 0
```

### Store

```
store   <type>(<address>, <value>)
store8  <type>(<address>, <value>)
store16 <type>(<address>, <value>)
store32 <type>(<address>, <value>)
```

Writes `<value>` to linear memory at `<address>`.

| Instruction | Types | Description |
|-------------|-------|-------------|
| `store` | i32, i64, f32, f64 | Store natural-width value |
| `store8` | i32, i64 | Store low 8 bits |
| `store16` | i32, i64 | Store low 16 bits |
| `store32` | i64 | Store low 32 bits |

```
addr = "0"
store i32(addr, val)       // write val to address 0
store8 i32(addr, val)      // write low byte of val to address 0
```

### `memory.size` / `memory.grow`

```
sz  = memory.size()
old = memory.grow(n)
```

`memory.size()` returns the current size in pages as an `i32`. `memory.grow(n)` grows memory by `n` pages and returns the previous size, or `-1` on failure.

---

## Miscellaneous instructions

### `drop`

```
drop
```

Discards a value. Useful when a function returns a value that is not needed and cannot be written as a void call.

### `select`

```
select
```

A branchless ternary. Takes a condition (`i32`) and two operands of the same type — produces the first operand if the condition is non-zero, the second otherwise.

---

## Available operations

All operations are called with the expression syntax `result = op(arg, ...)`. Types are inferred from the arguments.

### Arithmetic

| Name | Description | Operands |
|------|-------------|----------|
| `add` | Addition | 2 |
| `sub` | Subtraction | 2 |
| `mul` | Multiplication | 2 |
| `div` | Division (signed for integers) | 2 |
| `div_s` | Signed division | 2 |
| `div_u` | Unsigned division | 2 |
| `rem_s` | Signed remainder | 2 |
| `rem_u` | Unsigned remainder | 2 |

### Bitwise (integers only)

| Name | Description | Operands |
|------|-------------|----------|
| `and` | Bitwise AND | 2 |
| `or` | Bitwise OR | 2 |
| `xor` | Bitwise XOR | 2 |
| `shl` | Shift left | 2 |
| `shr_s` | Signed shift right | 2 |
| `shr_u` | Unsigned shift right | 2 |
| `rotl` | Rotate left | 2 |
| `rotr` | Rotate right | 2 |
| `clz` | Count leading zeros | 1 |
| `ctz` | Count trailing zeros | 1 |
| `popcnt` | Population count | 1 |

### Floating-point (f32 / f64 only)

| Name | Description | Operands |
|------|-------------|----------|
| `abs` | Absolute value | 1 |
| `neg` | Negation | 1 |
| `sqrt` | Square root | 1 |
| `ceil` | Round up | 1 |
| `floor` | Round down | 1 |
| `trunc` | Truncate toward zero | 1 |
| `nearest` | Round to nearest | 1 |
| `min` | Minimum | 2 |
| `max` | Maximum | 2 |
| `copysign` | Copy sign | 2 |

### Comparisons (produce i32: 1 = true, 0 = false)

| Name | Description | Types |
|------|-------------|-------|
| `eqz` | Equal to zero | i32, i64 |
| `eq` | Equal | all |
| `ne` | Not equal | all |
| `lt_s` / `lt_u` | Less than (signed / unsigned) | i32, i64 |
| `lt` | Less than | f32, f64 |
| `gt_s` / `gt_u` | Greater than (signed / unsigned) | i32, i64 |
| `gt` | Greater than | f32, f64 |
| `le_s` / `le_u` | Less than or equal | i32, i64 |
| `le` | Less than or equal | f32, f64 |
| `ge_s` / `ge_u` | Greater than or equal | i32, i64 |
| `ge` | Greater than or equal | f32, f64 |

### Type conversions

| Name | Description |
|------|-------------|
| `i32.wrap` | i64 → i32 (wrapping) |
| `i64.extend_s` | i32 → i64 (sign-extend) |
| `i64.extend_u` | i32 → i64 (zero-extend) |
| `f32.convert_s_i32` | i32 → f32 (signed) |
| `f32.convert_u_i32` | i32 → f32 (unsigned) |
| `f32.convert_s_i64` | i64 → f32 (signed) |
| `f64.convert_s_i32` | i32 → f64 (signed) |
| `f64.convert_u_i32` | i32 → f64 (unsigned) |
| `f64.convert_s_i64` | i64 → f64 (signed) |
| `f64.promote` | f32 → f64 |
| `f32.demote` | f64 → f32 |
| `i32.trunc_s_f32` | f32 → i32 (signed trunc) |
| `i32.trunc_u_f32` | f32 → i32 (unsigned trunc) |
| `i32.trunc_s_f64` | f64 → i32 (signed trunc) |
| `i32.reinterpret` | f32 → i32 (bit reinterpret) |
| `f32.reinterpret` | i32 → f32 (bit reinterpret) |

---

## Types

| Keyword | WebAssembly type |
|---------|-----------------|
| `i32` | 32-bit integer |
| `i64` | 64-bit integer |
| `f32` | 32-bit float |
| `f64` | 64-bit float |