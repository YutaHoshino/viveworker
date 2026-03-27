#!/usr/bin/env node

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8781;
const HOST = process.env.HOST || "127.0.0.1";
const CONTROL_BASE_URL = stripTrailingSlash(process.env.CONTROL_BASE_URL || `http://${HOST}:${PORT}`);
const DOMAIN = cleanText(process.env.VIVEWORKER_RELAY_DOMAIN || "viveworker.com").toLowerCase();
const DATA_FILE = resolvePath(process.env.VIVEWORKER_RELAY_DATA_FILE || path.join(process.cwd(), "services/relay/data.json"));
const MAGIC_LINK_ECHO = truthy(process.env.VIVEWORKER_RELAY_MAGIC_LINK_ECHO || "1");
const SESSION_COOKIE = "viveworker_relay_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 30 * 1000;

const store = await loadStore(DATA_FILE);
const browserSessions = new Map();
const agentSockets = new Map();
const pendingProxyRequests = new Map();

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", CONTROL_BASE_URL);
  if (url.pathname !== "/api/relay/agent") {
    socket.destroy();
    return;
  }
  const installationId = cleanText(url.searchParams.get("installationId"));
  const agentToken = cleanText(url.searchParams.get("agentToken"));
  const installation = store.installations[installationId];
  if (!installation || installation.agentToken !== agentToken) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, installationId);
  });
});

