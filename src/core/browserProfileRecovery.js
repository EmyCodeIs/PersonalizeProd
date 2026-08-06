'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXACT_MARKERS = new Set([
  'devtoolsactiveport',
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
]);

function markerName(name) {
  const normalized = String(name || '').toLowerCase();
  return EXACT_MARKERS.has(normalized) || normalized.startsWith('.com.google.chrome.');
}

function readProcessList(options = {}) {
  if (typeof options.processList === 'string') return options.processList;
  if (typeof options.readProcesses === 'function') return String(options.readProcesses() || '');
  try {
    if ((options.platform || process.platform) === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    return execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return '';
  }
}

function profileIsActive(profilePath, options = {}) {
  const resolved = path.resolve(profilePath);
  const comparable = resolved.replace(/\\/g, '/').toLowerCase();
  const processList = readProcessList(options).replace(/\\/g, '/').toLowerCase();
  return processList.split(/\r?\n/).some((line) => (
    /(chrome|chromium)/.test(line) && line.includes(comparable)
  ));
}

function findProfileMarkers(profilePath, options = {}) {
  const resolved = path.resolve(profilePath);
  const maxDepth = Math.max(1, Number(options.maxDepth || 2));
  const found = [];
  if (!fs.existsSync(resolved)) return found;
  const stack = [{ dir: resolved, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
      if (markerName(entry.name)) found.push(fullPath);
    }
  }
  return found;
}

function cleanupStaleProfileMarkers(options = {}) {
  const cwd = options.cwd || process.cwd();
  const tokenRoot = options.tokenRoot || process.env.TOKEN_CACHE_ROOT || 'tokens';
  const sessionName = options.sessionName || process.env.WPP_SESSION_NAME || 'personalize-wppconnect';
  const profilePath = path.resolve(cwd, tokenRoot, sessionName);
  const markers = findProfileMarkers(profilePath, options);

  if (!markers.length) return { profilePath, active: false, found: 0, removed: 0, failures: 0 };
  if (profileIsActive(profilePath, options)) {
    return { profilePath, active: true, found: markers.length, removed: 0, failures: 0, skipped: true };
  }

  let removed = 0;
  let failures = 0;
  for (const marker of markers) {
    try {
      fs.rmSync(marker, { recursive: true, force: true });
      removed += 1;
    } catch (_) {
      failures += 1;
    }
  }
  return { profilePath, active: false, found: markers.length, removed, failures, skipped: false };
}

module.exports = {
  EXACT_MARKERS,
  cleanupStaleProfileMarkers,
  findProfileMarkers,
  markerName,
  profileIsActive,
  readProcessList,
};
