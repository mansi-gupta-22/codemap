// hooks/codemap-deps.js
//
// Answers dependency questions instantly by scanning all .codemap files
// in the project directory. No AI call at all.
//
// Usage (manual): node codemap-deps.js <search_term> [project_dir]
// Usage (skill):  invoked by the skill when user asks "what uses X?"
//
// Returns which files reference the given class/function/module.

'use strict';

const fs = require('fs');
const path = require('path');

const searchTerm = process.argv[2];
const projectDir = process.argv[3] || process.cwd();

if (!searchTerm) {
  console.log('Usage: node codemap-deps.js <ClassName or function_name> [project_dir]');
  process.exit(0);
}

// Find all .codemap files in the project directory (recursive)
function findCodemapFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...findCodemapFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.codemap')) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    // skip unreadable dirs
  }
  return results;
}

const codemapFiles = findCodemapFiles(projectDir);

if (codemapFiles.length === 0) {
  console.log(`No .codemap files found in ${projectDir}.`);
  console.log('Generate maps first by asking Claude to write or edit a .py file.');
  process.exit(0);
}

// Search each map for the term
const affected = [];
const safe = [];

for (const mapFile of codemapFiles) {
  const mapContent = fs.readFileSync(mapFile, 'utf8');
  const pyFile = mapFile.replace(/\.codemap$/, '.py');
  const fileName = path.basename(pyFile);

  // Skip the file where the term is defined (it defines it, not uses it)
  const isDefinedHere =
    mapContent.includes(`class ${searchTerm}`) ||
    mapContent.includes(`def ${searchTerm}`);

  // Check if the term appears in imports or dependencies
  const importsIt = mapContent.includes(`import ${searchTerm}`) ||
    mapContent.includes(`from ${searchTerm}`) ||
    mapContent.includes(`, ${searchTerm}`);
  const usesIt = mapContent.includes(`uses: ${searchTerm}`) ||
    mapContent.includes(`${searchTerm}.`) ||
    (mapContent.includes(searchTerm) && !isDefinedHere);

  if (isDefinedHere) {
    // skip — this is where it's defined
  } else if (importsIt || usesIt) {
    // Extract specific usage detail from the dependencies section
    const depLines = mapContent
      .split(/\r?\n/)
      .filter(l => l.includes(searchTerm) && !l.startsWith('file:') && !l.startsWith('lines:'));
    const detail = depLines.map(l => l.trim()).join(', ');
    affected.push({ fileName, detail });
  } else {
    safe.push(fileName);
  }
}

// Output the result
console.log(`\nDependency check for: "${searchTerm}"`);
console.log(`Scanned ${codemapFiles.length} map file(s). No AI tokens used.\n`);

if (affected.length === 0) {
  console.log(`No files reference "${searchTerm}". Safe to change or delete.`);
} else {
  console.log('AFFECTED files (reference this):');
  for (const { fileName, detail } of affected) {
    console.log(`  ${fileName} — ${detail || 'referenced'}`);
  }
  if (safe.length > 0) {
    console.log('\nSAFE files (no direct reference):');
    for (const f of safe) {
      console.log(`  ${f}`);
    }
  }
}

console.log(`\nToken cost: 0 (map files only, no AI call)`);
