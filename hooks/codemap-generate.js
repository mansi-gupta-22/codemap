// hooks/codemap-generate.js
//
// Fires after any .py file is written or edited (via hooks.json PostToolUse).
// Sends the file to Gemini Flash, which extracts the code structure and
// saves it as a <filename>.codemap next to the real file.
//
// Claude never reads the .py file directly — it reads the map instead,
// which is roughly 20-30 lines regardless of how large the real file is.
//
// The .codemap is plain text, designed to be human-readable too.
// It is regenerated automatically every time the .py file changes.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- Resolve file path (same pattern as check-code.js) -------------------

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
if (!filePath) {
  process.exit(0); // no file path — skip silently
}

const ext = path.extname(filePath).toLowerCase();
if (ext !== '.py') {
  process.exit(0); // only .py files get a codemap
}

if (!fs.existsSync(filePath)) {
  process.exit(0); // file was deleted, not written — skip
}

const apiKey = process.env.GEMINI_API_KEY;
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split(/\r?\n/);
const mapPath = filePath.replace(/\.py$/, '.codemap');

// ---- Gemini system instruction -------------------------------------------
// Narrow, structured prompt so the output is always parseable.
// The map format is fixed — changing the format here means updating
// codemap-deps.js and the skill file too.

const SYSTEM_INSTRUCTION =
  'You extract the structure of a Python file into a compact, machine-readable map. ' +
  'Reply ONLY in this exact format, nothing else, no prose:\n\n' +
  'file: <filename>\n' +
  'lines: <total line count>\n\n' +
  'functions:\n' +
  '  IMPORTANT: List both standalone functions AND methods inside classes.\n' +
  '  For class methods use format: ClassName.method_name(params)\n' +
  '  For standalone functions use: function_name(params)\n' +
  '  Example: if class Product has __init__ and __repr__, write:\n' +
  '    Product.__init__(self, name, price)\n' +
  '    Product.__repr__(self)\n' +
  '  If there are any classes, there MUST be entries here. Never write none.\n\n' +
  'classes:\n' +
  '  ClassName  inherits: Parent or none\n' +
  '  storage: self.field = value  (show what __init__ stores, one line per key attribute)\n' +
  '  (list every class, one per line with its storage, indented 2 spaces)\n\n' +
  'imports:\n' +
  '  (list every import, one per line, indented 2 spaces. Write none if no imports.)\n\n' +
  'dependencies:\n' +
  '  ClassName or function uses: what it calls from other modules\n' +
  '  (only cross-module deps. Write none if nothing.)\n\n' +
  'Never add explanations, headers, or markdown.';

function buildMessage(content, filePath) {
  return `File: ${path.basename(filePath)}\n\n${content.slice(0, 25000)}`;
}

// ---- Local fallback when no API key is set --------------------------------
// Generates a basic map using plain text parsing — no AI, no network.
// Less accurate than Gemini (won't catch all usages) but better than nothing.

function generateLocalMap() {
  // Match both top-level functions AND methods inside classes
  const fnMatches = [...content.matchAll(/^\s{0,4}def\s+(\w+)\s*\(([^)]*)\)/gm)];
  const classMatches = [...content.matchAll(/^class\s+(\w+)\s*(?:\(([^)]*)\))?/gm)];
  const importMatches = [...content.matchAll(/^(?:import\s+\S+|from\s+\S+\s+import\s+\S+)/gm)];

  const fns = fnMatches.length > 0
    ? fnMatches.map(m => `  ${m[1]}(${m[2].trim()})`).join('\n')
    : '  none';
  const cls = classMatches.length > 0
    ? classMatches.map(m => `  ${m[1]}  inherits: ${m[2] ? m[2].trim() : 'none'}`).join('\n')
    : '  none';
  const imps = importMatches.length > 0
    ? importMatches.map(m => `  ${m[0].trim()}`).join('\n')
    : '  none';

  return [
    `file: ${path.basename(filePath)}`,
    `lines: ${lines.length}`,
    `generated: local (no GEMINI_API_KEY set)`,
    ``,
    `functions:`,
    fns,
    ``,
    `classes:`,
    cls,
    ``,
    `imports:`,
    imps,
    ``,
    `dependencies:`,
    `  (not available without Gemini — set GEMINI_API_KEY for full dependency tracking)`,
  ].join('\n');
}

// ---- Write the map and log token saving ----------------------------------

function writeMap(mapContent, source) {
  fs.writeFileSync(mapPath, mapContent, 'utf8');
  const mapLines = mapContent.split(/\r?\n/).length;
  console.log(
    `codemap saved: ${path.basename(mapPath)} (${mapLines} lines from ${lines.length}-line file) [${source}]\n` +
    `Next request on this file: Claude reads ${mapLines} lines instead of ${lines.length} ` +
    `(saves ~${Math.round((1 - mapLines / lines.length) * 100)}% of context)`
  );
}

// ---- Main: call Gemini or fall back to local -----------------------------

if (!apiKey) {
  writeMap(generateLocalMap(), 'local parser — no GEMINI_API_KEY');
  process.exit(0);
}

if (process.env.CODEGUARD_MOCK_GEMINI === '1') {
  const mock = [
    `file: ${path.basename(filePath)}`,
    `lines: ${lines.length}`,
    `generated: mocked`,
    ``,
    `functions:`,
    `  mock_function(x, y)`,
    ``,
    `classes:`,
    `  MockClass  inherits: none`,
    ``,
    `imports:`,
    `  os`,
    ``,
    `dependencies:`,
    `  MockClass uses: os`,
  ].join('\n');
  writeMap(mock, 'mocked');
  process.exit(0);
}

const body = JSON.stringify({
  system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
  contents: [{ parts: [{ text: buildMessage(content, filePath) }] }],
});

const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

const req = https.request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
}, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.error) {
        console.log(`codemap: Gemini error (${json.error.message}). Using local parser.`);
        writeMap(generateLocalMap(), 'local parser fallback');
        return;
      }
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        writeMap(generateLocalMap(), 'local parser fallback (empty Gemini response)');
        return;
      }
      writeMap(text.trim(), 'Gemini');
    } catch (e) {
      writeMap(generateLocalMap(), 'local parser fallback (parse error)');
    }
  });
});

req.on('error', () => {
  writeMap(generateLocalMap(), 'local parser fallback (network error)');
});

req.write(body);
req.end();
