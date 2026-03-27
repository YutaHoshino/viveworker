export const ACCESS_MODE_LAN = "lan";
export const ACCESS_MODE_VIVEWORKER = "viveworker";
export const ACCESS_MODE_CLOUDFLARE = "cloudflare";
export const LEGACY_ACCESS_MODE_VPN = "vpn";
export const ACCESS_MODE_VPN = LEGACY_ACCESS_MODE_VPN;

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function normalizeAccessMode(value, fallback = ACCESS_MODE_LAN) {
  const normalized = cleanText(value).toLowerCase();
  if (
    normalized === ACCESS_MODE_LAN ||
    normalized === ACCESS_MODE_VIVEWORKER ||
    normalized === ACCESS_MODE_CLOUDFLARE ||
    normalized === LEGACY_ACCESS_MODE_VPN
  ) {
    return normalized;
  }
  return fallback;
}

export function isLegacyVpnAccessMode(value) {
  return normalizeAccessMode(value, "") === LEGACY_ACCESS_MODE_VPN;
}

export function isManagedRemoteAccessMode(value) {
  return normalizeAccessMode(value, "") === ACCESS_MODE_VIVEWORKER;
}

export function isCloudflareAccessMode(value) {
  return normalizeAccessMode(value, "") === ACCESS_MODE_CLOUDFLARE;
}

export function isLanAccessMode(value) {
  return normalizeAccessMode(value, "") === ACCESS_MODE_LAN;
}

export function accessModeHasRemoteOverlay(value) {
  const normalized = normalizeAccessMode(value, "");
  return normalized === ACCESS_MODE_VIVEWORKER || normalized === ACCESS_MODE_CLOUDFLARE;
}

export function accessModeRequiresHttps(value, webPushEnabled = false) {
  return Boolean(webPushEnabled) || accessModeHasRemoteOverlay(value);
}