wss.on("connection", (ws, request, installationId) => {
  const installation = store.installations[installationId];
  if (!installation) {
    ws.close();
    return;
  }
  installation.agentConnectedAt = Date.now();
  installation.lastSeenAt = Date.now();
  agentSockets.set(installationId, ws);
  persistSoon();

  ws.on("message", async (raw) => {
    const payload = parseJson(raw);
    if (!payload || typeof payload !== "object") {
      return;
    }
    installation.lastSeenAt = Date.now();
    if (payload.type === "state") {
      installation.remoteEnabled = payload.remoteEnabled === true;
      installation.remoteExpiresAtMs = Number(payload.remoteExpiresAtMs) || 0;
      installation.remoteWindowId = cleanText(payload.remoteWindowId);
      installation.publicUrl = cleanText(payload.publicUrl || installation.publicUrl);
      installation.subdomain = cleanText(payload.subdomain || installation.subdomain).toLowerCase();
      persistSoon();
      return;
    }
    if (payload.type === "http.response") {
      const pending = pendingProxyRequests.get(cleanText(payload.id));
      if (!pending) {
        return;
      }
      pendingProxyRequests.delete(cleanText(payload.id));
      clearTimeout(pending.timeout);
      pending.resolve({
        status: Number(payload.status) || 502,
        headers: isPlainObject(payload.headers) ? payload.headers : {},
        bodyBase64: cleanText(payload.bodyBase64),
      });
    }
  });

  ws.on("close", () => {
    if (agentSockets.get(installationId) === ws) {
      agentSockets.delete(installationId);
    }
    installation.lastSeenAt = Date.now();
    persistSoon();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[viveworker-relay] listening on ${HOST}:${PORT}`);
  console.log(`[viveworker-relay] control base: ${CONTROL_BASE_URL}`);
  console.log(`[viveworker-relay] domain: ${DOMAIN}`);
});

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", CONTROL_BASE_URL);
    const host = cleanHost(req.headers.host);
    const installation = findInstallationByHost(host);
    if (installation) {
      await handleInstallationRequest(req, res, url, installation);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/device-flows") {
      const body = await readJsonBody(req);
      const flowId = crypto.randomUUID();
      store.deviceFlows[flowId] = {
        id: flowId,
        machineName: cleanText(body?.machineName || ""),
        locale: cleanText(body?.locale || ""),
        status: "pending",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + FLOW_TTL_MS,
      };
      await persistStore(DATA_FILE, store);
      return writeJson(res, 200, {
        flowId,
        verifyUrl: `${CONTROL_BASE_URL}/verify/${encodeURIComponent(flowId)}`,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/device-flows/")) {
      const flowId = cleanText(url.pathname.split("/").pop());
      const flow = store.deviceFlows[flowId];
      if (!flow) {
        return writeJson(res, 404, { error: "flow-not-found" });
      }
      expireFlow(flow);
      if (flow.status === "approved") {
        return writeJson(res, 200, {
          status: "approved",
          installation: {
            installationId: flow.installationId,
            subdomain: flow.subdomain,
            publicUrl: flow.publicUrl,
            email: flow.email,
          },
          agentToken: flow.agentToken,
          controlUrl: CONTROL_BASE_URL,
        });
      }
      return writeJson(res, 200, {
        status: flow.status,
      });
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/installations\/[^/]+\/state$/u)) {
      const installationId = cleanText(url.pathname.split("/")[3]);
      const installation = store.installations[installationId];
      if (!installation) {
        return writeJson(res, 404, { error: "installation-not-found" });
      }
      const body = await readJsonBody(req);
      if (cleanText(body?.agentToken) !== installation.agentToken) {
        return writeJson(res, 401, { error: "invalid-agent-token" });
      }
      installation.remoteEnabled = body?.remoteEnabled === true;
      installation.remoteExpiresAtMs = Number(body?.remoteExpiresAtMs) || 0;
      installation.remoteWindowId = cleanText(body?.remoteWindowId);
      installation.lastSeenAt = Date.now();
      await persistStore(DATA_FILE, store);
      return writeJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/installations\/[^/]+\/rotate$/u)) {
      const installationId = cleanText(url.pathname.split("/")[3]);
      const installation = store.installations[installationId];
      if (!installation) {
        return writeJson(res, 404, { error: "installation-not-found" });
      }
      const body = await readJsonBody(req);
      if (cleanText(body?.agentToken) !== installation.agentToken) {
        return writeJson(res, 401, { error: "invalid-agent-token" });
      }
      installation.subdomain = crypto.randomUUID().toLowerCase();
      installation.publicUrl = `https://${installation.subdomain}.${DOMAIN}`;
      installation.agentToken = crypto.randomBytes(24).toString("hex");
      installation.remoteEnabled = false;
      installation.remoteExpiresAtMs = 0;
      installation.remoteWindowId = "";
      await persistStore(DATA_FILE, store);
      return writeJson(res, 200, {
        installationId,
        subdomain: installation.subdomain,
        publicUrl: installation.publicUrl,
        agentToken: installation.agentToken,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/verify/")) {
      const flowId = cleanText(url.pathname.split("/").pop());
      const flow = store.deviceFlows[flowId];
      if (!flow) {
        return writeHtml(res, 404, renderSimplePage("Flow not found", "<p>This login flow was not found.</p>"));
      }
      expireFlow(flow);
      if (flow.status !== "pending") {
        return writeHtml(res, 200, renderSimplePage("Flow already completed", "<p>You can return to the Mac.</p>"));
      }
      return writeHtml(res, 200, renderVerifyPage(flowId));
    }

    if (req.method === "POST" && url.pathname.startsWith("/verify/")) {
      const flowId = cleanText(url.pathname.split("/").pop());
      const flow = store.deviceFlows[flowId];
      if (!flow) {
        return writeHtml(res, 404, renderSimplePage("Flow not found", "<p>This login flow was not found.</p>"));
      }
      expireFlow(flow);
      if (flow.status !== "pending") {
        return writeHtml(res, 200, renderSimplePage("Flow already completed", "<p>You can return to the Mac.</p>"));
      }
      const form = await readFormBody(req);
      const email = cleanText(form.email).toLowerCase();
      if (!email) {
        return writeHtml(res, 400, renderSimplePage("Email required", "<p>Please enter an email address.</p>"));
      }
      const magicToken = crypto.randomBytes(24).toString("hex");
      store.magicLinks[magicToken] = {
        token: magicToken,
        flowId,
        email,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + FLOW_TTL_MS,
      };
      await persistStore(DATA_FILE, store);
      const magicUrl = `${CONTROL_BASE_URL}/auth/magic/${magicToken}`;
      console.log(`[viveworker-relay] magic link for ${email}: ${magicUrl}`);
      return writeHtml(
        res,
        200,
        renderSimplePage(
          "Check your email",
          `<p>A magic link has been created for <strong>${escapeHtml(email)}</strong>.</p>${MAGIC_LINK_ECHO ? `<p><a href="${escapeHtml(magicUrl)}">Open magic link</a></p>` : "<p>Open the link from your email to continue.</p>"}`
        )
      );
    }

    if (req.method === "GET" && url.pathname.startsWith("/auth/magic/")) {
      const magicToken = cleanText(url.pathname.split("/").pop());
      const link = store.magicLinks[magicToken];
      if (!link || Number(link.expiresAtMs) <= Date.now()) {
        return writeHtml(res, 400, renderSimplePage("Link expired", "<p>This magic link is no longer valid.</p>"));
      }
      let user = findUserByEmail(link.email);
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          email: link.email,
        };
        store.users[user.id] = user;
      }
      const flow = store.deviceFlows[link.flowId];
      if (flow && flow.status === "pending") {
        const installationId = crypto.randomUUID();
        const subdomain = crypto.randomUUID().toLowerCase();
        const installation = {
          id: installationId,
          userId: user.id,
          email: user.email,
          subdomain,
          publicUrl: `https://${subdomain}.${DOMAIN}`,
          agentToken: crypto.randomBytes(24).toString("hex"),
          remoteEnabled: false,
          remoteExpiresAtMs: 0,
          remoteWindowId: "",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          lastSeenAt: 0,
          agentConnectedAt: 0,
        };
        store.installations[installationId] = installation;
        flow.status = "approved";
        flow.email = user.email;
        flow.installationId = installationId;
        flow.subdomain = subdomain;
        flow.publicUrl = installation.publicUrl;
        flow.agentToken = installation.agentToken;
      }
      const sessionId = crypto.randomUUID();
      browserSessions.set(sessionId, {
        id: sessionId,
        userId: user.id,
        email: user.email,
        expiresAtMs: Date.now() + SESSION_TTL_MS,
      });
      delete store.magicLinks[magicToken];
      await persistStore(DATA_FILE, store);
      res.setHeader("Set-Cookie", buildCookie(SESSION_COOKIE, sessionId, { maxAgeSecs: Math.floor(SESSION_TTL_MS / 1000) }));
      return writeHtml(res, 200, renderSimplePage("Login complete", "<p>You can return to viveworker now.</p>"));
    }

    return writeHtml(
      res,
      200,
      renderSimplePage(
        "viveworker relay",
        "<p>This is the managed relay control service.</p>"
      )
    );
  } catch (error) {
    return writeJson(res, 500, { error: error.message || String(error) });
  }
}

async function handleInstallationRequest(req, res, url, installation) {
  const session = readBrowserSession(req);
  if (!session || session.userId !== installation.userId) {
    if (req.method === "POST" && url.pathname === "/auth/start") {
      const form = await readFormBody(req);
      const email = cleanText(form.email).toLowerCase();
      if (!email || email !== installation.email) {
        return writeHtml(res, 400, renderSimplePage("Wrong email", "<p>Use the same email that owns this remote URL.</p>"));
      }
      const magicToken = crypto.randomBytes(24).toString("hex");
      store.magicLinks[magicToken] = {
        token: magicToken,
        installationId: installation.id,
        email,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + FLOW_TTL_MS,
      };
      await persistStore(DATA_FILE, store);
      const magicUrl = `${installation.publicUrl}/auth/magic/${magicToken}`;
      console.log(`[viveworker-relay] browser magic link for ${email}: ${magicUrl}`);
      return writeHtml(
        res,
        200,
        renderSimplePage(
          "Check your email",
          `<p>A magic link has been created for <strong>${escapeHtml(email)}</strong>.</p>${MAGIC_LINK_ECHO ? `<p><a href="${escapeHtml(magicUrl)}">Open magic link</a></p>` : "<p>Open the link from your email to continue.</p>"}`
        )
      );
    }
    if (req.method === "GET" && url.pathname.startsWith("/auth/magic/")) {
      const magicToken = cleanText(url.pathname.split("/").pop());
      const link = store.magicLinks[magicToken];
      if (!link || Number(link.expiresAtMs) <= Date.now() || link.installationId !== installation.id) {
        return writeHtml(res, 400, renderSimplePage("Link expired", "<p>This magic link is no longer valid.</p>"));
      }
      const user = findUserByEmail(link.email);
      if (!user || user.id !== installation.userId) {
        return writeHtml(res, 400, renderSimplePage("Link invalid", "<p>This magic link does not match the installation owner.</p>"));
      }
      const sessionId = crypto.randomUUID();
      browserSessions.set(sessionId, {
        id: sessionId,
        userId: user.id,
        email: user.email,
        expiresAtMs: Date.now() + SESSION_TTL_MS,
      });
      delete store.magicLinks[magicToken];
      await persistStore(DATA_FILE, store);
      res.setHeader("Set-Cookie", buildCookie(SESSION_COOKIE, sessionId, { maxAgeSecs: Math.floor(SESSION_TTL_MS / 1000) }));
      res.statusCode = 302;
      res.setHeader("Location", "/app");
      res.end();
      return;
    }
    return writeHtml(res, 200, renderInstallationLoginPage(installation));
  }

  if (!installation.remoteEnabled || (Number(installation.remoteExpiresAtMs) > 0 && Number(installation.remoteExpiresAtMs) <= Date.now())) {
    return writeHtml(res, 200, renderSimplePage("Remote access is off", "<p>Enable remote access from the LAN app first.</p>"));
  }

  const ws = agentSockets.get(installation.id);
  if (!ws || ws.readyState !== 1) {
    return writeHtml(res, 200, renderSimplePage("Mac is offline", "<p>The Mac bridge is not connected right now.</p>"));
  }

  const requestId = crypto.randomUUID();
  const bodyBuffer = await readBuffer(req);
  const headers = filterProxyHeaders(req.headers);
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingProxyRequests.delete(requestId);
      reject(new Error("Timed out waiting for the Mac bridge."));
    }, REQUEST_TTL_MS);
    pendingProxyRequests.set(requestId, { resolve, reject, timeout });
  });
  ws.send(
    JSON.stringify({
      type: "http.request",
      id: requestId,
      method: req.method,
      path: url.pathname + url.search,
      remoteHost: cleanHost(req.headers.host),
      headers,
      bodyBase64: bodyBuffer.length ? bodyBuffer.toString("base64") : "",
    })
  );
  try {
    const response = await responsePromise;
    for (const [header, value] of Object.entries(response.headers || {})) {
      if (header.toLowerCase() === "content-length") {
        continue;
      }
      res.setHeader(header, value);
    }
    res.statusCode = Number(response.status) || 200;
    res.end(response.bodyBase64 ? Buffer.from(response.bodyBase64, "base64") : Buffer.alloc(0));
  } catch (error) {
    writeHtml(res, 502, renderSimplePage("Proxy error", `<p>${escapeHtml(error.message || String(error))}</p>`));
  }
}

