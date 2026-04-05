# Examples

---

## Basic arithmetic

```
// Add two integers
export sum i32 a i32 b => i32
  result = add(a, b)
  return result

// Multiply two integers
export mult i32 a i32 b => i32
  result = mul(a, b)
  return result

// Square a number
export square i32 x => i32
  result = mul(x, x)
  return result
```

---

## Constants in expressions

Literal numbers are written as quoted strings. Integer literals become `i32`; anything with a decimal point becomes `f32`.

```
// Add a compile-time constant to a parameter
export addTen i32 x => i32
  result = add(x, "10")
  return result

// Multiply by a float constant
export half f32 x => f32
  result = mul(x, "0.5")
  return result

// Return a constant directly
export answer => i32
  k = "42"
  return k
```

---

## Nested expressions

Nested calls are flattened automatically — no need to name intermediate values yourself.

```
// (a * b) + (c * d)
export sumOfProducts i32 a i32 b i32 c i32 d => i32
  result = add(mul(a, b), mul(c, d))
  return result

// a² + b²
export sumOfSquares i32 a i32 b => i32
  result = add(mul(a, a), mul(b, b))
  return result
```

---

## Comparisons

Comparison operations return `i32`: `1` for true, `0` for false.

```
// Return 1 if x equals y, 0 otherwise
export isEqual i32 x i32 y => i32
  result = eq(x, y)
  return result

// Return 1 if x is zero, 0 otherwise
export isZero i32 x => i32
  result = eqz(x)
  return result

// Unsigned max of two values: max = a > b ? a : b
// (written as: max = b + (a - b) * (a > b))
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
memory 1
data 0 "Hello, world!\0"

import env.putchar putchar i32

export printString i32 startNode
  loop empty()
    // 1. Load the byte from memory
    char = load8_u(startNode)
    
    // 2. Call putchar immediately (sends the char, or 0, to JS)
    putchar(char)
    
    // 3. Check if that character was the null terminator
    isEnd = eqz(char)
    if empty(isEnd)
      return()
    end()

    // 4. Increment pointer and jump back to start of loop
    startNode = add(startNode, "1")
    br 0()
  end()
```

---

## Global variables

Globals persist across calls. Use `global mut` to declare a writable global, then read and write it by name inside any function.

```
global mut i32 counter 0

// Increment the counter and return the new value
export increment => i32
  n = add(counter, "1")
  counter = n
  return n

// Reset the counter to zero
export reset
  counter = "0"

// Return the current counter value
export getCount => i32
  return counter
```