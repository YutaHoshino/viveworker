import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACCESS_MODE_CLOUDFLARE, normalizeAccessMode } from "./vpn.mjs";

export const REMOTE_ACCESS_PROVIDER_NONE = "none";
export const REMOTE_ACCESS_PROVIDER_CLOUDFLARE = "cloudflare";
export const DEFAULT_REMOTE_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_REMOTE_BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_CLOUDFLARED_LABEL = "io.viveworker.cloudflare-tunnel";
export const DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "io.viveworker.cloudflare-tunnel.plist"
);

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function normalizeRemoteAccessProvider(value, fallback = REMOTE_ACCESS_PROVIDER_NONE) {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === REMOTE_ACCESS_PROVIDER_CLOUDFLARE) {
    return normalized;
  }
  return fallback;
}

export function normalizeRemoteAccessAllowedEmails(value) {
  const values = Array.isArray(value)
    ? value
    : cleanText(value)
      .split(",")
      .map((entry) => cleanText(entry));
  const seen = new Set();
  const next = [];
  for (const entry of values) {
    const normalized = cleanText(entry).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

export function buildRemotePublicUrl(hostname) {
  const value = cleanText(hostname);
  return value ? `https://${value}` : "";
}

export function buildRemotePublicOrigin(hostname) {
  const publicUrl = buildRemotePublicUrl(hostname);
  if (!publicUrl) {
    return "";
  }
  try {
    return new URL(publicUrl).origin;
  } catch {
    return "";
  }
}

export function remoteAccessConfigured(config) {
  return (
    normalizeAccessMode(config?.accessMode, "") === ACCESS_MODE_CLOUDFLARE &&
    Boolean(cleanText(config?.remoteAccessPublicHostname || "")) &&
    Boolean(cleanText(config?.cloudflareAccountId || "")) &&
    Boolean(cleanText(config?.cloudflareZoneId || "")) &&
    Boolean(cleanText(config?.cloudflareTunnelId || "")) &&
    Boolean(cleanText(config?.cloudflareAccessAppId || "")) &&
    Boolean(cleanText(config?.cloudflareAccessPolicyId || "")) &&
    Boolean(cleanText(config?.cloudflareTunnelCredentialsFile || "")) &&
    Boolean(cleanText(config?.cloudflareTunnelConfigFile || ""))
  );
}

export function remoteAccessExpired(config, now = Date.now()) {
  const expiresAtMs = Number(config?.remoteAccessExpiresAtMs) || 0;
  return expiresAtMs > 0 && now >= expiresAtMs;
}

export function remoteAccessActive(config, now = Date.now()) {
  return (
    remoteAccessConfigured(config) &&
    config?.remoteAccessEnabled === true &&
    !remoteAccessExpired(config, now)
  );
}

export function resolveCloudflareAssetPaths(configDir) {
  const cloudflareDir = path.join(configDir, "cloudflare");
  return {
    cloudflareDir,
    manifestFile: path.join(cloudflareDir, "manifest.json"),
    credentialsFile: path.join(cloudflareDir, "tunnel-token.txt"),
    configFile: path.join(cloudflareDir, "config.yml"),
    metadataFile: path.join(cloudflareDir, "metadata.json"),
    logFile: path.join(cloudflareDir, "cloudflared.log"),
  };
}

export function defaultCloudflareTunnelName(publicHostname) {
  const slug = cleanText(publicHostname)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return `viveworker-${slug || "remote"}`;
}

export function buildCloudflaredLaunchAgentPlist({
  label = DEFAULT_CLOUDFLARED_LABEL,
  cloudflaredPath,
  credentialsFile,
  logFile,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(cloudflaredPath)}</string>
      <string>tunnel</string>
      <string>--no-autoupdate</string>
      <string>run</string>
      <string>--token-file</string>
      <string>${escapeXml(credentialsFile)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logFile)}</string>
  </dict>
</plist>
`;
}

export async function detectCloudflaredInstallation() {
  const cloudflaredPath = await findExecutable("cloudflared");
  const brewPath = await findExecutable("brew");
  return {
    detected: Boolean(cloudflaredPath),
    cloudflaredPath,
    brewPath,
  };
}

export async function ensureCloudflaredInstalled({ installIfMissing = false, streamOutput = false } = {}) {
  const detected = await detectCloudflaredInstallation();
  if (detected.detected) {
    return detected;
  }
  if (!installIfMissing) {
    return detected;
  }
  if (!detected.brewPath) {
    throw new Error("cloudflared is not installed and Homebrew is not available.");
  }
  await runCommand([detected.brewPath, "install", "cloudflared"], { streamOutput });
  const next = await detectCloudflaredInstallation();
  if (!next.detected) {
    throw new Error("cloudflared install did not produce a usable binary.");
  }
  return next;
}

export async function cloudflaredLaunchAgentStatus({
  label = DEFAULT_CLOUDFLARED_LABEL,
  launchAgentPath = DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH,
} = {}) {
  const installed = await fileExists(launchAgentPath);
  if (!installed) {
    return {
      installed: false,
      running: false,
      launchAgentPath,
      label,
    };
  }
  const printed = await runCommand(["launchctl", "print", `gui/${process.getuid()}/${label}`], {
    ignoreError: true,
  });
  return {
    installed: true,
    running: printed.ok,
    launchAgentPath,
    label,
    stdout: printed.stdout,
    stderr: printed.stderr,
  };
}

export async function startCloudflaredLaunchAgent({
  label = DEFAULT_CLOUDFLARED_LABEL,
  launchAgentPath = DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH,
}) {
  await runCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath], {
    ignoreError: true,
  });
  await runCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${label}`]);
}

