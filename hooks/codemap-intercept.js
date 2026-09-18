// hooks/codemap-intercept.js
//
// PreToolUse hook — fires BEFORE Claude reads any file.
// If Claude is about to read a .py file AND a matching .codemap exists,
// this hook blocks the Read and prints the codemap content instead.
// Claude receives the map as feedback, never touches the full .py file.

'use strict';

const fs = require('fs');
const path = require('path');

function resolveFilePath() {
  if (process.argv[2]) return process.argv[2];
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return data?.tool_input?.file_path || null;
  } catch (e) {
    return null;
  }
}

const filePath = resolveFilePath();

// Only intercept .py files
if (!filePath || path.extname(filePath).toLowerCase() !== '.py') {
  process.exit(0); // not a .py file — let Read proceed normally
}

const mapPath = filePath.replace(/\.py$/, '.codemap');

if (!fs.existsSync(mapPath)) {
  // No map yet — generate it now before Claude reads the file.
  // This handles existing files that were never written by Claude.
  process.stderr.write(`[codemap] No map for ${path.basename(filePath)} — generating now...\n`);

  const https = require('https');
  const apiKey = process.env.GEMINI_API_KEY;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  // Local parser — same as in codemap-generate.js
  function generateLocalMap() {
    const fnMatches = [...content.matchAll(/^\s{0,4}def\s+(\w+)\s*\(([^)]*)\)/gm)];
    const classMatches = [...content.matchAll(/^class\s+(\w+)\s*(?:\(([^)]*)\))?/gm)];
    const importMatches = [...content.matchAll(/^(?:import\s+\S+|from\s+\S+\s+import\s+\S+)/gm)];
    const fns = fnMatches.length > 0 ? fnMatches.map(m => `  ${m[1]}(${m[2].trim()})`).join('\n') : '  none';
    const cls = classMatches.length > 0 ? classMatches.map(m => `  ${m[1]}  inherits: ${m[2] ? m[2].trim() : 'none'}`).join('\n') : '  none';
    const imps = importMatches.length > 0 ? importMatches.map(m => `  ${m[0].trim()}`).join('\n') : '  none';
    return [`file: ${path.basename(filePath)}`, `lines: ${lines.length}`, `generated: local`, ``, `functions:`, fns, ``, `classes:`, cls, ``, `imports:`, imps, ``, `dependencies:`, `  none`].join('\n');
  }

  function saveAndBlock(mapContent) {
    fs.writeFileSync(mapPath, mapContent, 'utf8');
    const mapLines = mapContent.split(/\r?\n/).length;
    const saving = Math.round((1 - mapLines / lines.length) * 100);
    process.stderr.write(
      `[codemap] Map generated for ${path.basename(filePath)}.\n` +
      `Returning codemap (${mapLines} lines) instead of full file (${lines.length} lines).\n` +
      `Token saving this turn: ~${saving}%\n\n` +
      `CODEMAP CONTENT:\n${mapContent}\n`
    );
    process.exit(2);
  }

  if (!apiKey) {
    saveAndBlock(generateLocalMap());
    return;
  }

  const SYSTEM_INSTRUCTION =
    'You extract the structure of a Python file into a compact, machine-readable map. ' +
    'Reply ONLY in this exact format, nothing else, no prose:\n\n' +
    'file: <filename>\nlines: <total line count>\n\nfunctions:\n' +
    '  ClassName.method_name(params)  for methods inside a class\n' +
    '  function_name(params)  for standalone functions\n' +
    '  List EVERY function AND every method inside every class. Never write none if classes exist.\n\n' +
    'classes:\n  ClassName  inherits: Parent or none\n  storage: self.field = value\n\n' +
    'imports:\n  (list every import. Write none if no imports.)\n\n' +
    'dependencies:\n  ClassName uses: what it calls from other modules\n  (Write none if nothing.)\n\n' +
    'Never add explanations, headers, or markdown.';

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ parts: [{ text: `File: ${path.basename(filePath)}\n\n${content.slice(0, 25000)}` }] }],
  });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey } }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        saveAndBlock(text ? text.trim() : generateLocalMap());
      } catch (e) {
        saveAndBlock(generateLocalMap());
      }
    });
  });
  req.on('error', () => saveAndBlock(generateLocalMap()));
  req.write(body);
  req.end();
  return;
}

// Map exists — block the Read and return the map content instead
const mapContent = fs.readFileSync(mapPath, 'utf8');
const mapLines = mapContent.split(/\r?\n/).length;
const pyLines = fs.existsSync(filePath)
  ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length
  : '?';
const saving = typeof pyLines === 'number'
  ? Math.round((1 - mapLines / pyLines) * 100)
  : 0;

process.stderr.write(
  `[codemap] Intercepted Read on ${path.basename(filePath)}.\n` +
  `Returning codemap (${mapLines} lines) instead of full file (${pyLines} lines).\n` +
  `Token saving this turn: ~${saving}%\n\n` +
  `CODEMAP CONTENT:\n${mapContent}\n`
);

// Exit code 2 = blocking error — Claude Code surfaces this as feedback to Claude
// and does NOT proceed with the original Read tool call.
process.exit(2);
