---
name: codemap-rules
description: Load .codemap files instead of re-reading full Python files when a map exists. Also trigger dependency checks when the user asks what references a class, function, or module.
---

# codemap Rules

## When adding to, renaming, or extending a Python file

Before reading any .py file, check if a matching .codemap file exists next to it.
If it does:
1. Load the .codemap ONLY.
2. Do NOT read the full .py file — the map has everything you need.
3. Tell the user: "Loaded codemap — reading [N] lines instead of [M] lines."
4. Generate only the new/changed code and write it directly.

The map contains: all functions, methods, classes, imports, and dependencies.
This is sufficient for: adding features, renaming, moving code, adding imports.

Only read the full .py file when the task genuinely requires seeing logic inside a function body — such as fixing a specific bug or optimizing an algorithm. For everything else, the map is enough. Do not read the full file "just to be safe."

## When the user asks a dependency question

Trigger: "what uses X", "what breaks if I change X", "what imports X",
"is X used anywhere", "can I delete X", "what depends on X"

IMPORTANT: For ALL of these, you MUST run the deps script first.
Do NOT use Search or Read tools for this. The script is faster and uses zero AI tokens.

Run: node "${CLAUDE_PLUGIN_ROOT}/hooks/codemap-deps.js" <term> <project_dir>

Example: user asks "what breaks if I change OrderManager in test-project/"
Run: node "${CLAUDE_PLUGIN_ROOT}/hooks/codemap-deps.js" OrderManager "C:\Users\...\test-project"

This reads .codemap files only — no AI call, instant answer.
Report the result directly. Do not read any .py file for this.

## When NOT to use the map

- Fixing a bug inside a function body — needs the real code
- Optimizing an algorithm — needs the real code
- Dead code / logic analysis — needs the real code

For these, read the full file normally.

## Coding rules (Python)

- snake_case for functions/variables, PascalCase for classes
- Type hints on every function signature
- Docstring on every function
- No mutable default arguments (def f(x=[]) is a bug)
- No wildcard imports (from module import *)
- No hardcoded API keys or passwords — use os.environ
- Wrap file I/O and network calls in try/except
- Use logging, not print(), for anything beyond a quick script
