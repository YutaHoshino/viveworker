import { promises as fs } from "node:fs";
import path from "node:path";
import { ACCESS_MODE_VIVEWORKER, normalizeAccessMode } from "./vpn.mjs";

export const DEFAULT_MANAGED_REMOTE_CONTROL_URL =
  process.env.MANAGED_REMOTE_DEFAULT_CONTROL_URL || "http://127.0.0.1:8781";
export const DEFAULT_MANAGED_REMOTE_DOMAIN =
  process.env.MANAGED_REMOTE_DEFAULT_DOMAIN || "viveworker.com";
export const DEFAULT_MANAGED_DEVICE_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MANAGED_DEVICE_FLOW_POLL_MS = 1500;

function cleanText(value) {
  return String(value ?? "").trim();
}

export function resolveManagedRemoteAssetPaths(configDir) {
  const managedDir = path.join(configDir, "managed-remote");
  return {
    managedDir,
    metadataFile: path.join(managedDir, "metadata.json"),
    secretFile: path.join(managedDir, "secret.json"),
  };
}

export function buildManagedRemotePublicUrl({
  publicUrl = "",
  subdomain = "",
  domain = DEFAULT_MANAGED_REMOTE_DOMAIN,
} = {}) {
  const normalizedPublicUrl = cleanText(publicUrl);
  if (normalizedPublicUrl) {
    return normalizedPublicUrl;
  }
  const normalizedSubdomain = cleanText(subdomain).toLowerCase();
  if (!normalizedSubdomain) {
    return "";
  }
  return `https://${normalizedSubdomain}.${cleanText(domain).toLowerCase()}`;
}

export function buildManagedRemotePublicOrigin(config = {}) {
  const publicUrl = buildManagedRemotePublicUrl({
    publicUrl: config.managedRemotePublicUrl || config.MANAGED_REMOTE_PUBLIC_URL || "",
    subdomain: config.managedRemoteSubdomain || config.MANAGED_REMOTE_SUBDOMAIN || "",
  });
  if (!publicUrl) {
    return "";
  }
  try {
    return new URL(publicUrl).origin;
  } catch {
    return "";
  }
}

export function managedRemoteConfigured(config = {}) {
  return (
    normalizeAccessMode(config.accessMode || config.ACCESS_MODE, "") === ACCESS_MODE_VIVEWORKER &&
    Boolean(cleanText(config.managedRemoteInstallationId || config.MANAGED_REMOTE_INSTALLATION_ID || "")) &&
    Boolean(cleanText(config.managedRemoteSubdomain || config.MANAGED_REMOTE_SUBDOMAIN || "")) &&
    Boolean(cleanText(config.managedRemotePublicUrl || config.MANAGED_REMOTE_PUBLIC_URL || "")) &&
    Boolean(cleanText(config.managedRemoteControlUrl || config.MANAGED_REMOTE_CONTROL_URL || "")) &&
    Boolean(cleanText(config.managedRemoteSecretFile || config.MANAGED_REMOTE_SECRET_FILE || ""))
  );
}

export async function writeManagedRemoteArtifacts({
  configDir,
  installationId,
  subdomain,
  publicUrl,
  controlUrl,
  email = "",
  agentToken,
  refreshToken = "",
}) {
  const paths = resolveManagedRemoteAssetPaths(configDir);
  await fs.mkdir(paths.managedDir, { recursive: true });
  await fs.writeFile(
    paths.metadataFile,
    JSON.stringify(
      {
        installationId: cleanText(installationId),
        subdomain: cleanText(subdomain),
        publicUrl: cleanText(publicUrl),
        controlUrl: cleanText(controlUrl),
        email: cleanText(email),
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    paths.secretFile,
    JSON.stringify(
      {
        installationId: cleanText(installationId),
        agentToken: cleanText(agentToken),
        refreshToken: cleanText(refreshToken),
        savedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  return paths;
}

export async function readManagedRemoteSecrets(secretFile) {
  if (!cleanText(secretFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(secretFile, "utf8"));
    return {
      installationId: cleanText(parsed?.installationId),
      agentToken: cleanText(parsed?.agentToken),
      refreshToken: cleanText(parsed?.refreshToken),
    };
  } catch {
    return null;
  }
}

export async function startManagedDeviceFlow({
  controlUrl = DEFAULT_MANAGED_REMOTE_CONTROL_URL,
  machineName = "",
  locale = "",
}) {
  return await jsonRequest({
    method: "POST",
    controlUrl,
    pathname: "/api/device-flows",
    body: {
      machineName: cleanText(machineName),
      locale: cleanText(locale),
    },
  });
}

export async function pollManagedDeviceFlow({
  controlUrl = DEFAULT_MANAGED_REMOTE_CONTROL_URL,
  flowId,
  timeoutMs = DEFAULT_MANAGED_DEVICE_FLOW_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_MANAGED_DEVICE_FLOW_POLL_MS,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await jsonRequest({
      method: "GET",
      controlUrl,
      pathname: `/api/device-flows/${encodeURIComponent(cleanText(flowId))}`,
    });
    if (payload?.status === "approved" && payload.installation && payload.agentToken) {
      return payload;
    }
    if (payload?.status === "expired" || payload?.status === "rejected") {
      throw new Error(`Managed remote login ${payload.status}.`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error("Timed out waiting for managed remote login.");
}

export async function rotateManagedRemoteSubdomain({
  controlUrl = DEFAULT_MANAGED_REMOTE_CONTROL_URL,
  installationId,
  agentToken,
}) {
  return await jsonRequest({
    method: "POST",
    controlUrl,
    pathname: `/api/installations/${encodeURIComponent(cleanText(installationId))}/rotate`,
    body: {
      agentToken: cleanText(agentToken),
    },
  });
}

export async function updateManagedRemoteState({
  controlUrl = DEFAULT_MANAGED_REMOTE_CONTROL_URL,
  installationId,
  agentToken,
  remoteEnabled,
  remoteExpiresAtMs,
  remoteWindowId,
}) {
  return await jsonRequest({
    method: "POST",
    controlUrl,
    pathname: `/api/installations/${encodeURIComponent(cleanText(installationId))}/state`,
    body: {
      agentToken: cleanText(agentToken),
      remoteEnabled: Boolean(remoteEnabled),
      remoteExpiresAtMs: Number(remoteExpiresAtMs) || 0,
      remoteWindowId: cleanText(remoteWindowId),
    },
  });
}

async function jsonRequest({ method = "GET", controlUrl, pathname, body = null }) {
  const base = new URL(cleanText(controlUrl) || DEFAULT_MANAGED_REMOTE_CONTROL_URL);
  const url = new URL(pathname, base);
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = cleanText(payload?.error || payload?.message || "") || `${response.status} ${response.statusText}`;
    throw new Error(errorMessage);
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
