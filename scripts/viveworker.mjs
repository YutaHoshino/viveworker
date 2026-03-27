#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface as createReadlineInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCALE, normalizeLocale, t } from "../web/i18n.js";
import { generatePairingCredentials, shouldRotatePairing, upsertEnvText } from "./lib/pairing.mjs";
import {
  ACCESS_MODE_LAN,
  ACCESS_MODE_VIVEWORKER,
  ACCESS_MODE_CLOUDFLARE,
  LEGACY_ACCESS_MODE_VPN,
  accessModeHasRemoteOverlay,
  accessModeRequiresHttps,
  isCloudflareAccessMode,
  isLegacyVpnAccessMode,
  normalizeAccessMode,
} from "./lib/vpn.mjs";
import {
  DEFAULT_CLOUDFLARED_LABEL,
  DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH,
  buildCloudflaredLaunchAgentPlist,
  buildRemotePublicUrl,
  cleanText as cleanRemoteText,
  cloudflaredLaunchAgentStatus,
  defaultCloudflareTunnelName,
  detectCloudflaredInstallation,
  ensureCloudflaredInstalled,
  normalizeRemoteAccessAllowedEmails,
  reconcileCloudflareRemoteAccess,
  remoteAccessActive,
  remoteAccessConfigured,
  remoteAccessExpired,
  resolveCloudflareAssetPaths,
  startCloudflaredLaunchAgent,
  stopCloudflaredLaunchAgent,
  verifyCloudflareRemoteAccess,
  writeCloudflareTunnelAssets,
} from "./lib/cloudflare.mjs";
import {
  DEFAULT_MANAGED_REMOTE_CONTROL_URL,
  buildManagedRemotePublicOrigin,
  buildManagedRemotePublicUrl,
  managedRemoteConfigured,
  pollManagedDeviceFlow,
  readManagedRemoteSecrets,
  resolveManagedRemoteAssetPaths,
  rotateManagedRemoteSubdomain,
  startManagedDeviceFlow,
  updateManagedRemoteState,
  writeManagedRemoteArtifacts,
} from "./lib/managed-remote.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const bridgeScript = path.join(packageRoot, "scripts", "viveworker-bridge.mjs");
const defaultConfigDir = path.join(os.homedir(), ".viveworker");
const defaultEnvFile = path.join(defaultConfigDir, "config.env");
const defaultStateFile = path.join(defaultConfigDir, "state.json");
const defaultLogDir = path.join(defaultConfigDir, "logs");
const defaultLogFile = path.join(defaultLogDir, "viveworker.log");
const defaultPidFile = path.join(defaultConfigDir, "viveworker.pid");
const defaultLaunchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", "io.viveworker.app.plist");
const defaultLabel = "io.viveworker.app";
const defaultServerPort = 8810;

const cli = parseArgs(process.argv.slice(2));

try {
  await main(cli);
} catch (error) {
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  console.error(error.message || String(error));
  process.exit(1);
}

async function main(cliOptions) {
  switch (cliOptions.command) {
    case "setup":
      await runSetup(cliOptions);
      return;
    case "remote":
      await runRemote(cliOptions);
      return;
    case "start":
      await runStart(cliOptions);
      return;
    case "stop":
      await runStop(cliOptions);
      return;
    case "status":
      await runStatus(cliOptions);
      return;
    case "doctor":
      await runDoctor(cliOptions);
      return;
    case "help":
    default:
      printHelp();
  }
}