function findInstallationByHost(host) {
  const normalizedHost = cleanHost(host);
  if (!normalizedHost || !normalizedHost.endsWith(`.${DOMAIN}`)) {
    return null;
  }
  return Object.values(store.installations).find(
    (installation) => cleanText(installation.subdomain).toLowerCase() === normalizedHost.slice(0, -(DOMAIN.length + 1))
  ) || null;
}

function findUserByEmail(email) {
  const normalizedEmail = cleanText(email).toLowerCase();
  return Object.values(store.users).find((user) => cleanText(user.email).toLowerCase() === normalizedEmail) || null;
}

function readBrowserSession(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  const session = browserSessions.get(cleanText(sessionId));
  if (!session || session.expiresAtMs <= Date.now()) {
    return null;
  }
  return session;
}

function expireFlow(flow) {
  if (!flow) {
    return;
  }
  if (flow.status === "pending" && Number(flow.expiresAtMs) <= Date.now()) {
    flow.status = "expired";
  }
}

async function loadStore(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      users: isPlainObject(parsed.users) ? parsed.users : {},
      deviceFlows: isPlainObject(parsed.deviceFlows) ? parsed.deviceFlows : {},
      magicLinks: isPlainObject(parsed.magicLinks) ? parsed.magicLinks : {},
      installations: isPlainObject(parsed.installations) ? parsed.installations : {},
    };
  } catch {
    return {
      users: {},
      deviceFlows: {},
      magicLinks: {},
      installations: {},
    };
  }
}

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistStore(DATA_FILE, store).catch((error) => {
      console.error("[viveworker-relay] persist failed", error);
    });
  }, 100);
}