export async function stopCloudflaredLaunchAgent({
  launchAgentPath = DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH,
}) {
  await runCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], {
    ignoreError: true,
  });
}

export async function writeCloudflareTunnelAssets({
  configDir,
  accountId,
  zoneId,
  tunnelId,
  tunnelName,
  publicHostname,
  allowedEmails,
  upstreamUrl,
  tunnelToken,
}) {
  const paths = resolveCloudflareAssetPaths(configDir);
  await fs.mkdir(paths.cloudflareDir, { recursive: true });
  await fs.writeFile(paths.credentialsFile, `${cleanText(tunnelToken)}\n`, { mode: 0o600 });
  await fs.writeFile(
    paths.configFile,
    buildCloudflaredConfig({
      tunnelId,
      publicHostname,
      upstreamUrl,
    }),
    "utf8"
  );
  await fs.writeFile(
    paths.metadataFile,
    JSON.stringify(
      {
        accessMode: ACCESS_MODE_CLOUDFLARE,
        accountId: cleanText(accountId),
        zoneId: cleanText(zoneId),
        tunnelId: cleanText(tunnelId),
        tunnelName: cleanText(tunnelName),
        publicHostname: cleanText(publicHostname),
        publicUrl: buildRemotePublicUrl(publicHostname),
        allowedEmails: normalizeRemoteAccessAllowedEmails(allowedEmails),
        upstreamUrl: cleanText(upstreamUrl),
        tokenFile: paths.credentialsFile,
        configFile: paths.configFile,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    paths.manifestFile,
    JSON.stringify(
      {
        accessMode: ACCESS_MODE_CLOUDFLARE,
        credentialsFile: paths.credentialsFile,
        configFile: paths.configFile,
        metadataFile: paths.metadataFile,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
  return paths;
}

export async function reconcileCloudflareRemoteAccess({
  apiToken,
  accountId,
  publicHostname,
  allowedEmails,
  tunnelId = "",
  tunnelName = "",
  zoneId = "",
  accessAppId = "",
  accessPolicyId = "",
  upstreamUrl,
}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedPublicHostname = cleanText(publicHostname).toLowerCase();
  const normalizedAllowedEmails = normalizeRemoteAccessAllowedEmails(allowedEmails);
  if (!normalizedAccountId) {
    throw new Error("Cloudflare account ID is required.");
  }
  if (!normalizedPublicHostname) {
    throw new Error("Cloudflare public hostname is required.");
  }
  if (normalizedAllowedEmails.length === 0) {
    throw new Error("At least one allowlisted email is required for Cloudflare Access.");
  }
  if (!cleanText(upstreamUrl)) {
    throw new Error("A local upstream URL is required for the Cloudflare tunnel.");
  }

  const resolvedZoneId = await ensureZoneId({
    apiToken,
    publicHostname: normalizedPublicHostname,
    existingZoneId: zoneId,
  });

  const resolvedTunnel = await ensureTunnel({
    apiToken,
    accountId: normalizedAccountId,
    tunnelId,
    tunnelName: cleanText(tunnelName) || defaultCloudflareTunnelName(normalizedPublicHostname),
  });
  await putTunnelConfig({
    apiToken,
    accountId: normalizedAccountId,
    tunnelId: resolvedTunnel.id,
    publicHostname: normalizedPublicHostname,
    upstreamUrl,
  });
  const tunnelToken = await fetchTunnelToken({
    apiToken,
    accountId: normalizedAccountId,
    tunnelId: resolvedTunnel.id,
  });

  await ensureDnsRecord({
    apiToken,
    zoneId: resolvedZoneId,
    publicHostname: normalizedPublicHostname,
    tunnelId: resolvedTunnel.id,
  });

  const resolvedApp = await ensureAccessApplication({
    apiToken,
    accountId: normalizedAccountId,
    accessAppId,
    publicHostname: normalizedPublicHostname,
  });
  const resolvedPolicy = await ensureAccessPolicy({
    apiToken,
    accountId: normalizedAccountId,
    appId: resolvedApp.id,
    accessPolicyId,
    allowedEmails: normalizedAllowedEmails,
  });

  return {
    zoneId: resolvedZoneId,
    tunnelId: resolvedTunnel.id,
    tunnelName: resolvedTunnel.name,
    tunnelToken,
    accessAppId: resolvedApp.id,
    accessPolicyId: resolvedPolicy.id,
    publicHostname: normalizedPublicHostname,
    allowedEmails: normalizedAllowedEmails,
  };
}

export async function verifyCloudflareRemoteAccess({
  apiToken,
  accountId,
  zoneId,
  tunnelId,
  publicHostname,
  accessAppId,
  accessPolicyId,
}) {
  const issues = [];
  const normalizedAccountId = cleanText(accountId);
  const normalizedZoneId = cleanText(zoneId);
  const normalizedTunnelId = cleanText(tunnelId);
  const normalizedAppId = cleanText(accessAppId);
  const normalizedPolicyId = cleanText(accessPolicyId);
  const normalizedHostname = cleanText(publicHostname).toLowerCase();

  if (!normalizedAccountId || !normalizedZoneId || !normalizedTunnelId || !normalizedAppId || !normalizedPolicyId || !normalizedHostname) {
    return ["Cloudflare remote access is missing required IDs or hostnames."];
  }

  try {
    await cloudflareApiRequest(apiToken, "GET", `/zones/${encodeURIComponent(normalizedZoneId)}`);
  } catch (error) {
    issues.push(`Cloudflare zone lookup failed: ${error.message}`);
  }

  try {
    const tunnels = await listTunnels({ apiToken, accountId: normalizedAccountId });
    const tunnel = tunnels.find((entry) => cleanText(entry?.id) === normalizedTunnelId);
    if (!tunnel) {
      issues.push("Cloudflare tunnel was not found.");
    }
  } catch (error) {
    issues.push(`Cloudflare tunnel lookup failed: ${error.message}`);
  }

  try {
    const records = await cloudflareApiRequest(
      apiToken,
      "GET",
      `/zones/${encodeURIComponent(normalizedZoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(normalizedHostname)}&per_page=100`
    );
    const expectedTarget = `${normalizedTunnelId}.cfargotunnel.com`;
    const match = records.find(
      (record) =>
        cleanText(record?.type).toUpperCase() === "CNAME" &&
        cleanText(record?.name).toLowerCase() === normalizedHostname &&
        cleanText(record?.content).toLowerCase() === expectedTarget
    );
    if (!match) {
      issues.push("Cloudflare DNS route was not found or does not point at the expected tunnel target.");
    }
  } catch (error) {
    issues.push(`Cloudflare DNS verification failed: ${error.message}`);
  }

  try {
    await cloudflareApiRequest(
      apiToken,
      "GET",
      `/accounts/${encodeURIComponent(normalizedAccountId)}/access/apps/${encodeURIComponent(normalizedAppId)}`
    );
  } catch (error) {
    issues.push(`Cloudflare Access app lookup failed: ${error.message}`);
  }

  try {
    await cloudflareApiRequest(
      apiToken,
      "GET",
      `/accounts/${encodeURIComponent(normalizedAccountId)}/access/apps/${encodeURIComponent(normalizedAppId)}/policies/${encodeURIComponent(normalizedPolicyId)}`
    );
  } catch (error) {
    issues.push(`Cloudflare Access policy lookup failed: ${error.message}`);
  }

  return issues;
}

async function ensureZoneId({ apiToken, publicHostname, existingZoneId = "" }) {
  const zoneId = cleanText(existingZoneId);
  if (zoneId) {
    try {
      await cloudflareApiRequest(apiToken, "GET", `/zones/${encodeURIComponent(zoneId)}`);
      return zoneId;
    } catch {
      // Fall through to hostname-based resolution.
    }
  }

  const hostname = cleanText(publicHostname).toLowerCase();
  const labels = hostname.split(".").filter(Boolean);
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join(".");
    const zones = await cloudflareApiRequest(
      apiToken,
      "GET",
      `/zones?name=${encodeURIComponent(candidate)}&status=active&per_page=20`
    );
    const match = zones.find((zone) => cleanText(zone?.name).toLowerCase() === candidate);
    if (match?.id) {
      return cleanText(match.id);
    }
  }

  throw new Error(`Unable to resolve a Cloudflare zone for ${hostname}.`);
}

async function ensureTunnel({ apiToken, accountId, tunnelId = "", tunnelName }) {
  const existingTunnels = await listTunnels({ apiToken, accountId });
  const byId = cleanText(tunnelId);
  const byName = cleanText(tunnelName);
  const existing =
    existingTunnels.find((entry) => cleanText(entry?.id) === byId) ||
    existingTunnels.find((entry) => cleanText(entry?.name) === byName);
  if (existing?.id) {
    return {
      id: cleanText(existing.id),
      name: cleanText(existing.name) || byName,
    };
  }

  const created = await cloudflareApiRequest(
    apiToken,
    "POST",
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
    {
      name: byName,
      config_src: "cloudflare",
    }
  );
  return {
    id: cleanText(created?.id),
    name: cleanText(created?.name) || byName,
  };
}

async function listTunnels({ apiToken, accountId }) {
  const result = await cloudflareApiRequest(
    apiToken,
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false&per_page=1000`
  );
  return Array.isArray(result) ? result : [];
}

async function putTunnelConfig({ apiToken, accountId, tunnelId, publicHostname, upstreamUrl }) {
  await cloudflareApiRequest(
    apiToken,
    "PUT",
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
    {
      config: {
        ingress: [
          {
            hostname: cleanText(publicHostname),
            service: cleanText(upstreamUrl),
            originRequest: {
              noTLSVerify: true,
            },
          },
          {
            service: "http_status:404",
          },
        ],
      },
    }
  );
}

async function fetchTunnelToken({ apiToken, accountId, tunnelId }) {
  const result = await cloudflareApiRequest(
    apiToken,
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`
  );
  if (typeof result === "string") {
    return cleanText(result);
  }
  return cleanText(result?.token ?? "");
}

async function ensureDnsRecord({ apiToken, zoneId, publicHostname, tunnelId }) {
  const hostname = cleanText(publicHostname).toLowerCase();
  const target = `${cleanText(tunnelId)}.cfargotunnel.com`;
  const existing = await cloudflareApiRequest(
    apiToken,
    "GET",
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=100`
  );
  const record = Array.isArray(existing)
    ? existing.find((entry) => cleanText(entry?.name).toLowerCase() === hostname)
    : null;
  const payload = {
    type: "CNAME",
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
  };
  if (record?.id) {
    await cloudflareApiRequest(
      apiToken,
      "PATCH",
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
      payload
    );
    return cleanText(record.id);
  }
  const created = await cloudflareApiRequest(
    apiToken,
    "POST",
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
    payload
  );
  return cleanText(created?.id);
}

async function ensureAccessApplication({ apiToken, accountId, accessAppId = "", publicHostname }) {
  const existingApps = await cloudflareApiRequest(
    apiToken,
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/access/apps?page=1&per_page=1000`
  );
  const hostname = cleanText(publicHostname).toLowerCase();
  const apps = Array.isArray(existingApps) ? existingApps : [];
  const app =
    apps.find((entry) => cleanText(entry?.id) === cleanText(accessAppId)) ||
    apps.find((entry) => accessAppMatchesHostname(entry, hostname));
  const payload = {
    name: `viveworker remote access (${hostname})`,
    type: "self_hosted",
    domain: hostname,
    self_hosted_domains: [hostname],
    destinations: [
      {
        type: "public",
        uri: `https://${hostname}`,
      },
    ],
    session_duration: "12h",
    app_launcher_visible: false,
    skip_interstitial: false,
  };
  if (app?.id) {
    const updated = await cloudflareApiRequest(
      apiToken,
      "PUT",
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(app.id)}`,
      payload
    );
    return {
      id: cleanText(updated?.id || app.id),
    };
  }
  const created = await cloudflareApiRequest(
    apiToken,
    "POST",
    `/accounts/${encodeURIComponent(accountId)}/access/apps`,
    payload
  );
  return {
    id: cleanText(created?.id),
  };
}

function accessAppMatchesHostname(app, hostname) {
  if (!app || !hostname) {
    return false;
  }
  if (cleanText(app.domain).toLowerCase() === hostname) {
    return true;
  }
  if (Array.isArray(app.self_hosted_domains)) {
    for (const value of app.self_hosted_domains) {
      if (cleanText(value).toLowerCase() === hostname) {
        return true;
      }
    }
  }
  if (Array.isArray(app.destinations)) {
    for (const destination of app.destinations) {
      const uri = cleanText(destination?.uri).toLowerCase();
      if (uri === `https://${hostname}` || uri === hostname) {
        return true;
      }
    }
  }
  return false;
}

async function ensureAccessPolicy({ apiToken, accountId, appId, accessPolicyId = "", allowedEmails }) {
  const policiesResult = await cloudflareApiRequest(
    apiToken,
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies?page=1&per_page=1000`
  );
  const policies = Array.isArray(policiesResult) ? policiesResult : [];
  const policy =
    policies.find((entry) => cleanText(entry?.id) === cleanText(accessPolicyId)) ||
    policies.find((entry) => cleanText(entry?.name) === "viveworker allowlist");
  const payload = {
    name: "viveworker allowlist",
    decision: "allow",
    include: normalizeRemoteAccessAllowedEmails(allowedEmails).map((email) => ({
      email: { email },
    })),
    exclude: [],
    require: [],
  };
  if (policy?.id) {
    const updated = await cloudflareApiRequest(
      apiToken,
      "PUT",
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(policy.id)}`,
      payload
    );
    return {
      id: cleanText(updated?.id || policy.id),
    };
  }
  const created = await cloudflareApiRequest(
    apiToken,
    "POST",
    `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
    payload
  );
  return {
    id: cleanText(created?.id),
  };
}

async function cloudflareApiRequest(apiToken, method, apiPath, body = null) {
  const token = cleanText(apiToken);
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN is required.");
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const errorMessages = Array.isArray(payload?.errors)
      ? payload.errors.map((entry) => cleanText(entry?.message || entry?.code)).filter(Boolean)
      : [];
    throw new Error(errorMessages.join("; ") || payload?.message || `${method} ${apiPath} failed`);
  }
  return payload?.result;
}

function buildCloudflaredConfig({ tunnelId, publicHostname, upstreamUrl }) {
  return [
    `tunnel: ${cleanText(tunnelId)}`,
    "ingress:",
    `  - hostname: ${cleanText(publicHostname)}`,
    `    service: ${cleanText(upstreamUrl)}`,
    "    originRequest:",
    "      noTLSVerify: true",
    "  - service: http_status:404",
    "",
  ].join("\n");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name) {
  const pathEnv = cleanText(process.env.PATH || "");
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function runCommand(args, { ignoreError = false, streamOutput = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stdout += value;
      if (streamOutput) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stderr += value;
      if (streamOutput) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error) => {
      if (ignoreError) {
        resolve({ ok: false, stdout, stderr: `${stderr}${error.message}` });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0 || ignoreError) {
        resolve({ ok: code === 0, stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${args[0]} exited with code ${code}`));
    });
  });
}