async function runSetup(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const stateFile = resolvePath(cliOptions.stateFile || path.join(configDir, "state.json"));
  const logFile = resolvePath(cliOptions.logFile || path.join(configDir, "logs", "viveworker.log"));
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const existing = await maybeReadEnvFile(envFile);
  const locale = await resolveSetupLocale(cliOptions, existing);
  const progress = createCliProgressReporter(locale);
  progress.update("cli.setup.progress.prepare");
  const accessMode = resolveConfiguredAccessMode({ cliOptions, existing });
  if (isLegacyVpnAccessMode(accessMode)) {
    throw new Error("ACCESS_MODE=vpn has been removed. Re-run setup with --access-mode lan, viveworker, or cloudflare.");
  }
  const port = cliOptions.port || Number(existing.NATIVE_APPROVAL_SERVER_PORT) || defaultServerPort;
  const hostname = cliOptions.hostname || existing.VIVEWORKER_HOSTNAME || os.hostname();
  const localHostname = hostname.endsWith(".local") ? hostname : `${hostname}.local`;
  const ips = await findLocalIpv4Addresses();
  const chosenIp = ips[0] || "127.0.0.1";
  const webPushEnabled = resolveSetupWebPushEnabled(cliOptions);
  const existingAccessMode = resolveConfiguredAccessMode({ existing });
  const remoteAccessPublicHostname = accessMode === ACCESS_MODE_CLOUDFLARE
    ? cleanSetupValue(cliOptions.publicHostname || existing.REMOTE_ACCESS_PUBLIC_HOSTNAME).toLowerCase()
    : "";
  const remoteAccessAllowedEmails = accessMode === ACCESS_MODE_CLOUDFLARE
    ? normalizeRemoteAccessAllowedEmails(
        cliOptions.accessAllowEmails || existing.REMOTE_ACCESS_ALLOWED_EMAILS || ""
      )
    : [];
  const cloudflareAccountId = accessMode === ACCESS_MODE_CLOUDFLARE
    ? cleanSetupValue(cliOptions.cloudflareAccountId || existing.CLOUDFLARE_ACCOUNT_ID)
    : "";
  const managedRemoteControlUrl = accessMode === ACCESS_MODE_VIVEWORKER
    ? cleanSetupValue(existing.MANAGED_REMOTE_CONTROL_URL || process.env.MANAGED_REMOTE_CONTROL_URL || DEFAULT_MANAGED_REMOTE_CONTROL_URL)
    : cleanSetupValue(existing.MANAGED_REMOTE_CONTROL_URL || process.env.MANAGED_REMOTE_CONTROL_URL || DEFAULT_MANAGED_REMOTE_CONTROL_URL);
  const lanTlsRequired = accessModeRequiresHttps(accessMode, webPushEnabled);
  const allowInsecureHttpLan =
    accessMode === ACCESS_MODE_LAN
      ? Boolean(cliOptions.allowInsecureHttpLan && !lanTlsRequired)
      : false;
  validateSetupAccessModeOptions({
    cliOptions,
    accessMode,
    remoteAccessPublicHostname,
    cloudflareAccountId,
    remoteAccessAllowedEmails,
  });
  const tlsCertFile = resolvePath(cliOptions.tlsCertFile || existing.TLS_CERT_FILE || path.join(configDir, "tls", "cert.pem"));
  const tlsKeyFile = resolvePath(cliOptions.tlsKeyFile || existing.TLS_KEY_FILE || path.join(configDir, "tls", "key.pem"));
  const publicBaseUrl = buildSetupPublicBaseUrl({
    tlsRequired: lanTlsRequired,
    allowInsecureHttpLan,
    localHostname,
    port,
  });
  const fallbackBaseUrl = buildSetupFallbackBaseUrl({
    publicBaseUrl,
    chosenIp,
    tlsRequired: lanTlsRequired,
    allowInsecureHttpLan,
    port,
  });
  const listenHost = lanTlsRequired || allowInsecureHttpLan
    ? "0.0.0.0"
    : "127.0.0.1";
  const shouldRotatePairingValue = shouldRotatePairing(
    {
      force: cliOptions.pair,
      pairingCode: existing.PAIRING_CODE,
      pairingToken: existing.PAIRING_TOKEN,
      pairingExpiresAtMs: existing.PAIRING_EXPIRES_AT_MS,
    }
  );
  const nextPairing = shouldRotatePairingValue ? generatePairingCredentials() : null;
  const pairCode =
    cliOptions.pairCode ||
    (shouldRotatePairingValue ? nextPairing.pairingCode : existing.PAIRING_CODE) ||
    generatePairingCredentials().pairingCode;
  const pairToken =
    cliOptions.pairToken ||
    (shouldRotatePairingValue ? nextPairing.pairingToken : existing.PAIRING_TOKEN) ||
    generatePairingCredentials().pairingToken;
  const sessionSecret =
    cliOptions.sessionSecret ||
    existing.SESSION_SECRET ||
    crypto.randomBytes(32).toString("hex");
  const deviceTrustTtlMs = Number(existing.DEVICE_TRUST_TTL_MS) || 30 * 24 * 60 * 60 * 1000;
  const pairingExpiresAtMs = shouldRotatePairingValue
    ? nextPairing.pairingExpiresAtMs
    : Number(existing.PAIRING_EXPIRES_AT_MS) || Date.now() + 15 * 60 * 1000;
  const enableNtfy = Boolean(cliOptions.enableNtfy);
  const webPushSubject =
    cliOptions.webPushSubject ||
    existing.WEB_PUSH_SUBJECT ||
    "mailto:viveworker@example.com";
  const vapidKeys = webPushEnabled
    ? await ensureVapidKeys({ cliOptions, existing, progress })
    : null;
  let managedBootstrap = null;
  if (!cliOptions.pair && accessMode === ACCESS_MODE_VIVEWORKER) {
    progress.update("cli.setup.progress.remoteBootstrap");
    const flow = await startManagedDeviceFlow({
      controlUrl: managedRemoteControlUrl || DEFAULT_MANAGED_REMOTE_CONTROL_URL,
      machineName: hostname,
      locale,
    });
    console.log("");
    console.log(`Managed remote login: ${flow.verifyUrl}`);
    if (process.platform === "darwin") {
      await execCommand(["open", flow.verifyUrl], { ignoreError: true });
    }
    const approved = await pollManagedDeviceFlow({
      controlUrl: managedRemoteControlUrl || DEFAULT_MANAGED_REMOTE_CONTROL_URL,
      flowId: flow.flowId,
    });
    const managedPaths = await writeManagedRemoteArtifacts({
      configDir,
      installationId: approved.installation.installationId,
      subdomain: approved.installation.subdomain,
      publicUrl: approved.installation.publicUrl,
      controlUrl: approved.controlUrl || managedRemoteControlUrl || DEFAULT_MANAGED_REMOTE_CONTROL_URL,
      email: approved.installation.email || "",
      agentToken: approved.agentToken,
    });
    managedBootstrap = {
      installationId: approved.installation.installationId,
      subdomain: approved.installation.subdomain,
      publicUrl: approved.installation.publicUrl,
      controlUrl: approved.controlUrl || managedRemoteControlUrl || DEFAULT_MANAGED_REMOTE_CONTROL_URL,
      email: approved.installation.email || "",
      agentToken: approved.agentToken,
      paths: managedPaths,
      enabled: truthyString(existing.REMOTE_ACCESS_ENABLED),
      expiresAtMs: Number(existing.REMOTE_ACCESS_EXPIRES_AT_MS) || 0,
    };
  }
  let remoteBootstrap = null;
  if (!cliOptions.pair && accessMode === ACCESS_MODE_CLOUDFLARE) {
    progress.update("cli.setup.progress.remoteBootstrap");
    if (!cleanRemoteText(process.env.CLOUDFLARE_API_TOKEN || "")) {
      throw new Error("CLOUDFLARE_API_TOKEN is required when ACCESS_MODE=cloudflare.");
    }
    const cloudflaredInstall = await ensureCloudflaredInstalled({
      installIfMissing: true,
      streamOutput: true,
    });
    const upstreamUrl = buildCloudflareUpstreamUrl(publicBaseUrl);
    const reconciled = await reconcileCloudflareRemoteAccess({
      apiToken: process.env.CLOUDFLARE_API_TOKEN || "",
      accountId: cloudflareAccountId,
      publicHostname: remoteAccessPublicHostname,
      allowedEmails: remoteAccessAllowedEmails,
      zoneId: existing.CLOUDFLARE_ZONE_ID || "",
      tunnelId: existing.CLOUDFLARE_TUNNEL_ID || "",
      tunnelName: existing.CLOUDFLARE_TUNNEL_NAME || defaultCloudflareTunnelName(remoteAccessPublicHostname),
      accessAppId: existing.CLOUDFLARE_ACCESS_APP_ID || "",
      accessPolicyId: existing.CLOUDFLARE_ACCESS_POLICY_ID || "",
      upstreamUrl,
    });
    const paths = await writeCloudflareTunnelAssets({
      configDir,
      accountId: cloudflareAccountId,
      zoneId: reconciled.zoneId,
      tunnelId: reconciled.tunnelId,
      tunnelName: reconciled.tunnelName,
      publicHostname: remoteAccessPublicHostname,
      allowedEmails: remoteAccessAllowedEmails,
      upstreamUrl,
      tunnelToken: reconciled.tunnelToken,
    });
    remoteBootstrap = {
      ...reconciled,
      cloudflaredPath: cloudflaredInstall.cloudflaredPath,
      paths,
      enabled: truthyString(existing.REMOTE_ACCESS_ENABLED),
      expiresAtMs: Number(existing.REMOTE_ACCESS_EXPIRES_AT_MS) || 0,
    };
  }
  const tlsAssets = lanTlsRequired
    ? {
        ...(await ensureLanTlsAssets({
          cliOptions,
          existing,
          hostname,
          localHostname,
          locale,
          progress,
          chosenIp,
          tlsCertFile,
          tlsKeyFile,
        })),
        vapidPublicKey: vapidKeys?.publicKey || "",
        vapidPrivateKey: vapidKeys?.privateKey || "",
      }
    : null;
  const cloudflared = accessMode === ACCESS_MODE_CLOUDFLARE
    ? await detectCloudflaredInstallation()
    : null;

  progress.update("cli.setup.progress.writeConfig");
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const preserveRemoteRuntimeState =
    accessModeHasRemoteOverlay(accessMode) &&
    existingAccessMode === accessMode &&
    (
      accessMode === ACCESS_MODE_CLOUDFLARE
        ? cleanSetupValue(existing.REMOTE_ACCESS_PUBLIC_HOSTNAME).toLowerCase() === remoteAccessPublicHostname &&
          cleanSetupValue(existing.CLOUDFLARE_ACCOUNT_ID) === cloudflareAccountId
        : cleanSetupValue(existing.MANAGED_REMOTE_INSTALLATION_ID) === cleanSetupValue(managedBootstrap?.installationId || existing.MANAGED_REMOTE_INSTALLATION_ID) &&
          cleanSetupValue(existing.MANAGED_REMOTE_PUBLIC_URL) === cleanSetupValue(managedBootstrap?.publicUrl || existing.MANAGED_REMOTE_PUBLIC_URL)
    );
  const remoteAccessEnabled = accessModeHasRemoteOverlay(accessMode)
    ? preserveRemoteRuntimeState && truthyString(existing.REMOTE_ACCESS_ENABLED)
    : false;
  const remoteAccessExpiresAtMs = accessModeHasRemoteOverlay(accessMode) && preserveRemoteRuntimeState
    ? Number(existing.REMOTE_ACCESS_EXPIRES_AT_MS) || 0
    : 0;
  const cloudflarePaths = accessMode === ACCESS_MODE_CLOUDFLARE
    ? (remoteBootstrap?.paths || resolveCloudflareAssetPaths(configDir))
    : null;
  const managedPaths = accessMode === ACCESS_MODE_VIVEWORKER
    ? (managedBootstrap?.paths || resolveManagedRemoteAssetPaths(configDir))
    : null;

  const envLines = [
    `WEB_UI_ENABLED=1`,
    `AUTH_REQUIRED=1`,
    `ACCESS_MODE=${accessMode}`,
    `VIVEWORKER_HOSTNAME=${hostname}`,
    `CODEX_HOME=${existing.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")}`,
    `STATE_FILE=${stateFile}`,
    `NATIVE_APPROVAL_SERVER_HOST=${listenHost}`,
    `NATIVE_APPROVAL_SERVER_PORT=${port}`,
    `NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL=${publicBaseUrl}`,
    `SESSION_SECRET=${sessionSecret}`,
    `DEVICE_TRUST_TTL_MS=${deviceTrustTtlMs}`,
    `DEFAULT_LOCALE=${locale}`,
    `WEB_PUSH_ENABLED=${webPushEnabled ? 1 : 0}`,
    `ALLOW_INSECURE_LAN_HTTP=${allowInsecureHttpLan ? 1 : 0}`,
    lanTlsRequired ? `TLS_CERT_FILE=${tlsAssets.certFile}` : null,
    lanTlsRequired ? `TLS_KEY_FILE=${tlsAssets.keyFile}` : null,
    webPushEnabled ? `WEB_PUSH_VAPID_PUBLIC_KEY=${tlsAssets.vapidPublicKey}` : null,
    webPushEnabled ? `WEB_PUSH_VAPID_PRIVATE_KEY=${tlsAssets.vapidPrivateKey}` : null,
    webPushEnabled ? `WEB_PUSH_SUBJECT=${webPushSubject}` : null,
    accessModeHasRemoteOverlay(accessMode) ? `REMOTE_ACCESS_ENABLED=${remoteAccessEnabled ? 1 : 0}` : null,
    accessModeHasRemoteOverlay(accessMode) ? `REMOTE_ACCESS_EXPIRES_AT_MS=${remoteAccessExpiresAtMs}` : null,
    accessMode === ACCESS_MODE_CLOUDFLARE ? `REMOTE_ACCESS_PUBLIC_HOSTNAME=${remoteAccessPublicHostname}` : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `REMOTE_ACCESS_ALLOWED_EMAILS=${remoteAccessAllowedEmails.join(",")}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE ? `CLOUDFLARE_ACCOUNT_ID=${cloudflareAccountId}` : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_ZONE_ID=${remoteBootstrap?.zoneId || existing.CLOUDFLARE_ZONE_ID || ""}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_TUNNEL_ID=${remoteBootstrap?.tunnelId || existing.CLOUDFLARE_TUNNEL_ID || ""}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_TUNNEL_NAME=${remoteBootstrap?.tunnelName || existing.CLOUDFLARE_TUNNEL_NAME || defaultCloudflareTunnelName(remoteAccessPublicHostname)}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_TUNNEL_CREDENTIALS_FILE=${cloudflarePaths.credentialsFile}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_TUNNEL_CONFIG_FILE=${cloudflarePaths.configFile}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_ACCESS_APP_ID=${remoteBootstrap?.accessAppId || existing.CLOUDFLARE_ACCESS_APP_ID || ""}`
      : null,
    accessMode === ACCESS_MODE_CLOUDFLARE
      ? `CLOUDFLARE_ACCESS_POLICY_ID=${remoteBootstrap?.accessPolicyId || existing.CLOUDFLARE_ACCESS_POLICY_ID || ""}`
      : null,
    accessMode === ACCESS_MODE_VIVEWORKER
      ? `MANAGED_REMOTE_INSTALLATION_ID=${managedBootstrap?.installationId || existing.MANAGED_REMOTE_INSTALLATION_ID || ""}`
      : null,
    accessMode === ACCESS_MODE_VIVEWORKER
      ? `MANAGED_REMOTE_SUBDOMAIN=${managedBootstrap?.subdomain || existing.MANAGED_REMOTE_SUBDOMAIN || ""}`
      : null,
    accessMode === ACCESS_MODE_VIVEWORKER
      ? `MANAGED_REMOTE_PUBLIC_URL=${managedBootstrap?.publicUrl || existing.MANAGED_REMOTE_PUBLIC_URL || ""}`
      : null,
    accessMode === ACCESS_MODE_VIVEWORKER
      ? `MANAGED_REMOTE_CONTROL_URL=${managedBootstrap?.controlUrl || existing.MANAGED_REMOTE_CONTROL_URL || managedRemoteControlUrl || DEFAULT_MANAGED_REMOTE_CONTROL_URL}`
      : null,
    accessMode === ACCESS_MODE_VIVEWORKER
      ? `MANAGED_REMOTE_SECRET_FILE=${managedPaths.secretFile}`
      : null,
    `PAIRING_CODE=${pairCode}`,
    `PAIRING_TOKEN=${pairToken}`,
    `PAIRING_EXPIRES_AT_MS=${pairingExpiresAtMs}`,
    `CHOICE_PAGE_SIZE=5`,
    `MAX_HISTORY_ITEMS=100`,
    `NATIVE_APPROVALS=1`,
    `NOTIFY_APPROVALS=${enableNtfy ? 1 : 0}`,
    `NOTIFY_PLANS=${enableNtfy ? 1 : 0}`,
    `NOTIFY_COMPLETIONS=${enableNtfy ? 1 : 0}`,
    `ENABLE_NTFY=${enableNtfy ? 1 : 0}`,
    enableNtfy && existing.NTFY_BASE_URL ? `NTFY_BASE_URL=${existing.NTFY_BASE_URL}` : null,
    enableNtfy && existing.NTFY_PUBLISH_BASE_URL ? `NTFY_PUBLISH_BASE_URL=${existing.NTFY_PUBLISH_BASE_URL}` : null,
    enableNtfy && existing.NTFY_TOPIC ? `NTFY_TOPIC=${existing.NTFY_TOPIC}` : null,
    enableNtfy && existing.NTFY_ACCESS_TOKEN ? `NTFY_ACCESS_TOKEN=${existing.NTFY_ACCESS_TOKEN}` : null,
  ].filter(Boolean);

  await fs.writeFile(envFile, `${envLines.join("\n")}\n`, "utf8");

  if (accessMode === ACCESS_MODE_CLOUDFLARE && cloudflared?.cloudflaredPath && cloudflarePaths) {
    await fs.mkdir(path.dirname(DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH), { recursive: true });
    await fs.mkdir(path.dirname(cloudflarePaths.logFile), { recursive: true });
    await fs.writeFile(
      DEFAULT_CLOUDFLARED_LAUNCH_AGENT_PATH,
      buildCloudflaredLaunchAgentPlist({
        label: DEFAULT_CLOUDFLARED_LABEL,
        cloudflaredPath: cloudflared.cloudflaredPath,
        credentialsFile: cloudflarePaths.credentialsFile,
        logFile: cloudflarePaths.logFile,
      }),
      "utf8"
    );
  }

  if (!cliOptions.noLaunchd) {
    progress.update("cli.setup.progress.launchd");
    const plist = buildLaunchAgentPlist({
      label: defaultLabel,
      nodePath: process.execPath,
      bridgeScript,
      envFile,
      logFile,
    });
    await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
    await fs.writeFile(launchAgentPath, plist, "utf8");
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath]);
    await execCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${defaultLabel}`]);
  } else {
    progress.update("cli.setup.progress.startBridge");
    await startDetachedBridge({ envFile, logFile, pidFile });
  }

  progress.update("cli.setup.progress.health");
  const healthy = await waitForHealth(buildLoopbackHealthUrl(publicBaseUrl));
  const pairingReady = healthy
    ? await waitForExpectedPairing(publicBaseUrl, pairToken)
    : false;
  if (accessMode === ACCESS_MODE_CLOUDFLARE && cloudflarePaths) {
    if (remoteAccessActive({
      accessMode,
      remoteAccessPublicHostname,
      cloudflareAccountId,
      cloudflareZoneId: remoteBootstrap?.zoneId || existing.CLOUDFLARE_ZONE_ID || "",
      cloudflareTunnelId: remoteBootstrap?.tunnelId || existing.CLOUDFLARE_TUNNEL_ID || "",
      cloudflareAccessAppId: remoteBootstrap?.accessAppId || existing.CLOUDFLARE_ACCESS_APP_ID || "",
      cloudflareAccessPolicyId: remoteBootstrap?.accessPolicyId || existing.CLOUDFLARE_ACCESS_POLICY_ID || "",
      cloudflareTunnelCredentialsFile: cloudflarePaths.credentialsFile,
      cloudflareTunnelConfigFile: cloudflarePaths.configFile,
      remoteAccessEnabled,
      remoteAccessExpiresAtMs,
    })) {
      await startCloudflaredLaunchAgent();
    } else {
      await stopCloudflaredLaunchAgent();
    }
  }
  progress.done(healthy && pairingReady ? "cli.setup.complete" : "cli.setup.completePending");
  if (healthy && !pairingReady) {
    console.log("");
    console.log(t(locale, "cli.setup.warning.stalePairingServer", { port }));
  }

  const pairPath = `/app?pairToken=${encodeURIComponent(pairToken)}`;
  const mkcertRootCaFile = resolvePath(
    existing.MKCERT_ROOT_CA_FILE || process.env.MKCERT_ROOT_CA_FILE || "~/Library/Application Support/mkcert/rootCA.pem"
  );
  const canShowCaDownload = lanTlsRequired && await fileExists(mkcertRootCaFile);
  const caPath = "/ca/rootCA.pem";
  let caDownloadLocalUrl = `${publicBaseUrl}${caPath}`;
  let caDownloadIpUrl = `${fallbackBaseUrl}${caPath}`;
  let temporaryCaServer = null;

  if (cliOptions.installMkcert && canShowCaDownload) {
    temporaryCaServer = await startTemporaryCaDownloadServer({
      rootCaFile: mkcertRootCaFile,
      preferredPort: port + 1,
      localHostname,
      fallbackIp: chosenIp,
      pathName: caPath,
    });
    caDownloadLocalUrl = temporaryCaServer.localUrl;
    caDownloadIpUrl = temporaryCaServer.ipUrl;
    console.log("");
    console.log(t(locale, webPushEnabled ? "cli.setup.webPushEnabled" : "cli.setup.webPushDisabled"));
    console.log(t(locale, "cli.setup.caFlow.title"));
    console.log(t(locale, "cli.setup.caDownloadLocal", { url: caDownloadLocalUrl }));
    console.log(t(locale, "cli.setup.caDownloadIp", { url: caDownloadIpUrl }));
    console.log("");
    console.log(t(locale, "cli.setup.caFlow.step1"));
    console.log(t(locale, "cli.setup.caFlow.step2"));
    console.log(t(locale, "cli.setup.caFlow.step3"));
    console.log("");
    console.log(t(locale, "cli.setup.qrCaDownload"));
    await printQrCode(caDownloadIpUrl);
    try {
      await waitForEnter(locale, "cli.setup.prompt.continueToApp");
    } finally {
      await temporaryCaServer.close();
      temporaryCaServer = null;
    }
  }

  console.log("");
  if (cliOptions.pair) {
    console.log(t(locale, "cli.setup.pairRefresh.title"));
    console.log(t(locale, "cli.setup.pairRefresh.copy"));
    console.log(t(locale, "cli.setup.pairRefresh.reminder"));
    console.log("");
  }
  const accessModeLabelKey =
    accessMode === ACCESS_MODE_VIVEWORKER
      ? "cli.accessMode.viveworker"
      : accessMode === ACCESS_MODE_CLOUDFLARE
        ? "cli.accessMode.cloudflare"
        : "cli.accessMode.lan";
  console.log(t(locale, "cli.setup.accessMode", { value: t(locale, accessModeLabelKey) }));
  console.log(t(locale, "cli.setup.primaryUrl", { url: publicBaseUrl }));
  console.log(t(locale, "cli.setup.fallbackUrl", { url: fallbackBaseUrl }));
  console.log(t(locale, "cli.setup.pairingCode", { code: pairCode }));
  console.log(t(locale, "cli.setup.pairingUrlLocal", { url: `${publicBaseUrl}${pairPath}` }));
  console.log(t(locale, "cli.setup.pairingUrlIp", { url: `${fallbackBaseUrl}${pairPath}` }));
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    console.log(t(locale, "cli.setup.remoteAccessProvider", { value: "Cloudflare Zero Trust" }));
    console.log(t(locale, "cli.setup.remoteAccessPublicUrl", { url: buildRemotePublicUrl(remoteAccessPublicHostname) }));
    console.log(t(locale, "cli.setup.remoteAccessStatus", {
      value: t(
        locale,
        remoteAccessEnabled && !remoteAccessExpired({ remoteAccessExpiresAtMs })
          ? "cli.status.enabled"
          : "cli.status.disabled"
      ),
    }));
  } else if (accessMode === ACCESS_MODE_VIVEWORKER) {
    console.log(t(locale, "cli.setup.remoteAccessProvider", { value: "viveworker managed relay" }));
    console.log(t(locale, "cli.setup.remoteAccessPublicUrl", {
      url: managedBootstrap?.publicUrl || existing.MANAGED_REMOTE_PUBLIC_URL || "",
    }));
    console.log(t(locale, "cli.setup.remoteAccessStatus", {
      value: t(
        locale,
        remoteAccessEnabled && !remoteAccessExpired({ remoteAccessExpiresAtMs })
          ? "cli.status.enabled"
          : "cli.status.disabled"
      ),
    }));
  }
  console.log(t(locale, webPushEnabled ? "cli.setup.webPushEnabled" : "cli.setup.webPushDisabled"));
  if (allowInsecureHttpLan) {
    console.log(t(locale, "cli.setup.warning.insecureHttpLan"));
  }
  if (canShowCaDownload && !cliOptions.installMkcert && !cliOptions.pair) {
    console.log(t(locale, "cli.setup.caDownloadLocal", { url: caDownloadLocalUrl }));
    console.log(t(locale, "cli.setup.caDownloadIp", { url: caDownloadIpUrl }));
  }
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    console.log(t(locale, "cli.setup.remoteAccessDisabledByDefault"));
    console.log(t(locale, "cli.setup.remoteAccessIphoneToggle"));
    console.log(t(locale, "cli.setup.remoteAccessAllowEmails", { value: remoteAccessAllowedEmails.join(", ") || "-" }));
  } else if (accessMode === ACCESS_MODE_VIVEWORKER) {
    console.log(t(locale, "cli.setup.remoteAccessDisabledByDefault"));
    console.log(t(locale, "cli.setup.remoteAccessIphoneToggle"));
  }
  console.log("");
  if (lanTlsRequired) {
    console.log(t(locale, cliOptions.installMkcert ? "cli.setup.instructions.afterCa" : "cli.setup.instructions.https"));
  } else if (allowInsecureHttpLan) {
    console.log(t(locale, "cli.setup.instructions.insecureHttpLan"));
  } else {
    console.log(t(locale, "cli.setup.instructions.localOnlyHttp"));
  }
  console.log("");
  console.log(t(locale, "cli.setup.qrPairing"));
  await printQrCode(`${publicBaseUrl}${pairPath}`);
  if (canShowCaDownload && !cliOptions.installMkcert && !cliOptions.pair) {
    console.log("");
    console.log(t(locale, "cli.setup.qrCaDownload"));
    await printQrCode(caDownloadIpUrl);
  }
}

async function runStart(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const initialLocale = await resolveCliLocale(cliOptions);
  const progress = createCliProgressReporter(initialLocale);
  progress.update("cli.start.progress.prepare");
  let config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const locale = await resolveCliLocale(cliOptions, config);
  progress.setLocale(locale);
  const rotatedPairing = await maybeRotateStartupPairing(envFile, config);
  if (rotatedPairing.rotated) {
    progress.update("cli.start.progress.refreshPairing");
    config = {
      ...config,
      PAIRING_CODE: rotatedPairing.pairingCode,
      PAIRING_TOKEN: rotatedPairing.pairingToken,
      PAIRING_EXPIRES_AT_MS: String(rotatedPairing.pairingExpiresAtMs),
    };
  }
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const healthUrl = buildLoopbackHealthUrl(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "");
  const remoteInfo = buildCliRemoteAccessInfo(config);
  if (await fileExists(launchAgentPath)) {
    progress.update("cli.start.progress.launchd");
    await execCommand(["launchctl", "bootstrap", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    progress.update("cli.start.progress.kickstart");
    await execCommand(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/${defaultLabel}`]);
    progress.update("cli.start.progress.health");
    const healthy = await waitForHealth(healthUrl);
    const pairingReady = healthy && rotatedPairing.rotated
      ? await waitForExpectedPairing(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "", rotatedPairing.pairingToken)
      : true;
    if (remoteInfo.configured) {
      if (remoteInfo.active) {
        await startCloudflaredLaunchAgent();
      } else {
        await stopCloudflaredLaunchAgent();
      }
    }
    progress.done(healthy && pairingReady ? "cli.start.launchdStarted" : "cli.start.launchdStartedPending");
    if (healthy && !pairingReady) {
      console.log("");
      console.log(t(locale, "cli.setup.warning.stalePairingServer", { port: config.NATIVE_APPROVAL_SERVER_PORT || defaultServerPort }));
    }
    if (rotatedPairing.rotated) {
      await printPairingInfo(locale, config);
    }
    return;
  }

  progress.update("cli.start.progress.bridge");
  await startDetachedBridge({
    envFile,
    logFile: resolvePath(cliOptions.logFile || defaultLogFile),
    pidFile,
  });
  progress.update("cli.start.progress.health");
  const healthy = await waitForHealth(healthUrl);
  const pairingReady = healthy && rotatedPairing.rotated
    ? await waitForExpectedPairing(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "", rotatedPairing.pairingToken)
    : true;
  if (remoteInfo.configured) {
    if (remoteInfo.active) {
      await startCloudflaredLaunchAgent();
    } else {
      await stopCloudflaredLaunchAgent();
    }
  }
  progress.done(healthy && pairingReady ? "cli.start.bridgeStarted" : "cli.start.bridgeStartedPending");
  if (healthy && !pairingReady) {
    console.log("");
    console.log(t(locale, "cli.setup.warning.stalePairingServer", { port: config.NATIVE_APPROVAL_SERVER_PORT || defaultServerPort }));
  }
  if (rotatedPairing.rotated) {
    await printPairingInfo(locale, config);
  }
}

