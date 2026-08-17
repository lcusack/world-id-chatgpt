import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { WorldIdError } from "./world-id.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const MAX_BODY_BYTES = 1_000_000;

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new WorldIdError("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const verificationIdFromPath = (pathname) => {
  const match = pathname.match(/^\/verify\/([A-Za-z0-9_-]{16,128})$/);
  return match?.[1] ?? null;
};

const apiMatch = (pathname, suffix) => {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(
    new RegExp(`^/api/verification/([A-Za-z0-9_-]{16,128})/${escapedSuffix}$`),
  );
  return match?.[1] ?? null;
};

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.world.org https://*.worldcoin.org; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const serveFile = (res, path, contentType) => {
  if (!existsSync(path)) {
    res.writeHead(503).end("Run npm run build first");
    return;
  }
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "public, max-age=300",
    ...securityHeaders,
  });
  createReadStream(path).pipe(res);
};

export function createHttpServer({ config, store, worldId }) {
  return createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end("Missing URL");
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          ...securityHeaders,
        });
        res.end("World ID verification MCP server\nMCP endpoint: /mcp");
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }

      const pageVerificationId = verificationIdFromPath(url.pathname);
      if (req.method === "GET" && pageVerificationId) {
        if (!store.get(pageVerificationId)) {
          res.writeHead(404, securityHeaders).end("Verification link not found");
          return;
        }
        serveFile(
          res,
          resolve(publicDir, "verify.html"),
          "text/html; charset=utf-8",
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/verify.js") {
        serveFile(
          res,
          resolve(publicDir, "verify.js"),
          "text/javascript; charset=utf-8",
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/idkit_wasm_bg.wasm") {
        serveFile(
          res,
          resolve(publicDir, "idkit_wasm_bg.wasm"),
          "application/wasm",
        );
        return;
      }

      const configVerificationId = apiMatch(url.pathname, "config");
      if (req.method === "GET" && configVerificationId) {
        const attempt = store.get(configVerificationId);
        if (!attempt) {
          json(res, 404, { error: "Verification link not found" });
          return;
        }
        json(res, 200, {
          status: attempt.status,
          expires_at: attempt.expiresAt,
          app_id: config.world.appId,
          rp_id: config.world.rpId,
          action: config.world.action,
          environment: config.world.environment,
        });
        return;
      }

      const rpVerificationId = apiMatch(url.pathname, "rp-context");
      if (req.method === "POST" && rpVerificationId) {
        const attempt = store.get(rpVerificationId);
        if (!attempt || attempt.status !== "pending") {
          json(res, 410, { error: "Verification link is no longer active" });
          return;
        }
        json(res, 200, worldId.createRpContext());
        return;
      }

      const proofVerificationId = apiMatch(url.pathname, "proof");
      if (req.method === "POST" && proofVerificationId) {
        const attempt = store.get(proofVerificationId);
        if (!attempt || attempt.status !== "pending") {
          json(res, 410, { error: "Verification link is no longer active" });
          return;
        }

        const rawProof = await readBody(req);
        let parsedProof;
        try {
          parsedProof = JSON.parse(rawProof);
        } catch {
          throw new WorldIdError("Malformed JSON proof");
        }

        const claims = await worldId.verifyProof(
          rawProof,
          parsedProof,
          proofVerificationId,
        );
        store.markVerified(proofVerificationId, claims);
        json(res, 200, { success: true, claims });
        return;
      }

      if (req.method === "OPTIONS" && url.pathname === "/mcp") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, mcp-session-id",
          "access-control-expose-headers": "Mcp-Session-Id",
        });
        res.end();
        return;
      }

      if (
        url.pathname === "/mcp" &&
        new Set(["POST", "GET", "DELETE"]).has(req.method)
      ) {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-expose-headers", "Mcp-Session-Id");

        const mcpServer = createMcpServer({
          store,
          publicBaseUrl: config.publicBaseUrl,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          transport.close();
          mcpServer.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404).end("Not Found");
    } catch (error) {
      console.error(error);
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof WorldIdError ? error.status : 500;
      json(res, status, {
        error: status === 500 ? "Internal server error" : error.message,
      });
    }
  });
}
