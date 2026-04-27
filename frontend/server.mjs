import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const BACKEND_URL = new URL(process.env.BACKEND_URL || "http://localhost:8000");
const DIST_DIR = path.join(__dirname, "dist");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function proxyApi(req, res) {
  const target = new URL(req.url, BACKEND_URL);
  const proxyReq = http.request(
    target,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host
      }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    sendError(res, 502, `Backend proxy failed: ${error.message}`);
  });

  req.pipe(proxyReq);
}

async function resolveStaticPath(urlPathname) {
  const pathname = decodeURIComponent(urlPathname === "/" ? "/index.html" : urlPathname);
  const candidate = path.normalize(path.join(DIST_DIR, pathname));
  if (!candidate.startsWith(DIST_DIR)) return null;

  const info = await stat(candidate).catch(() => null);
  if (info?.isFile()) return candidate;
  return path.join(DIST_DIR, "index.html");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = await resolveStaticPath(url.pathname);
  if (!filePath) return sendError(res, 403, "Forbidden");

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    return sendError(res, 404, "Build output not found. Run npm run build first.");
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Content-Length": info.size
  });
  createReadStream(filePath).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      proxyApi(req, res);
      return;
    }

    serveStatic(req, res).catch((error) => {
      sendError(res, 500, error instanceof Error ? error.message : "Server error");
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Frontend server: http://localhost:${PORT}`);
    console.log(`API proxy target: ${BACKEND_URL.origin}`);
  });