async function runStop(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const config = await maybeReadEnvFile(envFile);
  const remoteInfo = buildCliRemoteAccessInfo(config);
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  if (remoteInfo.configured) {
    await stopCloudflaredLaunchAgent();
  }
  if (await fileExists(launchAgentPath)) {
    await execCommand(["launchctl", "bootout", `gui/${process.getuid()}`, launchAgentPath], { ignoreError: true });
    console.log(t(await resolveCliLocale(cliOptions), "cli.stop.launchdStopped"));
    return;
  }

  const pid = await maybeReadPid(pidFile);
  if (!pid) {
    console.log(t(await resolveCliLocale(cliOptions), "cli.stop.noProcess"));
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  await fs.rm(pidFile, { force: true });
  console.log(t(await resolveCliLocale(cliOptions), "cli.stop.stopped", { pid }));
}

async function runStatus(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const accessMode = resolveConfiguredAccessMode({ existing: config });
  if (isLegacyVpnAccessMode(accessMode)) {
    throw new Error("ACCESS_MODE=vpn is no longer supported. Re-run setup with --access-mode lan, viveworker, or cloudflare.");
  }
  const baseUrl = config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "";
  const healthUrl = buildLoopbackHealthUrl(baseUrl);
  const launchAgentPath = resolvePath(cliOptions.launchAgentPath || defaultLaunchAgentPath);
  const pidFile = resolvePath(cliOptions.pidFile || path.join(configDir, "viveworker.pid"));
  const webPushEnabled = truthyString(config.WEB_PUSH_ENABLED);
  const httpsEnabled = isHttpsUrl(baseUrl);
  const remoteInfo = buildCliRemoteAccessInfo(config);
  const tlsActive = accessModeRequiresHttps(accessMode, webPushEnabled) || remoteInfo.configured;
  const locale = await resolveCliLocale(cliOptions, config);
  const cloudflared = accessMode === ACCESS_MODE_CLOUDFLARE
    ? await detectCloudflaredInstallation()
    : null;
  const cloudflaredStatus = accessMode === ACCESS_MODE_CLOUDFLARE
    ? await cloudflaredLaunchAgentStatus()
    : null;
  const managedSecrets = accessMode === ACCESS_MODE_VIVEWORKER
    ? await readManagedRemoteSecrets(config.MANAGED_REMOTE_SECRET_FILE || "")
    : null;

  console.log(t(locale, "cli.status.accessMode", { value: t(locale, `cli.accessMode.${accessMode}`) }));
  console.log(t(locale, "cli.status.envFile", { value: envFile }));
  console.log(t(locale, "cli.status.baseUrl", { value: baseUrl || "(not configured)" }));
  if (accessModeHasRemoteOverlay(accessMode)) {
    console.log(
      t(locale, "cli.status.remoteConfigured", {
        value: t(locale, remoteInfo.configured ? "cli.status.enabled" : "cli.status.disabled"),
      })
    );
    console.log(t(locale, "cli.status.remoteUrl", { value: remoteInfo.publicUrl || "(not configured)" }));
    console.log(
      t(locale, "cli.status.remoteEnabled", {
        value: t(
          locale,
          remoteInfo.active
            ? "cli.status.enabled"
            : remoteInfo.expired
              ? "cli.status.expired"
              : "cli.status.disabled"
        ),
      })
    );
    console.log(
      t(locale, "cli.status.remoteExpiresAt", {
        value: formatStatusTimestamp(remoteInfo.expiresAtMs),
      })
    );
    if (accessMode === ACCESS_MODE_CLOUDFLARE) {
      console.log(
        t(locale, "cli.status.cloudflared", {
          value: t(locale, cloudflared?.detected ? "cli.status.detected" : "cli.status.missing"),
        })
      );
      console.log(
        t(locale, "cli.status.cloudflaredLaunchd", {
          value: t(
            locale,
            cloudflaredStatus?.running
              ? "cli.status.running"
              : cloudflaredStatus?.installed
                ? "cli.status.installed"
                : "cli.status.notRunning"
          ),
        })
      );
    } else if (accessMode === ACCESS_MODE_VIVEWORKER) {
      console.log(t(locale, "cli.status.remoteControlUrl", { value: config.MANAGED_REMOTE_CONTROL_URL || "(not configured)" }));
      console.log(t(locale, "cli.status.remoteSecretFile", { value: config.MANAGED_REMOTE_SECRET_FILE || "(missing)" }));
      console.log(
        t(locale, "cli.status.remoteAgent", {
          value: t(locale, managedSecrets?.agentToken ? "cli.status.detected" : "cli.status.missing"),
        })
      );
    }
  }
  console.log(t(locale, "cli.status.webPush", { value: t(locale, webPushEnabled ? "cli.status.enabled" : "cli.status.disabled") }));
  console.log(t(locale, "cli.status.https", { value: t(locale, httpsEnabled ? "cli.status.enabled" : "cli.status.disabled") }));
  if (tlsActive) {
    console.log(t(locale, "cli.status.tlsCert", { value: config.TLS_CERT_FILE || "(missing)" }));
    console.log(t(locale, "cli.status.tlsKey", { value: config.TLS_KEY_FILE || "(missing)" }));
  }
  console.log(
    t(locale, "cli.status.launchAgent", {
      value: (await fileExists(launchAgentPath)) ? launchAgentPath : "(not installed)",
    })
  );

  if (await fileExists(launchAgentPath)) {
    const printed = await execCommand(
      ["launchctl", "print", `gui/${process.getuid()}/${defaultLabel}`],
      { ignoreError: true }
    );
    console.log(
      t(locale, "cli.status.launchd", {
        value: t(locale, printed.ok ? "cli.status.installed" : "cli.status.notRunning"),
      })
    );
  } else {
    const pid = await maybeReadPid(pidFile);
    console.log(t(locale, "cli.status.pid", { value: pid || "(not running)" }));
  }

  if (healthUrl) {
    const health = await execCommand(buildHealthCheckArgs(healthUrl), { ignoreError: true });
    console.log(t(locale, "cli.status.health", { value: t(locale, health.ok ? "cli.status.ok" : "cli.status.failed") }));
    console.log(t(locale, "cli.status.localProbeUrl", { value: healthUrl }));
    if (health.stdout) {
      console.log(health.stdout.trim());
    }
  }
}

async function runDoctor(cliOptions) {
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const accessMode = resolveConfiguredAccessMode({ existing: config });
  if (isLegacyVpnAccessMode(accessMode)) {
    throw new Error("ACCESS_MODE=vpn is no longer supported. Re-run setup with --access-mode lan, viveworker, or cloudflare.");
  }
  const issues = [];
  const baseUrl = config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "";
  const healthUrl = buildLoopbackHealthUrl(baseUrl);
  const webPushEnabled = truthyString(config.WEB_PUSH_ENABLED);
  const allowInsecureHttpLan = truthyString(config.ALLOW_INSECURE_LAN_HTTP);
  const hostname = config.VIVEWORKER_HOSTNAME || os.hostname();
  const localHostname = hostname.endsWith(".local") ? hostname : `${hostname}.local`;
  const ips = await findLocalIpv4Addresses();
  const chosenIp = ips[0] || "127.0.0.1";
  const locale = await resolveCliLocale(cliOptions, config);
  const remoteInfo = buildCliRemoteAccessInfo(config);
  const tlsActive = accessModeRequiresHttps(accessMode, webPushEnabled) || remoteInfo.configured;
  const cloudflared = accessMode === ACCESS_MODE_CLOUDFLARE
    ? await detectCloudflaredInstallation()
    : null;
  const managedSecrets = accessMode === ACCESS_MODE_VIVEWORKER
    ? await readManagedRemoteSecrets(config.MANAGED_REMOTE_SECRET_FILE || "")
    : null;

  if (!(await fileExists(envFile))) {
    issues.push(t(locale, "cli.doctor.issue.envMissing"));
  }
  if (!config.SESSION_SECRET) {
    issues.push(t(locale, "cli.doctor.issue.sessionSecretMissing"));
  }
  if (!config.PAIRING_CODE || !config.PAIRING_TOKEN) {
    issues.push(t(locale, "cli.doctor.issue.pairingMissing"));
  }
  if (!baseUrl) {
    issues.push(t(locale, "cli.doctor.issue.baseUrlMissing"));
  }
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    if (!remoteInfo.publicHostname) {
      issues.push(t(locale, "cli.doctor.issue.remoteHostnameMissing"));
    }
    if (!config.CLOUDFLARE_ACCOUNT_ID) {
      issues.push(t(locale, "cli.doctor.issue.cloudflareAccountIdMissing"));
    }
    if (!(normalizeRemoteAccessAllowedEmails(config.REMOTE_ACCESS_ALLOWED_EMAILS).length > 0)) {
      issues.push(t(locale, "cli.doctor.issue.remoteAllowedEmailsMissing"));
    }
    if (!isHttpsUrl(baseUrl)) {
      issues.push(t(locale, "cli.doctor.issue.remoteRequiresHttps"));
    }
    if (!config.CLOUDFLARE_TUNNEL_CREDENTIALS_FILE || !(await fileExists(resolvePath(config.CLOUDFLARE_TUNNEL_CREDENTIALS_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.cloudflareCredentialsMissing"));
    }
    if (!config.CLOUDFLARE_TUNNEL_CONFIG_FILE || !(await fileExists(resolvePath(config.CLOUDFLARE_TUNNEL_CONFIG_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.cloudflareConfigMissing"));
    }
    if (!cloudflared?.detected) {
      issues.push(t(locale, "cli.doctor.issue.cloudflaredMissing"));
    }
  } else if (accessMode === ACCESS_MODE_VIVEWORKER) {
    if (!config.MANAGED_REMOTE_INSTALLATION_ID) {
      issues.push(t(locale, "cli.doctor.issue.managedRemoteInstallationMissing"));
    }
    if (!config.MANAGED_REMOTE_PUBLIC_URL) {
      issues.push(t(locale, "cli.doctor.issue.managedRemotePublicUrlMissing"));
    }
    if (!config.MANAGED_REMOTE_CONTROL_URL) {
      issues.push(t(locale, "cli.doctor.issue.managedRemoteControlUrlMissing"));
    }
    if (!config.MANAGED_REMOTE_SECRET_FILE || !(await fileExists(resolvePath(config.MANAGED_REMOTE_SECRET_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.managedRemoteSecretFileMissing"));
    }
    if (!managedSecrets?.agentToken) {
      issues.push(t(locale, "cli.doctor.issue.managedRemoteAgentMissing"));
    }
    if (!isHttpsUrl(baseUrl)) {
      issues.push(t(locale, "cli.doctor.issue.remoteRequiresHttps"));
    }
  }
  if (baseUrl && accessMode === ACCESS_MODE_LAN && !isHttpsUrl(baseUrl) && !isLoopbackBaseUrl(baseUrl) && !allowInsecureHttpLan) {
    issues.push(t(locale, "cli.doctor.issue.lanHttpRequiresOverride"));
  }
  if (tlsActive) {
    if (webPushEnabled && !isHttpsUrl(baseUrl)) {
      issues.push(t(locale, "cli.doctor.issue.webPushHttps"));
    }
    if (!config.TLS_CERT_FILE || !(await fileExists(resolvePath(config.TLS_CERT_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.tlsCertMissing"));
    }
    if (!config.TLS_KEY_FILE || !(await fileExists(resolvePath(config.TLS_KEY_FILE)))) {
      issues.push(t(locale, "cli.doctor.issue.tlsKeyMissing"));
    }
  }
  if (webPushEnabled) {
    if (!config.WEB_PUSH_VAPID_PUBLIC_KEY) {
      issues.push(t(locale, "cli.doctor.issue.vapidPublicMissing"));
    }
    if (!config.WEB_PUSH_VAPID_PRIVATE_KEY) {
      issues.push(t(locale, "cli.doctor.issue.vapidPrivateMissing"));
    }

    if (config.TLS_CERT_FILE && await fileExists(resolvePath(config.TLS_CERT_FILE))) {
      const certificateIssues = await checkCertificateHosts({
        certFile: resolvePath(config.TLS_CERT_FILE),
        expectedHosts: collectTlsHosts({
          hostname,
          localHostname,
          chosenIp,
        }),
      });
      issues.push(...certificateIssues);
    }
  }
  if (healthUrl) {
    const health = await execCommand(buildHealthCheckArgs(healthUrl), { ignoreError: true });
    if (!health.ok) {
      issues.push(t(locale, tlsActive ? "cli.doctor.issue.healthHttps" : "cli.doctor.issue.health"));
    }
  }
  if (accessMode === ACCESS_MODE_CLOUDFLARE && cleanRemoteText(process.env.CLOUDFLARE_API_TOKEN || "")) {
    const remoteIssues = await verifyCloudflareRemoteAccess({
      apiToken: process.env.CLOUDFLARE_API_TOKEN || "",
      accountId: config.CLOUDFLARE_ACCOUNT_ID || "",
      zoneId: config.CLOUDFLARE_ZONE_ID || "",
      tunnelId: config.CLOUDFLARE_TUNNEL_ID || "",
      publicHostname: config.REMOTE_ACCESS_PUBLIC_HOSTNAME || "",
      accessAppId: config.CLOUDFLARE_ACCESS_APP_ID || "",
      accessPolicyId: config.CLOUDFLARE_ACCESS_POLICY_ID || "",
    });
    issues.push(...remoteIssues);
  }

  if (issues.length === 0) {
    console.log(t(locale, "cli.doctor.ok"));
    if (accessMode === ACCESS_MODE_CLOUDFLARE) {
      console.log(t(locale, "cli.doctor.remoteLocalOnlyNote"));
    }
    return;
  }

  console.log(t(locale, "cli.doctor.foundIssues"));
  for (const issue of issues) {
    console.log(`- ${issue}`);
  }
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    if (!cleanRemoteText(process.env.CLOUDFLARE_API_TOKEN || "")) {
      console.log(`- ${t(locale, "cli.doctor.remoteLocalOnlyNote")}`);
    }
  }
}

async function runRemote(cliOptions) {
  if (cliOptions.subcommand !== "rotate") {
    throw new Error("Supported remote command: viveworker remote rotate");
  }
  const configDir = resolvePath(cliOptions.configDir || defaultConfigDir);
  const envFile = resolvePath(cliOptions.envFile || path.join(configDir, "config.env"));
  const config = await ensureDefaultLocalePersisted(envFile, cliOptions);
  const accessMode = resolveConfiguredAccessMode({ existing: config });
  if (accessMode !== ACCESS_MODE_VIVEWORKER) {
    throw new Error("viveworker remote rotate is only available with ACCESS_MODE=viveworker.");
  }
  const secretFile = resolvePath(config.MANAGED_REMOTE_SECRET_FILE || "");
  const secrets = await readManagedRemoteSecrets(secretFile);
  if (!secrets?.agentToken || !config.MANAGED_REMOTE_INSTALLATION_ID) {
    throw new Error("Managed remote secret file or installation ID is missing.");
  }
  const rotated = await rotateManagedRemoteSubdomain({
    controlUrl: config.MANAGED_REMOTE_CONTROL_URL || DEFAULT_MANAGED_REMOTE_CONTROL_URL,
    installationId: config.MANAGED_REMOTE_INSTALLATION_ID,
    agentToken: secrets.agentToken,
  });
  const paths = await writeManagedRemoteArtifacts({
    configDir,
    installationId: rotated.installationId,
    subdomain: rotated.subdomain,
    publicUrl: rotated.publicUrl,
    controlUrl: config.MANAGED_REMOTE_CONTROL_URL || DEFAULT_MANAGED_REMOTE_CONTROL_URL,
    email: config.MANAGED_REMOTE_EMAIL || "",
    agentToken: rotated.agentToken,
  });
  const currentText = await maybeReadText(envFile);
  const nextText = upsertEnvText(currentText, {
    MANAGED_REMOTE_INSTALLATION_ID: rotated.installationId,
    MANAGED_REMOTE_SUBDOMAIN: rotated.subdomain,
    MANAGED_REMOTE_PUBLIC_URL: rotated.publicUrl,
    MANAGED_REMOTE_SECRET_FILE: paths.secretFile,
    REMOTE_ACCESS_ENABLED: "0",
    REMOTE_ACCESS_EXPIRES_AT_MS: "0",
  });
  await fs.writeFile(envFile, nextText, "utf8");
  console.log(`Managed remote URL rotated: ${rotated.publicUrl}`);
}

function parseArgs(argv) {
  const parsed = {
    command: "help",
    subcommand: "",
    accessMode: ACCESS_MODE_LAN,
    enableNtfy: false,
    enableWebPush: false,
    disableWebPush: false,
    allowInsecureHttpLan: false,
    installMkcert: false,
    noLaunchd: false,
    pair: false,
    port: null,
    hostname: "",
    envFile: "",
    configDir: "",
    stateFile: "",
    logFile: "",
    pidFile: "",
    launchAgentPath: "",
    pairCode: "",
    pairToken: "",
    sessionSecret: "",
    tlsCertFile: "",
    tlsKeyFile: "",
    webPushSubject: "",
    vapidPublicKey: "",
    vapidPrivateKey: "",
    locale: "",
    mkcertTrustStores: "",
    publicHostname: "",
    cloudflareAccountId: "",
    accessAllowEmails: "",
  };

  if (argv[0] && !argv[0].startsWith("-")) {
    parsed.command = argv[0];
    argv = argv.slice(1);
    if (parsed.command === "remote" && argv[0] && !argv[0].startsWith("-")) {
      parsed.subcommand = argv[0];
      argv = argv.slice(1);
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1] ?? "";
    if (arg === "--enable-ntfy") {
      parsed.enableNtfy = true;
    } else if (arg === "--enable-web-push") {
      parsed.enableWebPush = true;
    } else if (arg === "--disable-web-push") {
      parsed.disableWebPush = true;
    } else if (arg === "--allow-insecure-http-lan") {
      parsed.allowInsecureHttpLan = true;
    } else if (arg === "--install-mkcert") {
      parsed.installMkcert = true;
    } else if (arg === "--mkcert-trust-stores") {
      parsed.mkcertTrustStores = next;
      index += 1;
    } else if (arg === "--public-hostname") {
      parsed.publicHostname = next;
      index += 1;
    } else if (arg === "--cloudflare-account-id") {
      parsed.cloudflareAccountId = next;
      index += 1;
    } else if (arg === "--access-allow-emails") {
      parsed.accessAllowEmails = next;
      index += 1;
    } else if (arg === "--no-launchd") {
      parsed.noLaunchd = true;
    } else if (arg === "--port") {
      parsed.port = Number(next) || null;
      index += 1;
    } else if (arg === "--access-mode") {
      parsed.accessMode = normalizeAccessMode(next, "");
      if (!parsed.accessMode) {
        throw new Error(`Unknown access mode: ${next}`);
      }
      index += 1;
    } else if (arg === "--hostname") {
      parsed.hostname = next;
      index += 1;
    } else if (arg === "--env-file") {
      parsed.envFile = next;
      index += 1;
    } else if (arg === "--config-dir") {
      parsed.configDir = next;
      index += 1;
    } else if (arg === "--state-file") {
      parsed.stateFile = next;
      index += 1;
    } else if (arg === "--log-file") {
      parsed.logFile = next;
      index += 1;
    } else if (arg === "--pid-file") {
      parsed.pidFile = next;
      index += 1;
    } else if (arg === "--launch-agent-path") {
      parsed.launchAgentPath = next;
      index += 1;
    } else if (arg === "--pair-code") {
      parsed.pairCode = next;
      index += 1;
    } else if (arg === "--pair-token") {
      parsed.pairToken = next;
      index += 1;
    } else if (arg === "--session-secret") {
      parsed.sessionSecret = next;
      index += 1;
    } else if (arg === "--tls-cert-file") {
      parsed.tlsCertFile = next;
      index += 1;
    } else if (arg === "--tls-key-file") {
      parsed.tlsKeyFile = next;
      index += 1;
    } else if (arg === "--web-push-subject") {
      parsed.webPushSubject = next;
      index += 1;
    } else if (arg === "--locale") {
      parsed.locale = next;
      index += 1;
    } else if (arg === "--vapid-public-key") {
      parsed.vapidPublicKey = next;
      index += 1;
    } else if (arg === "--vapid-private-key") {
      parsed.vapidPrivateKey = next;
      index += 1;
    } else if (arg === "--pair") {
      parsed.pair = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.command = "help";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.enableWebPush && parsed.disableWebPush) {
    throw new Error("Use either --enable-web-push or --disable-web-push, not both.");
  }

  return parsed;
}

function printHelp() {
  const locale = normalizeLocale(process.env.DEFAULT_LOCALE || process.env.LANG || "") || DEFAULT_LOCALE;
  console.log(`${t(locale, "cli.help.usage")}

${t(locale, "cli.help.commands")}
  ${t(locale, "cli.help.setup")}
  ${t(locale, "cli.help.remote")}
  ${t(locale, "cli.help.start")}
  ${t(locale, "cli.help.stop")}
  ${t(locale, "cli.help.status")}
  ${t(locale, "cli.help.doctor")}

${t(locale, "cli.help.commonOptions")}
  --port <n>
  --access-mode <lan|viveworker|cloudflare>
  --hostname <name>
  --env-file <path>
  --config-dir <path>
  --disable-web-push
  --enable-web-push
  --allow-insecure-http-lan
  --install-mkcert
  --mkcert-trust-stores <system[,java][,nss]>
  --public-hostname <fqdn>
  --cloudflare-account-id <id>
  --access-allow-emails <a@example.com,b@example.com>
  --tls-cert-file <path>
  --tls-key-file <path>
  --web-push-subject <mailto:...>
  --locale <en|ja>
  --vapid-public-key <key>
  --vapid-private-key <key>
  --enable-ntfy
  --no-launchd
  --pair
`);
}

async function resolveCliLocale(cliOptions, existingConfig = null) {
  const explicit = normalizeLocale(cliOptions?.locale || "");
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeLocale(existingConfig?.DEFAULT_LOCALE || "");
  if (persisted) {
    return persisted;
  }
  const detected = await detectSystemLocale();
  return detected || DEFAULT_LOCALE;
}

async function resolveSetupLocale(cliOptions, existingConfig = null) {
  const explicit = normalizeLocale(cliOptions?.locale || "");
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeLocale(existingConfig?.DEFAULT_LOCALE || "");
  if (persisted) {
    return persisted;
  }
  return (await detectSystemLocale()) || DEFAULT_LOCALE;
}

async function detectSystemLocale() {
  const detected = await detectMacSystemLocale();
  if (detected) {
    return detected;
  }
  return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || "");
}

async function detectMacSystemLocale() {
  if (process.platform !== "darwin") {
    return "";
  }
  const result = await execCommand(["defaults", "read", "-g", "AppleLanguages"], { ignoreError: true });
  if (!result.ok) {
    return "";
  }
  const normalized = normalizeLocale(extractFirstLocale(result.stdout));
  return normalized || "";
}

function extractFirstLocale(rawValue) {
  const text = String(rawValue || "");
  const quoted = text.match(/"([A-Za-z_-]+)"/u);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const bare = text.match(/\b([A-Za-z]{2}(?:[-_][A-Za-z]{2})?)\b/u);
  return bare?.[1] || "";
}

function buildLaunchAgentPlist({ label, nodePath, bridgeScript, envFile, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(nodePath)}</string>
      <string>${escapeXml(bridgeScript)}</string>
      <string>--env-file</string>
      <string>${escapeXml(envFile)}</string>
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

async function startDetachedBridge({ envFile, logFile, pidFile }) {
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const logHandle = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [bridgeScript, "--env-file", envFile], {
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
  await fs.writeFile(pidFile, `${child.pid}\n`, "utf8");
}

async function maybeReadPid(pidFile) {
  try {
    const raw = await fs.readFile(pidFile, "utf8");
    const pid = Number(raw.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function maybeReadEnvFile(filePath) {
  const output = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const rawLine of raw.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator === -1) {
        continue;
      }
      output[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  } catch {
    return output;
  }
  return output;
}

async function maybeReadText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function ensureDefaultLocalePersisted(envFile, cliOptions = {}, existingConfig = null) {
  const config = existingConfig || (await maybeReadEnvFile(envFile));
  if (normalizeLocale(config.DEFAULT_LOCALE)) {
    return config;
  }
  if (!(await fileExists(envFile))) {
    return config;
  }
  const locale = await resolveCliLocale(cliOptions, config);
  await fs.appendFile(envFile, `DEFAULT_LOCALE=${locale}\n`, "utf8");
  return {
    ...config,
    DEFAULT_LOCALE: locale,
  };
}

async function maybeRotateStartupPairing(envFile, config = {}) {
  const now = Date.now();
  const rotated = shouldRotatePairing({
    pairingCode: config.PAIRING_CODE,
    pairingToken: config.PAIRING_TOKEN,
    pairingExpiresAtMs: config.PAIRING_EXPIRES_AT_MS,
  }, now);

  if (!rotated) {
    return { rotated: false };
  }

  const nextPairing = generatePairingCredentials(now);
  const currentText = (await fileExists(envFile)) ? await fs.readFile(envFile, "utf8") : "";
  const nextText = upsertEnvText(currentText, {
    PAIRING_CODE: nextPairing.pairingCode,
    PAIRING_TOKEN: nextPairing.pairingToken,
    PAIRING_EXPIRES_AT_MS: String(nextPairing.pairingExpiresAtMs),
  });
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, nextText, "utf8");

  return {
    rotated: true,
    ...nextPairing,
  };
}

async function findLocalIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry?.family === "IPv4" && !entry.internal && entry.address) {
        result.push(entry.address);
      }
    }
  }
  return Array.from(new Set(result));
}

async function execCommand(args, { ignoreError = false, env = null, streamOutput = false, beforeStreamOutput = null } = {}) {
  return new Promise((resolve, reject) => {
    let beforeStreamOutputCalled = false;
    const maybeBeforeStreamOutput = () => {
      if (!streamOutput || beforeStreamOutputCalled) {
        return;
      }
      beforeStreamOutputCalled = true;
      beforeStreamOutput?.();
    };
    const child = spawn(args[0], args.slice(1), {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (streamOutput) {
        maybeBeforeStreamOutput();
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (streamOutput) {
        maybeBeforeStreamOutput();
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

function resolveMkcertTrustStores(cliOptions = {}) {
  return String(cliOptions.mkcertTrustStores || process.env.MKCERT_TRUST_STORES || "system").trim() || "system";
}

function resolveSetupWebPushEnabled(cliOptions = {}) {
  if (cliOptions.disableWebPush) {
    return false;
  }
  return true;
}

function cleanSetupValue(value) {
  return String(value ?? "").trim();
}

function validateSetupAccessModeOptions({
  cliOptions,
  accessMode,
  remoteAccessPublicHostname,
  cloudflareAccountId,
  remoteAccessAllowedEmails,
}) {
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    if (!cleanSetupValue(remoteAccessPublicHostname)) {
      throw new Error("--public-hostname is required with --access-mode cloudflare.");
    }
    if (!cleanSetupValue(cloudflareAccountId)) {
      throw new Error("--cloudflare-account-id is required with --access-mode cloudflare.");
    }
    if (!(Array.isArray(remoteAccessAllowedEmails) && remoteAccessAllowedEmails.length > 0)) {
      throw new Error("--access-allow-emails is required with --access-mode cloudflare.");
    }
    if (cliOptions.allowInsecureHttpLan) {
      throw new Error("--allow-insecure-http-lan is not available with --access-mode cloudflare.");
    }
    return;
  }
  if (accessMode === ACCESS_MODE_VIVEWORKER && cliOptions.allowInsecureHttpLan) {
    throw new Error("--allow-insecure-http-lan is not available with --access-mode viveworker.");
  }
}

function buildSetupPublicBaseUrl({ tlsRequired, allowInsecureHttpLan, localHostname, port }) {
  const scheme = tlsRequired ? "https" : "http";
  if (tlsRequired || allowInsecureHttpLan) {
    return `${scheme}://${localHostname}:${port}`;
  }
  return `http://127.0.0.1:${port}`;
}

function buildSetupFallbackBaseUrl({ publicBaseUrl, chosenIp, tlsRequired, allowInsecureHttpLan, port }) {
  if (tlsRequired || allowInsecureHttpLan) {
    const scheme = tlsRequired ? "https" : "http";
    return `${scheme}://${chosenIp}:${port}`;
  }
  return publicBaseUrl;
}

function logSetupProgress(locale, key, vars = {}) {
  console.log(`• ${t(locale, key, vars)}`);
}

function createCliProgressReporter(initialLocale) {
  let locale = initialLocale;
  let lastWidth = 0;
  let active = false;
  let currentText = "";
  let spinnerIndex = 0;
  let spinnerTimer = null;
  const interactive = Boolean(process.stdout.isTTY);
  const spinnerFrames = ["|", "/", "-", "\\"];

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const render = (prefix, text, newline = false) => {
    const padded = `${prefix} ${text}`.padEnd(lastWidth);
    process.stdout.write(`\r${padded}${newline ? "\n" : ""}`);
    lastWidth = newline ? 0 : Math.max(lastWidth, `${prefix} ${text}`.length);
    active = !newline;
  };

  const ensureSpinner = () => {
    if (!interactive || spinnerTimer || !currentText) {
      return;
    }
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      render(spinnerFrames[spinnerIndex], currentText, false);
    }, 120);
    spinnerTimer.unref?.();
  };

  const writeLine = (prefix, key, vars = {}, newline = false) => {
    const text = `${prefix} ${t(locale, key, vars)}`;
    if (!interactive) {
      console.log(text);
      return;
    }
    stopSpinner();
    currentText = t(locale, key, vars);
    render(prefix, currentText, newline);
    if (!newline && prefix !== "✓") {
      ensureSpinner();
    } else if (newline) {
      currentText = "";
      spinnerIndex = 0;
    }
  };

  return {
    setLocale(nextLocale) {
      locale = nextLocale || locale;
    },
    update(key, vars = {}) {
      writeLine("•", key, vars, false);
    },
    done(key, vars = {}) {
      writeLine("✓", key, vars, true);
    },
    clear() {
      stopSpinner();
      if (!interactive || !active || lastWidth === 0) {
        return;
      }
      process.stdout.write(`\r${" ".repeat(lastWidth)}\r`);
      lastWidth = 0;
      active = false;
      currentText = "";
      spinnerIndex = 0;
    },
  };
}

function buildHealthCheckArgs(url) {
  const args = ["curl", "-sS", "--fail-with-body", "--connect-timeout", "3", "--max-time", "5"];
  if (isHttpsUrl(url)) {
    args.push("-k");
  }
  args.push(url);
  return args;
}

function buildLoopbackHealthUrl(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    const url = new URL(baseUrl);
    url.hostname = "127.0.0.1";
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function buildLoopbackUrl(baseUrl, pathname, searchParams = null) {
  if (!baseUrl) {
    return "";
  }
  try {
    const url = new URL(baseUrl);
    url.hostname = "127.0.0.1";
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    if (searchParams && Object.keys(searchParams).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value == null || value === "") {
          continue;
        }
        params.set(key, String(value));
      }
      const serialized = params.toString();
      url.search = serialized ? `?${serialized}` : "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printQrCode(url) {
  try {
    const module = await import("qrcode-terminal");
    const qrcode = module.default || module;
    console.log("");
    qrcode.generate(url, { small: true });
  } catch {
    console.log("");
    console.log("QR generation requires the optional qrcode-terminal dependency.");
  }
}

async function waitForEnter(locale, key) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  const rl = createReadlineInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await rl.question(`\n${t(locale, key)} `);
  } finally {
    rl.close();
  }
}

async function startTemporaryCaDownloadServer({
  rootCaFile,
  preferredPort,
  localHostname,
  fallbackIp,
  pathName = "/ca/rootCA.pem",
}) {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === pathName || url.pathname === "/downloads/rootCA.pem") {
      try {
        const body = await fs.readFile(rootCaFile, "utf8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-pem-file");
        res.setHeader("Content-Disposition", 'attachment; filename="rootCA.pem"');
        res.end(body);
        return;
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("rootCA.pem not found");
        return;
      }
    }
    if (url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  });

  const actualPort = await listenTemporaryServer(server, preferredPort, "0.0.0.0");
  const localUrl = `http://${localHostname}:${actualPort}${pathName}`;
  const ipUrl = `http://${fallbackIp}:${actualPort}${pathName}`;
  return {
    port: actualPort,
    localUrl,
    ipUrl,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function listenTemporaryServer(server, preferredPort, host) {
  try {
    return await listenServerOnce(server, preferredPort, host);
  } catch (error) {
    if (error?.code === "EADDRINUSE" && preferredPort !== 0) {
      return await listenServerOnce(server, 0, host);
    }
    throw error;
  }
}

async function listenServerOnce(server, port, host) {
  return await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(Number(address?.port) || port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function waitForHealth(url, { attempts = 8, intervalMs = 500 } = {}) {
  if (!url) {
    return false;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await execCommand(buildHealthCheckArgs(url), { ignoreError: true });
    if (result.ok) {
      return true;
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return false;
}

async function waitForExpectedPairing(baseUrl, pairToken, { attempts = 8, intervalMs = 500 } = {}) {
  const token = String(pairToken || "").trim();
  const manifestUrl = buildLoopbackUrl(baseUrl, "/manifest.webmanifest", { pairToken: token });
  const expectedStartUrl = `/app?pairToken=${encodeURIComponent(token)}`;
  if (!token || !manifestUrl) {
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await execCommand(buildHealthCheckArgs(manifestUrl), { ignoreError: true });
    if (result.ok) {
      try {
        const payload = JSON.parse(result.stdout);
        if (String(payload?.start_url || "").trim() === expectedStartUrl) {
          return true;
        }
      } catch {
        // Keep retrying while the new bridge instance comes up.
      }
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }

  return false;
}

function truthyString(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || "").trim());
}

function resolveConfiguredAccessMode({ cliOptions = {}, existing = {} }) {
  const explicit = normalizeAccessMode(cliOptions.accessMode, "");
  if (explicit === LEGACY_ACCESS_MODE_VPN) {
    return LEGACY_ACCESS_MODE_VPN;
  }
  if (explicit) {
    return explicit;
  }
  const existingMode = normalizeAccessMode(existing.ACCESS_MODE, "");
  if (existingMode === LEGACY_ACCESS_MODE_VPN) {
    return LEGACY_ACCESS_MODE_VPN;
  }
  if (existingMode) {
    return existingMode;
  }
  const legacyRemoteProvider = cleanRemoteText(existing.REMOTE_ACCESS_PROVIDER || "").toLowerCase();
  if (legacyRemoteProvider === ACCESS_MODE_CLOUDFLARE) {
    return ACCESS_MODE_CLOUDFLARE;
  }
  return ACCESS_MODE_LAN;
}

function configuredRemotePublicUrl({
  accessMode,
  remoteAccessPublicHostname = "",
  managedRemotePublicUrl = "",
  managedRemoteSubdomain = "",
}) {
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    return buildRemotePublicUrl(remoteAccessPublicHostname);
  }
  if (accessMode === ACCESS_MODE_VIVEWORKER) {
    return buildManagedRemotePublicUrl({
      publicUrl: managedRemotePublicUrl,
      subdomain: managedRemoteSubdomain,
    });
  }
  return "";
}

function configuredRemotePublicHostname({ accessMode, remoteAccessPublicHostname = "", managedRemotePublicUrl = "" }) {
  if (accessMode === ACCESS_MODE_CLOUDFLARE) {
    return cleanRemoteText(remoteAccessPublicHostname).toLowerCase();
  }
  if (accessMode === ACCESS_MODE_VIVEWORKER && managedRemotePublicUrl) {
    try {
      return new URL(managedRemotePublicUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return "";
}

function buildCloudflareUpstreamUrl(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    const url = new URL(baseUrl);
    url.hostname = "127.0.0.1";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function buildCliRemoteAccessInfo(config = {}) {
  const accessMode = resolveConfiguredAccessMode({ existing: config });
  const publicHostname = configuredRemotePublicHostname({
    accessMode,
    remoteAccessPublicHostname: config.REMOTE_ACCESS_PUBLIC_HOSTNAME || "",
    managedRemotePublicUrl: config.MANAGED_REMOTE_PUBLIC_URL || "",
  });
  const publicUrl = configuredRemotePublicUrl({
    accessMode,
    remoteAccessPublicHostname: config.REMOTE_ACCESS_PUBLIC_HOSTNAME || "",
    managedRemotePublicUrl: config.MANAGED_REMOTE_PUBLIC_URL || "",
    managedRemoteSubdomain: config.MANAGED_REMOTE_SUBDOMAIN || "",
  });
  const view = {
    accessMode,
    publicHostname,
    publicUrl,
    enabled: truthyString(config.REMOTE_ACCESS_ENABLED),
    expiresAtMs: Number(config.REMOTE_ACCESS_EXPIRES_AT_MS) || 0,
  };
  const base = {
    accessMode,
    remoteAccessPublicHostname: publicHostname,
    remoteAccessEnabled: view.enabled,
    remoteAccessExpiresAtMs: view.expiresAtMs,
    cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID || "",
    cloudflareZoneId: config.CLOUDFLARE_ZONE_ID || "",
    cloudflareTunnelId: config.CLOUDFLARE_TUNNEL_ID || "",
    cloudflareAccessAppId: config.CLOUDFLARE_ACCESS_APP_ID || "",
    cloudflareAccessPolicyId: config.CLOUDFLARE_ACCESS_POLICY_ID || "",
    cloudflareTunnelCredentialsFile: config.CLOUDFLARE_TUNNEL_CREDENTIALS_FILE || "",
    cloudflareTunnelConfigFile: config.CLOUDFLARE_TUNNEL_CONFIG_FILE || "",
    managedRemoteInstallationId: config.MANAGED_REMOTE_INSTALLATION_ID || "",
    managedRemotePublicUrl: config.MANAGED_REMOTE_PUBLIC_URL || "",
    managedRemoteControlUrl: config.MANAGED_REMOTE_CONTROL_URL || "",
    managedRemoteSecretFile: config.MANAGED_REMOTE_SECRET_FILE || "",
    managedRemoteSubdomain: config.MANAGED_REMOTE_SUBDOMAIN || "",
  };
  return {
    ...view,
    configured:
      accessMode === ACCESS_MODE_CLOUDFLARE
        ? remoteAccessConfigured(base)
        : accessMode === ACCESS_MODE_VIVEWORKER
          ? managedRemoteConfigured(base)
          : false,
    active:
      accessModeHasRemoteOverlay(accessMode) &&
      view.enabled &&
      !remoteAccessExpired({ remoteAccessExpiresAtMs: view.expiresAtMs }),
    expired: remoteAccessExpired({
      remoteAccessExpiresAtMs: view.expiresAtMs,
    }),
  };
}

function formatStatusTimestamp(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) {
    return "(not set)";
  }
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

function isHttpsUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("https://");
}

function isLoopbackBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function collectTlsHosts({ hostname, localHostname, chosenIp }) {
  return Array.from(
    new Set(
      ["localhost", "127.0.0.1", hostname, localHostname, chosenIp]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

async function ensureLanTlsAssets({
  cliOptions,
  locale,
  hostname,
  localHostname,
  progress,
  chosenIp,
  tlsCertFile,
  tlsKeyFile,
}) {
  const mkcertTrustStores = resolveMkcertTrustStores(cliOptions);
  const manualCertOverride = Boolean(cliOptions.tlsCertFile || cliOptions.tlsKeyFile);
  const certExists = await fileExists(tlsCertFile);
  const keyExists = await fileExists(tlsKeyFile);
  if (certExists !== keyExists) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must both exist.");
  }

  if (!certExists) {
    if (manualCertOverride) {
      throw new Error("The provided TLS certificate or key file does not exist.");
    }

    let mkcertPath = await findExecutable("mkcert");
    if (!mkcertPath && cliOptions.installMkcert) {
      mkcertPath = await installMkcertForMac(progress, locale);
    }
    if (!mkcertPath) {
      throw new Error(
        [
          "Web Push requires HTTPS, but mkcert is not installed.",
          "Install mkcert and trust its local CA, or provide --tls-cert-file and --tls-key-file.",
          "You can also run: npx viveworker setup --install-mkcert",
          "Example: brew install mkcert && mkcert -install",
        ].join("\n")
      );
    }

    progress?.update("cli.setup.progress.installCa", { stores: mkcertTrustStores });
    await execCommand([mkcertPath, "-install"], {
      env: {
        TRUST_STORES: mkcertTrustStores,
      },
      streamOutput: true,
      beforeStreamOutput: () => progress?.clear(),
    });
    progress?.update("cli.setup.progress.generateCert");
    await fs.mkdir(path.dirname(tlsCertFile), { recursive: true });
    await execCommand([
      mkcertPath,
      "-cert-file",
      tlsCertFile,
      "-key-file",
      tlsKeyFile,
      ...collectTlsHosts({ hostname, localHostname, chosenIp }),
    ], {
      streamOutput: true,
      beforeStreamOutput: () => progress?.clear(),
    });
  } else {
    const mkcertPath = await findExecutable("mkcert");
    if (mkcertPath && cliOptions.installMkcert) {
      progress?.update("cli.setup.progress.installCa", { stores: mkcertTrustStores });
      await execCommand([mkcertPath, "-install"], {
        env: {
          TRUST_STORES: mkcertTrustStores,
        },
        streamOutput: true,
        beforeStreamOutput: () => progress?.clear(),
      });
    }
  }
  return {
    certFile: tlsCertFile,
    keyFile: tlsKeyFile,
  };
}

async function ensureVapidKeys({ cliOptions, existing, progress }) {
  const vapidPublicKey =
    cliOptions.vapidPublicKey ||
    existing.WEB_PUSH_VAPID_PUBLIC_KEY ||
    "";
  const vapidPrivateKey =
    cliOptions.vapidPrivateKey ||
    existing.WEB_PUSH_VAPID_PRIVATE_KEY ||
    "";
  if (vapidPublicKey && vapidPrivateKey) {
    return {
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey,
    };
  }

  progress?.update("cli.setup.progress.generateVapid");
  return await generateVapidKeys();
}

async function generateVapidKeys() {
  const module = await import("web-push");
  const webPush = module.default || module;
  return webPush.generateVAPIDKeys();
}

async function findExecutable(name) {
  const result = await execCommand(["which", name], { ignoreError: true });
  if (!result.ok) {
    return "";
  }
  return result.stdout.trim();
}

async function installMkcertForMac(progress, locale) {
  const brewPath = await findExecutable("brew");
  if (!brewPath) {
    throw new Error(
      [
        "mkcert is not installed and Homebrew was not found.",
        "Install Homebrew first, or install mkcert manually, then rerun setup.",
      ].join("\n")
    );
  }

  progress?.update("cli.setup.progress.installMkcert");
  await execCommand([brewPath, "install", "mkcert"], {
    streamOutput: true,
    beforeStreamOutput: () => progress?.clear(),
  });
  const mkcertPath = await findExecutable("mkcert");
  if (!mkcertPath) {
    throw new Error("mkcert installation finished, but the mkcert executable is still not available.");
  }
  return mkcertPath;
}

async function checkCertificateHosts({ certFile, expectedHosts }) {
  try {
    const raw = await fs.readFile(certFile, "utf8");
    const certificate = new crypto.X509Certificate(raw);
    const subjectAltName = String(certificate.subjectAltName || "");
    const available = new Set(
      subjectAltName
        .split(",")
        .map((part) => part.trim())
        .map((part) => part.replace(/^DNS:/u, "").replace(/^IP Address:/u, "").trim())
        .filter(Boolean)
    );
    return expectedHosts
      .filter((host) => !available.has(host))
      .map((host) => `TLS certificate is missing SAN entry for ${host}`);
  } catch (error) {
    return [`Unable to inspect TLS certificate: ${error.message || String(error)}`];
  }
}

function resolvePath(targetPath) {
  if (!targetPath) {
    return targetPath;
  }
  if (targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(process.cwd(), targetPath);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

async function printPairingInfo(locale, config) {
  const baseUrl = String(config.NATIVE_APPROVAL_SERVER_PUBLIC_BASE_URL || "").trim();
  const pairCode = String(config.PAIRING_CODE || "").trim();
  const pairToken = String(config.PAIRING_TOKEN || "").trim();
  if (!baseUrl || !pairCode || !pairToken) {
    return;
  }

  const pairPath = `/app?pairToken=${encodeURIComponent(pairToken)}`;

  console.log("");
  console.log(t(locale, "cli.setup.pairingCode", { code: pairCode }));
  const ips = await findLocalIpv4Addresses();
  const fallbackBaseUrl = buildFallbackBaseUrl(baseUrl, ips[0] || "127.0.0.1");
  console.log(t(locale, "cli.setup.pairingUrlLocal", { url: `${baseUrl}${pairPath}` }));
  console.log(t(locale, "cli.setup.pairingUrlIp", { url: `${fallbackBaseUrl}${pairPath}` }));
}

function buildFallbackBaseUrl(baseUrl, ipAddress) {
  try {
    const url = new URL(baseUrl);
    url.hostname = ipAddress;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return baseUrl;
  }
}
