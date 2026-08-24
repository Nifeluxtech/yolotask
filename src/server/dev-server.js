import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const port = Number(process.env.PORT || 4173);
const apiRoot = path.join(root, 'api');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function handlerResponse(res) {
  const response = res;
  response.status = code => { response.statusCode = code; return response; };
  response.json = value => { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); };
  return response;
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return sendJson(res, 400, { error: 'Invalid path.' });
  let filePath = absolute;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    const data = await fs.readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(res, 404, { error: 'Not found.' });
    return sendJson(res, 500, { error: 'Unable to read file.' });
  }
}

async function handleApi(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = pathname.split('/').filter(Boolean)[1];
  if (!route || !/^[a-z0-9_-]+$/i.test(route)) return sendJson(res, 404, { ok: false, error: 'API route not found.' });
  const filePath = path.join(apiRoot, `${route}.js`);
  try {
    await fs.access(filePath);
    const module = await import(`../../api/${route}.js`);
    if (typeof module.default !== 'function') return sendJson(res, 500, { ok: false, error: 'API handler is invalid.' });
    await module.default(req, handlerResponse(res));
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (error.code === 'ENOENT' || error.message?.includes('Cannot find module')) return sendJson(res, 404, { ok: false, error: 'API route not found.' });
    if (!res.writableEnded) sendJson(res, 500, { ok: false, error: 'Development API error.' });
    console.error(error);
  }
}

const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (new URL(req.url, 'http://localhost').pathname.startsWith('/api/')) return void handleApi(req, res);
  return void serveStatic(req, res);
});

server.listen(port, () => console.log(`YOLOTASK dev server running at http://localhost:${port}`));
