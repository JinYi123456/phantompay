'use strict';

/**
 * Minimal dependency-free HTTP plumbing shared by all stages: a tiny router,
 * JSON body parsing with a size cap, CORS headers, request ids and a single
 * error-mapping funnel that turns LedgerErrors into clean JSON responses.
 */

const { LedgerError, asLedgerError } = require('./errors');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((segment) => {
            if (segment.startsWith(':')) {
              keys.push(segment.slice(1));
              return '([^/]+)';
            }
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$'
    );
    this.routes.push({ method, pattern, regex, keys, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }

  /** Returns the matching route plus decoded path params, or null. */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new LedgerError('request body too large', 'payload_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new LedgerError('request body is not valid JSON', 'invalid_json', 400));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, if-match, x-request-id',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, err, requestId) {
  const mapped = asLedgerError(err);
  if (mapped.status >= 500 && mapped.code === 'internal_error') {
    console.error('[phantom-pay] internal error:', err && err.stack ? err.stack : err);
  }
  sendJson(res, mapped.status, {
    error: { code: mapped.code, message: mapped.message, details: mapped.details, requestId },
  });
}

function parseQuery(url) {
  const query = {};
  for (const [key, value] of new URL(url, 'http://localhost').searchParams.entries()) {
    query[key] = value;
  }
  return query;
}

/** Runs the router against a Node http request/response pair. */
function dispatch({ router, res, req, url, requestId, context }) {
  const pathname = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const matched = router.match(method, pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type, if-match, x-request-id',
    });
    res.end();
    return Promise.resolve();
  }

  if (!matched) {
    sendError(res, new LedgerError(`no route for ${method} ${pathname}`, 'not_found', 404), requestId);
    return Promise.resolve();
  }

  return (async () => {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
    const result = await matched.route.handler({
      params: matched.params,
      query: parseQuery(req.url),
      body,
      req,
      context,
      requestId,
    });
    const status = result && result.__status ? result.__status : 200;
    const headers = result && result.__headers ? result.__headers : {};
    let payload = result && result.__status ? result.payload : result;
    if (typeof payload === 'string') {
      // Raw text payloads (e.g. Prometheus metrics) are served verbatim.
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'access-control-allow-origin': '*',
        ...headers,
      });
      res.end(payload);
      return;
    }
    sendJson(res, status, payload === undefined ? {} : payload, headers);
  })().catch((err) => {
    if (!res.headersSent) sendError(res, err, requestId);
    else res.destroy();
  });
}

/** Response helper for non-201/200 replies with headers. */
function withStatus(status, payload, headers = {}) {
  return { __status: status, __headers: headers, payload };
}

module.exports = { Router, dispatch, sendJson, sendError, readBody, withStatus, parseQuery };
