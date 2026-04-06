# WebAssembly Compiler

A lightweight in-browser WebAssembly Compiler. Write a simple, human-readable expression-based language in the textarea, then compile and run it using the commands in the terminal at the bottom.

---

## Source structure

A source file is a sequence of top-level directives followed by function bodies. The order matters:

1. `memory` (optional, at most one)
2. `import` lines (zero or more)
3. `global` lines (zero or more, may be interspersed with exports)
4. `export` blocks — each `export` line opens a function; body lines follow until the next `export` or end of file

Comments begin with `//` and run to the end of the line.

Full documentation is in `/docs/`.