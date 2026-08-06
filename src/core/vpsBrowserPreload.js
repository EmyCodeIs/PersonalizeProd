'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseExtraArgs(value) {
  return String(value || '')
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveMb(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasArg(args, prefix) {
  return args.some((arg) => String(arg).startsWith(prefix));
}

function existingFile(value) {
  const resolved = String(value || '').trim();
  if (!resolved) return null;
  try {
    return fs.statSync(resolved).isFile() ? path.resolve(resolved) : null;
  } catch (_) {
    return null;
  }
}

function commandPath(command, options = {}) {
  const platform = options.platform || process.platform;
  const lookup = options.lookupCommand;
  if (typeof lookup === 'function') return existingFile(lookup(command));

  try {
    if (platform === 'win32') {
      const result = execFileSync('where.exe', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return existingFile(String(result).split(/\r?\n/).find(Boolean));
    }
    const result = execFileSync('sh', ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return existingFile(String(result).trim());
  } catch (_) {
    return null;
  }
}

function resolveBrowserExecutable(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const configured = [
    options.configured,
    env.WPP_EXECUTABLE_PATH,
    env.PUPPETEER_EXECUTABLE_PATH,
  ].map(existingFile).find(Boolean);
  if (configured) return configured;

  const candidates = platform === 'win32'
    ? [
      path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    ]
    : [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];

  for (const candidate of candidates) {
    const found = existingFile(candidate);
    if (found) return found;
  }

  for (const command of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const found = commandPath(command, { ...options, platform });
    if (found) return found;
  }
  return null;
}

function resolveBrowserArgs(options = {}) {
  const platform = options.platform || process.platform;
  const isRoot = options.isRoot ?? (
    typeof process.getuid === 'function' && process.getuid() === 0
  );
  const configured = options.configured ?? process.env.WPP_BROWSER_ARGS;
  const args = parseExtraArgs(configured);
  const cwd = options.cwd || process.cwd();
  const cacheDir = path.resolve(
    cwd,
    options.cacheDir || process.env.BROWSER_CACHE_DIR || 'data/browser-cache',
  );
  const diskCacheBytes = Math.round(positiveMb(
    options.diskCacheMb ?? process.env.BROWSER_DISK_CACHE_MB,
    100,
  ) * 1024 * 1024);
  const mediaCacheBytes = Math.round(positiveMb(
    options.mediaCacheMb ?? process.env.BROWSER_MEDIA_CACHE_MB,
    50,
  ) * 1024 * 1024);

  if (!hasArg(args, '--disk-cache-dir=')) args.push(`--disk-cache-dir=${cacheDir}`);
  if (!hasArg(args, '--disk-cache-size=')) args.push(`--disk-cache-size=${diskCacheBytes}`);
  if (!hasArg(args, '--media-cache-size=')) args.push(`--media-cache-size=${mediaCacheBytes}`);

  if (platform === 'linux') {
    args.push('--disable-dev-shm-usage');
    if (isRoot) args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  return [...new Set(args)];
}

module.exports = {
  commandPath,
  existingFile,
  hasArg,
  parseExtraArgs,
  positiveMb,
  resolveBrowserArgs,
  resolveBrowserExecutable,
};
