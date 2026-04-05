# Examples

---

## Basic arithmetic

```
; Add two integers
export sum i32 a i32 b => i32
  result = add(a, b)
  return result

; Multiply two integers
export mult i32 a i32 b => i32
  result = mul(a, b)
  return result

; Square a number
export square i32 x => i32
  result = mul(x, x)
  return result
```

---

## Constants in expressions

Literal numbers are written as quoted strings. Integer literals become `i32`; anything with a decimal point becomes `f32`.

```
; Add a compile-time constant to a parameter
export addTen i32 x => i32
  result = add(x, "10")
  return result

; Multiply by a float constant
export half f32 x => f32
  result = mul(x, "0.5")
  return result

; Return a constant directly
export answer => i32
  k = "42"
  return k
```

---

## Nested expressions

Nested calls are flattened automatically — no need to name intermediate values yourself.

```
; (a * b) + (c * d)
export sumOfProducts i32 a i32 b i32 c i32 d => i32
  result = add(mul(a, b), mul(c, d))
  return result

; a² + b²
export sumOfSquares i32 a i32 b => i32
  result = add(mul(a, a), mul(b, b))
  return result
```

---

## Comparisons

Comparison operations return `i32`: `1` for true, `0` for false.

```
; Return 1 if x equals y, 0 otherwise
export isEqual i32 x i32 y => i32
  result = eq(x, y)
  return result

; Return 1 if x is zero, 0 otherwise
export isZero i32 x => i32
  result = eqz(x)
  return result

; Unsigned max of two values: max = a > b ? a : b
; (written as: max = b + (a - b) * (a > b))
export umax i32 a i32 b => i32
  diff    = sub(a, b)
  cond    = gt_u(a, b)
  product = mul(diff, cond)
  result  = add(b, product)
  return result
```

---

## Calling imported functions

Imports are declared at the top. They are called by their local alias. If the import has a return value, assign it to a variable; if it is void, call it bare.

```
import env.pow   pow   i32 i32  => i32
import env.log   log   i32      => i32
import env.print print i32

; Wrap an imported function
export myPow i32 base i32 exp => i32
  result = pow(base, exp)
  return result

; Chain calls: log the input, then square it
export logAndSquare i32 x => i32
  logged = log(x)
  result = mul(logged, logged)
  return result

; Void call — no assignment
export printDouble i32 x
  doubled = mul(x, "2")
  print(doubled)
```

---

## Global variables

Globals persist across calls. Use `global mut` to declare a writable global, then read and write it by name inside any function.

```
global mut i32 counter 0

; Increment the counter and return the new value
export increment => i32
  n = add(counter, "1")
  counter = n
  return n

; Reset the counter to zero
export reset
  counter = "0"

; Return the current counter value
export getCount => i32
  return counter
```

---

## Memory and data

Declare `memory` in pages (64 KB each). Use `data` to place string or byte literals at a fixed offset.

```
memory 1
data 0 "Hello, world!\0"

import env.putchar putchar i32

; Print each character of the string at address 0
; (character-by-character manual unroll for illustration)
export greet
  c0 = load8_u("0")
  putchar(c0)
  c1 = load8_u("1")
  putchar(c1)
```

---

## Multiple functions and imports

Imports are indexed from 0. Exports follow in order. Use each function's local alias to call it.

```
import env.sin sin f32 => f32
import env.cos cos f32 => f32

; sin²(x) + cos²(x) — should always be 1.0
export pythagorean f32 x => f32
  s  = sin(x)
  c  = cos(x)
  s2 = mul(s, s)
  c2 = mul(c, c)
  result = add(s2, c2)
  return result

; Absolute value via subtract and comparison
export myAbs i32 x => i32
  neg    = sub("0", x)
  isNeg  = lt_s(x, "0")
  result = add(mul(isNeg, neg), mul(sub("1", isNeg), x))
  return result
```