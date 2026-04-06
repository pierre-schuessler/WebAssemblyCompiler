# WebAssembly Compiler

A lightweight in-browser WebAssembly Compiler. Write a simple, human-readable expression-based language in the textarea, then compile and run it using the commands in the terminal at the bottom.

---

## How it works

The compiler takes source code through a four-stage pipeline before producing a binary:

**1. Flatten** — Nested function calls are lifted into temporary variables so every expression is a single operation. `add(mul(a, b), c)` becomes two assignment lines automatically.

**2. Type inference** — Types are propagated from parameter and global declarations into every intermediate variable. You never write type annotations yourself.

**3. Stack emission** — High-level assignments are lowered to WebAssembly's stack machine: loads, operations, and stores.

**4. Assembling** — Variable names are replaced with numeric indices and the result is packed into a valid `.wasm` binary.

---

## Source structure

A source file is a sequence of top-level directives followed by function bodies. The order matters:

1. `memory` (optional, at most one)
2. `import` lines (zero or more)
3. `global` lines (zero or more, may be interspersed with exports)
4. `export` blocks — each `export` line opens a function; body lines follow until the next `export` or end of file

Comments begin with `//` and run to the end of the line.

Full documentation is in `/docs/`.