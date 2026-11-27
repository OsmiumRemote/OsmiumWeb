import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import webWorker from "./src/worker.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(ROOT, "dist");
const HOST = (process.env.HOST || "127.0.0.1").trim();
const PORT = Number.parseInt(process.env.PORT || "8788", 10) || 8788;
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "https://web.osmium.fufu.skin").replace(/\/+$/, "");
const TRUST_PROXY = String(process.env.TRUST_PROXY || "true").trim().toLowerCase() === "true";

const MIME_MAP = Object.freeze({
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm"
});

function createStaticAssetsBinding(distDir) {
    return {
        async fetch(request) {
            const url = new URL(request.url);
            let reqPath;
            try {
                reqPath = decodeURIComponent(url.pathname);
            } catch {
                return new Response("Bad Request", { status: 400 });
            }
            if (reqPath.includes("\0")) {
                return new Response("Forbidden", { status: 403 });
            }

            let relPath = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
            let absPath = path.resolve(distDir, relPath);
            if (!absPath.startsWith(distDir + path.sep) && absPath !== distDir) {
                return new Response("Forbidden", { status: 403 });
            }

            try {
                const st = await fsp.stat(absPath);
                if (st.isDirectory()) {
                    absPath = path.join(absPath, "index.html");
                }
            } catch {
                // SPA fallback for HTML navigation routes without file extensions
                if (!path.extname(relPath) && !reqPath.startsWith("/web-api/")) {
                    absPath = path.join(distDir, "index.html");
                } else {
                    return new Response("Not Found", {
                        status: 404,
                        headers: { "Content-Type": "text/plain; charset=utf-8" }
                    });
                }
            }

            try {
                const data = await fsp.readFile(absPath);
                const ext = path.extname(absPath).toLowerCase();
                const contentType = MIME_MAP[ext] || "application/octet-stream";
                const headers = new Headers({
                    "Content-Type": contentType,
                    "Content-Length": String(data.byteLength)
                });
                return new Response(request.method === "HEAD" ? null : data, {
                    status: 200,
                    headers
                });
            } catch {
                return new Response("Not Found", {
                    status: 404,
                    headers: { "Content-Type": "text/plain; charset=utf-8" }
                });
            }
        }
    };
}

function readBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const method = (req.method || "GET").toUpperCase();
        if (method === "GET" || method === "HEAD") {
            resolve(null);
            return;
        }
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)));
        req.on("error", reject);
    });
}

function toWebRequest(req, bodyBuf) {
    const protoHeader = TRUST_PROXY ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() : "";
    const hostHeader = (TRUST_PROXY && req.headers["x-forwarded-host"])
        ? String(req.headers["x-forwarded-host"]).split(",")[0].trim()
        : (req.headers.host || new URL(PUBLIC_ORIGIN).host);
    const scheme = protoHeader === "http" || protoHeader === "https"
        ? protoHeader
        : (PUBLIC_ORIGIN.startsWith("http://") ? "http" : "https");
    const url = `${scheme}://${hostHeader}${req.url || "/"}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
            for (const item of v) headers.append(k, item);
        } else {
            headers.set(k, v);
        }
    }

    const method = (req.method || "GET").toUpperCase();
    const init = { method, headers };
    if (bodyBuf !== null && method !== "GET" && method !== "HEAD") {
        init.body = bodyBuf;
    }
    const webReq = new Request(url, init);
    Object.defineProperty(webReq, "cf", {
        value: { tlsVersion: "TLSv1.3" },
        enumerable: false
    });
    return webReq;
}

async function sendWebResponse(res, webResp) {
    const outHeaders = {};
    const setCookies = typeof webResp.headers.getSetCookie === "function"
        ? webResp.headers.getSetCookie()
        : [];
    for (const [k, v] of webResp.headers.entries()) {
        if (k.toLowerCase() === "set-cookie") continue;
        outHeaders[k] = v;
    }
    if (setCookies.length > 0) {
        outHeaders["set-cookie"] = setCookies;
    }

    res.writeHead(webResp.status, outHeaders);
    if (!webResp.body) {
        res.end();
        return;
    }
    const stream = Readable.fromWeb(webResp.body);
    stream.on("error", () => {
        if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
}

if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
    console.warn("[OsmiumWeb] WARNING: dist/index.html not found. Run `npm run build` first!");
}

const cookieSecret = (process.env.WEB_COOKIE_SECRET || "").trim();
if (cookieSecret.length < 32) {
    console.warn("[OsmiumWeb] WARNING: WEB_COOKIE_SECRET is empty or <32 chars. /web-api/* requests will return 503 until configured in .env!");
}

const env = {
    ...process.env,
    ASSETS: createStaticAssetsBinding(DIST_DIR)
};

const server = http.createServer(async (req, res) => {
    try {
        const body = await readBody(req);
        const webReq = toWebRequest(req, body);
        const webResp = await webWorker.fetch(webReq, env);
        await sendWebResponse(res, webResp);
    } catch (err) {
        if (err?.statusCode === 413) {
            res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, code: 1003 }));
            return;
        }
        console.error("[OsmiumWeb] HTTP error:", err?.message || err);
        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        }
        if (!res.writableEnded) {
            res.end(JSON.stringify({ ok: false, code: 5001 }));
        }
    }
});

server.listen(PORT, HOST, () => {
    console.log(`[OsmiumWeb] Listening on http://${HOST}:${PORT} (public: ${PUBLIC_ORIGIN}, signaling: ${process.env.SIGNALING_ORIGIN || "https://osmium.fufu.skin"}, internal: ${process.env.SIGNALING_INTERNAL_ORIGIN || "public"}, relay: ${process.env.RELAY_ORIGIN || "https://relay.fufu.skin"})`);
});

function shutdown(signal) {
    console.log(`[OsmiumWeb] Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
