'use strict';

const path = require('path');
const fs = require('fs');

// Resolve een pad EN volg symlinks (fs.realpathSync) indien het bestaat.
// Bestaande paden met een symlink worden zo naar hun echte locatie getransformeer,
// zodat een symlink binnen BROWSE_ROOTS niet kan ontsnappen uit de whitelist.
function safeResolve(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // pad bestaat nog niet (bv. bij aanmaken) -> gebruik de string-resolved versie
    return resolved;
  }
}

const BROWSE_ROOTS = (process.env.BROWSE_ROOTS || process.cwd())
  .split(',')
  .map((s) => safeResolve(s.trim()))
  .filter(Boolean);

function isWithinRoots(target, roots) {
  const resolved = safeResolve(target);
  if (resolved === '/') return true;
  return roots.some((root) => {
    if (resolved === root) return true;
    if (root === '/') return true;
    return resolved.startsWith(path.join(root, path.sep)) || resolved === root;
  });
}

module.exports = { BROWSE_ROOTS, isWithinRoots, safeResolve };
