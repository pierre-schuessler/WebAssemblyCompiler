# WebAssembly Compiler

A lightweight in-browser WebAssembly assembler and runtime. Write a simple, human-readable assembly language in the textarea, then compile and run it using the simple to use commands in the terminal on the bottom.

---

## How it works

The assembler reads the source code line by line. Each line is either a **directive** (starting with `import` or `export`) or an **instruction**. Directives define the module's interface; instructions are the function bodies between them.

Functions are defined implicitly: every `export` line opens a new function, and all instruction lines that follow belong to it until the next `export` (or end of file). `import` lines must come before any `export`.

---

## Future features

- **Comparison opcodes** — `eq`, `ne`, `lt`, `gt`, `le`, `ge` for proper branching on comparisons
- **Local variable declarations** — declaring additional locals beyond function parameters
- **Memory instructions** — `load`, `store`, and a memory section