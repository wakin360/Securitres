import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import viteConfig, { localApiMiddleware } from '../vite.config.js';

function createResponse() {
  const headers = new Map();
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    body: '',
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    hasHeader(name) {
      return headers.has(name.toLowerCase());
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    end(body = '') {
      this.body = body;
      this.writableEnded = true;
      this.headersSent = true;
    },
    destroy(error) {
      this.destroyedWith = error;
    },
  };
}

function createRequest(method, url, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function createMiddleware() {
  let middleware;
  localApiMiddleware().configureServer({
    middlewares: {
      use(handler) {
        middleware = handler;
      },
    },
  });
  return middleware;
}

async function invoke(middleware, req) {
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('local Vite API adapter is development-only and registers only the expected API handlers', () => {
  const plugin = localApiMiddleware();
  assert.equal(plugin.apply, 'serve');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(plugin.configurePreviewServer, undefined);
  assert.equal(viteConfig({ mode: 'development', command: 'serve', isPreview: true }).plugins.length, 0);
  assert.equal(viteConfig({ mode: 'production', command: 'build', isPreview: false }).plugins.length, 0);
});

test('existing notification routes preserve their method errors and Allow headers', async () => {
  const middleware = createMiddleware();
  const notification = await invoke(
    middleware,
    createRequest('GET', '/api/notify-student-decision'),
  );
  assert.equal(notification.res.statusCode, 405);
  assert.equal(notification.res.getHeader('allow'), 'POST');
  assert.deepEqual(JSON.parse(notification.res.body), { error: 'Method not allowed.' });

  const digest = await invoke(
    middleware,
    createRequest('POST', '/api/send-dean-daily-digest'),
  );
  assert.equal(digest.res.statusCode, 405);
  assert.equal(digest.res.getHeader('allow'), 'GET');
  assert.deepEqual(JSON.parse(digest.res.body), { error: 'Method not allowed.' });
});

test('secure-data route reaches its existing authentication guard without a browser identity fallback', async () => {
  const req = createRequest('GET', '/api/secure-data?action=list-letters&tag=one&tag=two');
  const result = await invoke(
    createMiddleware(),
    req,
  );
  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(JSON.parse(result.res.body), { error: 'Sign in to continue.' });
  assert.equal(req.query.action, 'list-letters');
  assert.deepEqual(req.query.tag, ['one', 'two']);
});

test('JSON request bodies are parsed before the existing handler runs', async () => {
  const body = { letterId: '00000000-0000-4000-8000-000000000001' };
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/notify-student-decision';
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(JSON.stringify(body))),
  };
  const result = await invoke(createMiddleware(), req);
  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(req.body, body);
});

test('unknown API paths are denied while non-API paths continue through Vite', async () => {
  const middleware = createMiddleware();
  const unknown = await invoke(middleware, createRequest('GET', '/api/not-allowlisted'));
  assert.equal(unknown.res.statusCode, 404);
  assert.deepEqual(JSON.parse(unknown.res.body), { error: 'API route not found.' });

  const page = await invoke(middleware, createRequest('GET', '/dean.html'));
  assert.equal(page.nextCalled, true);
  assert.equal(page.res.writableEnded, false);
});