async function persistStore(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function renderVerifyPage(flowId) {
  return renderSimplePage(
    "Authorize viveworker",
    `<form method="post" action="/verify/${escapeHtml(flowId)}">
      <p>Enter the email address you want to use for managed remote access.</p>
      <p><input type="email" name="email" placeholder="you@example.com" required /></p>
      <p><button type="submit">Send magic link</button></p>
    </form>`
  );
}

function renderInstallationLoginPage(installation) {
  return renderSimplePage(
    "Sign in to remote access",
    `<form method="post" action="/auth/start">
      <p>Sign in with the email that owns <strong>${escapeHtml(installation.publicUrl)}</strong>.</p>
      <p><input type="email" name="email" placeholder="${escapeHtml(installation.email)}" required /></p>
      <p><button type="submit">Send magic link</button></p>
    </form>`
  );
}

function renderSimplePage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 32px; background: #f6f7fb; color: #111827; }
    main { max-width: 560px; margin: 0 auto; background: white; padding: 24px; border-radius: 16px; box-shadow: 0 8px 40px rgba(15, 23, 42, 0.08); }
    input, button { font: inherit; }
    input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #d1d5db; }
    button { padding: 10px 14px; border-radius: 10px; border: 0; background: #111827; color: white; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function buildCookie(name, value, { maxAgeSecs = 0 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Number(maxAgeSecs) || 0)}`;
}

function parseCookies(req) {
  const header = Array.isArray(req.headers.cookie) ? req.headers.cookie.join(";") : String(req.headers.cookie || "");
  const result = {};
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.split("=");
    const name = cleanText(rawName);
    if (!name) {
      continue;
    }
    result[name] = decodeURIComponent(rest.join("=") || "");
  }
  return result;
}

async function readJsonBody(req) {
  const buffer = await readBuffer(req);
  if (!buffer.length) {
    return {};
  }
  return JSON.parse(buffer.toString("utf8"));
}

async function readFormBody(req) {
  const buffer = await readBuffer(req);
  return Object.fromEntries(new URLSearchParams(buffer.toString("utf8")).entries());
}

async function readBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

function writeHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
}

function cleanHost(value) {
  return cleanText(value).toLowerCase().replace(/:\d+$/u, "");
}

function filterProxyHeaders(headers = {}) {
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = String(key || "").toLowerCase();
    if (
      normalizedKey === "host" ||
      normalizedKey === "connection" ||
      normalizedKey === "content-length" ||
      normalizedKey === "accept-encoding"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      next[normalizedKey] = value.join(", ");
    } else if (value != null) {
      next[normalizedKey] = String(value);
    }
  }
  return next;
}

function stripTrailingSlash(value) {
  return cleanText(value).replace(/\/+$/u, "");
}

function resolvePath(targetPath) {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(process.cwd(), targetPath);
}

function truthy(value) {
  return /^(1|true|yes|on)$/iu.test(cleanText(value));
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
