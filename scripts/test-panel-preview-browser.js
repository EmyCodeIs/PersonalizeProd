'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'scripts', 'start-panel-preview.js');
const port = 4198;

function resolveBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function waitForHealth() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const payload = await response.json();
      if (payload.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Servidor da prévia não respondeu.');
}

(async () => {
  const server = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PANEL_PREVIEW_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  const browserLogs = [];

  try {
    await waitForHealth();
    const executablePath = resolveBrowserExecutable();
    assert.ok(executablePath, 'Chrome/Chromium do sistema não foi encontrado para o teste real da prévia.');

    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (message) => browserLogs.push(`[console:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => browserLogs.push(`[pageerror] ${error.stack || error.message}`));

    await page.goto(`http://127.0.0.1:${port}/?preview=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.sidebar-nav a[href="#/leads"]');

    const routes = [
      ['#/', 'Visão geral'],
      ['#/leads', 'Leads'],
      ['#/conexao', 'Conexão'],
      ['#/notas', 'Notas fiscais'],
      ['#/integracao-fiscal', 'Integração fiscal'],
      ['#/configuracoes', 'Configurações'],
    ];

    for (const [hash, expectedText] of routes) {
      await page.evaluate((nextHash) => { window.location.hash = nextHash; }, hash);
      await page.waitForFunction((text) => document.querySelector('.content')?.textContent?.includes(text), { timeout: 2500 }, expectedText);
      const content = await page.$eval('.content', (node) => node.textContent.trim());
      assert.ok(content.length > 20, `A rota ${hash} permaneceu sem conteúdo.`);
      assert.match(content, new RegExp(expectedText, 'i'));
    }

    await page.click('.sidebar-nav a[href="#/leads"]');
    await page.waitForFunction(() => window.location.hash === '#/leads');
    await page.waitForFunction(() => document.querySelector('.content')?.textContent?.includes('Parados há 24h'));

    console.log('Prévia do painel: navegação real validada no Chromium em todas as rotas.');
  } catch (error) {
    if (browserLogs.length) {
      console.error('\nLOGS DO NAVEGADOR');
      console.error(browserLogs.join('\n'));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    server.kill('SIGTERM');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
