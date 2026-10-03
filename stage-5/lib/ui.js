'use strict';

/**
 * Static asset server for the built-in web UI. Assets live in ./ui next to
 * this file and are read once, then cached in memory. No dependencies, no
 * network: the UI is fully self-hosted by the service.
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const cache = null; // assets are tiny; read from disk on every request so edits are live

function readAsset(name) {
  const candidates = [name];
  // Serverless bundles may rename assets from .js/.css to .cjs (nft's trace
  // of the literal fs reads); try the original names when that happened.
  if (name.endsWith('.js')) candidates.push(`${name.slice(0, -3)}.cjs`);
  else if (name.endsWith('.css')) candidates.push(`${name.slice(0, -4)}.cjs`);
  for (const candidate of candidates) {
    const resolved = path.normalize(path.join(ASSETS_DIR, candidate));
    if (!resolved.startsWith(ASSETS_DIR + path.sep) && resolved !== ASSETS_DIR) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    return fs.readFileSync(resolved);
  }
  return null;
}

/**
 * Map a request path to a UI asset. `/` serves the single-page app;
 * `/ui/<file>` serves static assets. Returns null when the path is not UI.
 */
function handle(pathname) {
  let name = null;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/ui') name = 'index.html';
  else if (pathname.startsWith('/ui/')) name = pathname.slice('/ui/'.length);
  if (!name) return null;
  const body = readAsset(name);
  if (!body) {
    return {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('ui asset not found'),
    };
  }
  return {
    status: 200,
    headers: {
      'content-type': MIME[path.extname(name)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    },
    body,
  };
}

module.exports = { handle };
