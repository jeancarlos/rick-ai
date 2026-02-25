import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./config/logger.js";
import { query } from "./memory/database.js";

/**
 * HTTP server that serves:
 *   GET /health  → Health check (used by deploy pipeline + Docker healthcheck)
 *   GET /        → Web UI (single HTML file)
 *   *            → 404
 *
 * Also exports the raw http.Server so the WebConnector can attach
 * a WebSocket server for real-time chat via 'upgrade' events.
 */

interface HealthState {
  whatsappConnected: boolean;
  postgresConnected: boolean;
  pgvectorConnected: boolean;
  startedAt: number;
}

const state: HealthState = {
  whatsappConnected: false,
  postgresConnected: false,
  pgvectorConnected: false,
  startedAt: Date.now(),
};

export function setHealthy(key: keyof Omit<HealthState, "startedAt">, value: boolean): void {
  state[key] = value;
}

export function isHealthy(): boolean {
  return state.whatsappConnected && state.postgresConnected;
}

/** Cached HTML files (loaded once at first request) */
let cachedHtml: string | null = null;
let cachedSessionHtml: string | null = null;

async function loadHtml(filename: string): Promise<string | null> {
  const paths = [
    join(process.cwd(), "dist", "connectors", filename),
    join(process.cwd(), "src", "connectors", filename),
  ];
  for (const p of paths) {
    try {
      const content = await readFile(p, "utf-8");
      logger.info({ path: p }, `${filename} loaded`);
      return content;
    } catch {
      // try next path
    }
  }
  return null;
}

async function getWebUiHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await loadHtml("web-ui.html");
  if (!cachedHtml) {
    logger.error("web-ui.html not found");
    return "<html><body><h1>Web UI not found</h1></body></html>";
  }
  return cachedHtml;
}

async function getSessionViewerHtml(): Promise<string> {
  if (cachedSessionHtml) return cachedSessionHtml;
  cachedSessionHtml = await loadHtml("session-viewer.html");
  if (!cachedSessionHtml) {
    logger.error("session-viewer.html not found");
    return "<html><body><h1>Session viewer not found</h1></body></html>";
  }
  return cachedSessionHtml;
}

/**
 * The shared HTTP server instance. Exported so WebConnector can
 * listen for 'upgrade' events to handle WebSocket connections.
 */
export let httpServer: Server | null = null;

export function startHealthServer(port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      const healthy = isHealthy();
      const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);

      const body = JSON.stringify({
        status: healthy ? "ok" : "unhealthy",
        uptime: uptimeSeconds,
        whatsapp: state.whatsappConnected,
        postgres: state.postgresConnected,
        pgvector: state.pgvectorConnected,
      });

      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    if ((req.url === "/" || req.url === "/index.html") && req.method === "GET") {
      const html = await getWebUiHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // Public sub-agent session viewer: /s/:sessionId
    if (req.url?.startsWith("/s/") && req.method === "GET") {
      const html = await getSessionViewerHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // Media blob endpoint: /audio/:id or /img/:id (both use audio_blobs table)
    const mediaMatch = req.url?.match(/^\/(audio|img)\/([a-f0-9]{16})$/);
    if (mediaMatch && req.method === "GET") {
      try {
        const result = await query(
          `SELECT data, mime_type FROM audio_blobs WHERE id = $1`,
          [mediaMatch[2]]
        );
        if (result.rows.length === 0) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const { data, mime_type } = result.rows[0];
        res.writeHead(200, {
          "Content-Type": mime_type,
          "Content-Length": Buffer.byteLength(data),
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(data);
      } catch (err) {
        logger.error({ err }, "Failed to serve media blob");
        res.writeHead(500);
        res.end("Internal error");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer = server;

  server.listen(port, () => {
    logger.info({ port }, "HTTP server started (health + web UI)");
  });
}
