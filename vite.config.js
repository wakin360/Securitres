import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const page = (name) => fileURLToPath(new URL(name, import.meta.url));
const maxRequestBodyBytes = 4.5 * 1024 * 1024;
const serverEnvironmentKeys = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SECURITRES_KEK_ACTIVE_VERSION',
  'SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL',
  'SECURITRES_ENCRYPTION_MODE',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'APP_URL',
  'CRON_SECRET',
];
const localApiRoutes = new Map([
  ['/api/secure-data', fileURLToPath(new URL('./api/secure-data.js', import.meta.url))],
  ['/api/notify-student-decision', fileURLToPath(new URL('./api/notify-student-decision.js', import.meta.url))],
  ['/api/send-dean-daily-digest', fileURLToPath(new URL('./api/send-dean-daily-digest.js', import.meta.url))],
]);

class LocalApiRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function paramsToObject(params) {
  const result = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function readRequestBody(req) {
  const hasBody = req.headers['content-length'] || req.headers['transfer-encoding'];
  if (!hasBody) return undefined;

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxRequestBodyBytes) {
      tooLarge = true;
    } else if (!tooLarge) {
      chunks.push(bytes);
    }
  }
  if (tooLarge) {
    throw new LocalApiRequestError(413, 'Request body is too large.');
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return undefined;

  const contentType = String(req.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return JSON.parse(body);
    } catch {
      throw new LocalApiRequestError(400, 'Request body must contain valid JSON.');
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    return paramsToObject(new URLSearchParams(body));
  }
  return body;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function localApiMiddleware() {
  return {
    name: 'local-vercel-api-adapter',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url || '/', 'http://localhost');
        const pathname = requestUrl.pathname;
        if (pathname !== '/api' && !pathname.startsWith('/api/')) return next();

        const handlerPath = localApiRoutes.get(pathname);
        if (!handlerPath) {
          return sendJson(res, 404, { error: 'API route not found.' });
        }

        try {
          req.query = paramsToObject(requestUrl.searchParams);
          req.body = await readRequestBody(req);
          res.status = function status(code) {
            this.statusCode = code;
            return this;
          };
          res.json = function json(body) {
            if (!this.hasHeader('Content-Type')) {
              this.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            this.end(JSON.stringify(body));
            return this;
          };

          const { default: handler } = await import(pathToFileURL(handlerPath).href);
          await handler(req, res);
          if (!res.writableEnded) {
            console.error(`Local API handler did not finish its response: ${pathname}`);
            sendJson(res, 500, { error: 'The API request could not be completed.' });
          }
        } catch (error) {
          if (res.writableEnded) return;
          if (res.headersSent) {
            res.destroy(error);
            return;
          }
          if (error instanceof LocalApiRequestError) {
            sendJson(res, error.status, { error: error.message });
            return;
          }
          console.error(`Local API handler failed: ${pathname}`, error);
          sendJson(res, 500, { error: 'The API request could not be completed.' });
        }
      });
    },
  };
}

export default defineConfig(({ mode, command, isPreview }) => {
  const isLocalDevelopment = command === 'serve' && !isPreview;
  if (isLocalDevelopment) {
    const localEnvironment = loadEnv(mode, process.cwd(), '');
    const keysToLoad = new Set([
      ...serverEnvironmentKeys,
      ...Object.keys(localEnvironment).filter((key) => /^SECURITRES_KEK_V[1-9][0-9]*_B64URL$/.test(key)),
    ]);
    for (const key of keysToLoad) {
      if (process.env[key] === undefined && localEnvironment[key] !== undefined) {
        process.env[key] = localEnvironment[key];
      }
    }
  }

  return {
    plugins: isLocalDevelopment ? [localApiMiddleware()] : [],
    build: {
      rollupOptions: {
        input: {
          index: page('./index.html'),
          student: page('./student.html'),
          dean: page('./dean.html'),
          professor: page('./professor.html'),
        },
      },
    },
  };
});
