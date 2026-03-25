import { DEFAULT_LOCALE, SUPPORTED_LOCALES, localeDisplayName, normalizeLocale, resolveLocalePreference, t } from "./i18n.js";

const DESKTOP_BREAKPOINT = 980;
const INSTALL_BANNER_DISMISS_KEY = "viveworker-install-banner-dismissed-v2";
const PUSH_BANNER_DISMISS_KEY = "viveworker-push-banner-dismissed-v1";
const INITIAL_DETECTED_LOCALE = detectBrowserLocale();
const TIMELINE_MESSAGE_KINDS = new Set(["user_message", "assistant_commentary", "assistant_final"]);
const TIMELINE_OPERATIONAL_KINDS = new Set(["approval", "plan", "plan_ready", "choice", "completion"]);
const THREAD_FILTER_INTERACTION_DEFER_MS = 8000;

const state = {
  session: null,
  inbox: null,
  timeline: null,
  devices: [],
  currentTab: "pending",
  currentItem: null,
  currentDetail: null,
  currentDetailLoading: false,
  detailLoadingItem: null,
  detailOpen: false,
  timelineThreadFilter: "all",
  completedThreadFilter: "all",
  settingsSubpage: "",
  settingsScrollState: null,
  pendingSettingsSubpageScrollReset: false,
  pendingSettingsScrollRestore: false,
  launchItemIntent: null,
  detailOverride: null,
  pendingDetailScrollReset: false,
  listScrollState: null,
  pendingListScrollRestore: false,
  threadFilterInteractionUntilMs: 0,
  choiceLocalDrafts: {},
  completionReplyDrafts: {},
  pairError: "",
  pairNotice: "",
  pushStatus: null,
  pushNotice: "",
  pushError: "",
  deviceNotice: "",
  deviceError: "",
  serviceWorkerRegistration: null,
  installGuideOpen: false,
  logoutConfirmOpen: false,
  installBannerDismissed: readInstallBannerDismissed(),
  pushBannerDismissed: readPushBannerDismissed(),
  detectedLocale: INITIAL_DETECTED_LOCALE,
  locale: INITIAL_DETECTED_LOCALE || DEFAULT_LOCALE,
  localeSource: "fallback",
  defaultLocale: DEFAULT_LOCALE,
  supportedLocales: [...SUPPORTED_LOCALES],
  appVersion: "",
};

let detailLoadSequence = 0;

const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const initialItem = params.get("item") || "";
const initialPairToken = params.get("pairToken") || "";
let didReloadForServiceWorker = false;
let lastViewportMode = isDesktopLayout();

boot().catch((error) => {
  const message = error.message || String(error);
  const hint = /Load failed|Failed to fetch|NetworkError|fetch/i.test(message)
    ? `<p class="muted">${escapeHtml(L("error.networkHint"))}</p>`
    : "";
  app.innerHTML = `
    <main class="onboarding-shell">
      <section class="onboarding-card">
        <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
        <h1 class="hero-title">${escapeHtml(L("common.appName"))}</h1>
        <p class="hero-copy">${escapeHtml(message)}</p>
        ${hint}
      </section>
    </main>
  `;
});

async function boot() {
  updateManifestHref(initialPairToken);
  await registerServiceWorker();
  navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
  window.addEventListener("resize", handleViewportChange, { passive: true });

  await refreshSession();

  if (!state.session?.authenticated && initialPairToken && shouldAutoPairFromBootstrapToken()) {
    try {
      await pair({
        token: initialPairToken,
        temporary: shouldUseTemporaryBootstrapPairing(),
      });
    } catch (error) {
      state.pairError = error.message || String(error);
    }
    await refreshSession();
  }

  syncPairingTokenState(desiredBootstrapPairingToken());

  const parsedInitialItem = parseItemRef(initialItem);
  if (parsedInitialItem) {
    state.currentItem = parsedInitialItem;
    state.currentTab = tabForItemKind(parsedInitialItem.kind, state.currentTab);
    state.detailOpen = true;
    if (isFastPathItemRef(parsedInitialItem)) {
      state.launchItemIntent = {
        ...parsedInitialItem,
        status: "pending",
      };
    }
  }

  if (!state.session?.authenticated) {
    renderPair();
    return;
  }

  await syncDetectedLocalePreference();
  await refreshAuthenticatedState();
  ensureCurrentSelection();
  await renderShell();

  setInterval(async () => {
    if (!state.session?.authenticated) {
      return;
    }
    await refreshAuthenticatedState();
    if (!shouldDeferRenderForActiveInteraction()) {
      await renderShell();
    }
  }, 3000);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    state.serviceWorkerRegistration = await navigator.serviceWorker.register("/sw.js");
    await state.serviceWorkerRegistration.update().catch(() => {});
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      if (didReloadForServiceWorker) {
        return;
      }
      didReloadForServiceWorker = true;
      window.location.reload();
    });
  } catch {
    state.serviceWorkerRegistration = null;
  }
}

function handleViewportChange() {
  const nextViewportMode = isDesktopLayout();
  if (nextViewportMode === lastViewportMode) {
    return;
  }
  lastViewportMode = nextViewportMode;
  if (nextViewportMode) {
    state.detailOpen = false;
    ensureCurrentSelection();
    if (state.currentTab !== "settings") {
      syncCurrentItemUrl(state.currentItem);
    }
  } else if (!parseItemRef(new URLSearchParams(window.location.search).get("item"))) {
    state.detailOpen = false;
    syncCurrentItemUrl(null);
  }
  renderCurrentSurface();
}

async function refreshAuthenticatedState() {
  await refreshInbox();
  await refreshTimeline();
  await refreshDevices();
  await refreshPushStatus();
  ensureCurrentSelection();
}

async function refreshSession() {
  state.session = await apiGet("/api/session");
  syncPairingTokenState(desiredBootstrapPairingToken());
  applyResolvedLocale();
}

async function syncDetectedLocalePreference() {
  if (!state.session?.authenticated || !state.session?.deviceId || !state.detectedLocale) {
    return;
  }
  if (normalizeLocale(state.session?.deviceDetectedLocale || "") === state.detectedLocale) {
    return;
  }
  const result = await apiPost("/api/session/locale", {
    detectedLocale: state.detectedLocale,
  });
  state.session = {
    ...state.session,
    ...result,
  };
  applyResolvedLocale();
}

async function setLocaleOverride(nextLocale) {
  const result = await apiPost("/api/session/locale", {
    detectedLocale: state.detectedLocale,
    overrideLocale: nextLocale || null,
  });
  state.session = {
    ...state.session,
    ...result,
  };
  applyResolvedLocale();
}

function applyResolvedLocale() {
  state.defaultLocale = normalizeLocale(state.session?.defaultLocale || "") || DEFAULT_LOCALE;
  state.supportedLocales = Array.isArray(state.session?.supportedLocales)
    ? state.session.supportedLocales.map((value) => normalizeLocale(value)).filter(Boolean)
    : [...SUPPORTED_LOCALES];
  state.appVersion = normalizeClientText(state.session?.appVersion || "");
  const resolved = resolveLocalePreference({
    overrideLocale: state.session?.deviceOverrideLocale,
    detectedLocale: state.session?.deviceDetectedLocale || state.detectedLocale,
    defaultLocale: state.defaultLocale,
    fallbackLocale: DEFAULT_LOCALE,
  });
  state.locale = normalizeLocale(state.session?.locale || "") || resolved.locale;
  state.localeSource = state.session?.localeSource || resolved.source;
}

function L(key, vars = {}) {
  return t(state.locale || DEFAULT_LOCALE, key, vars);
}

function detectBrowserLocale() {
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    for (const value of navigator.languages) {
      const normalized = normalizeLocale(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return normalizeLocale(navigator.language || "") || DEFAULT_LOCALE;
}

async function refreshPushStatus() {
  const client = await getClientPushState();
  if (!state.session?.authenticated) {
    state.pushStatus = {
      ...client,
      enabled: false,
      subscribed: false,
      serverSubscribed: false,
      lastSuccessfulDeliveryAtMs: 0,
      vapidPublicKey: "",
    };
    return;
  }

  try {
    const server = await apiGet("/api/push/status");
    state.pushStatus = {
      ...server,
      ...client,
      serverSubscribed: Boolean(server.subscribed),
      subscribed: Boolean(server.subscribed || client.clientSubscribed),
    };
  } catch (error) {
    state.pushStatus = {
      ...client,
      enabled: false,
      subscribed: false,
      serverSubscribed: false,
      lastSuccessfulDeliveryAtMs: 0,
      vapidPublicKey: "",
      error: error.message || String(error),
    };
  }
}

async function getClientPushState() {
  const registration = state.serviceWorkerRegistration || (await navigator.serviceWorker?.ready.catch(() => null));
  if (registration) {
    state.serviceWorkerRegistration = registration;
  }
  const subscription =
    registration && "pushManager" in registration
      ? await registration.pushManager.getSubscription().catch(() => null)
      : null;
  return {
    secureContext: window.isSecureContext === true,
    standalone: isStandaloneMode(),
    notificationPermission: "Notification" in window ? Notification.permission : "unsupported",
    supportsPush:
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
    clientSubscribed: Boolean(subscription),
  };
}

async function refreshInbox() {
  state.inbox = await apiGet("/api/inbox");
  syncCompletedThreadFilter();
}

async function refreshTimeline() {
  state.timeline = await apiGet("/api/timeline");
  syncTimelineThreadFilter();
}

async function refreshDevices() {
  if (!state.session?.authenticated) {
    state.devices = [];
    state.deviceError = "";
    return;
  }

  try {
    const payload = await apiGet("/api/devices");
    state.devices = Array.isArray(payload?.devices) ? payload.devices : [];
    state.deviceError = "";
  } catch (error) {
    state.deviceError = error.message || String(error);
  }
}

function ensureCurrentSelection() {
  if ((!state.inbox && !state.timeline) || state.currentTab === "settings") {
    return;
  }

  const allEntries = allSelectableEntries();
  const preferredEntries = listEntriesForCurrentTab();
  const previousItem = state.currentItem ? { ...state.currentItem } : null;
  const hasCurrent = state.currentItem
    ? allEntries.some((entry) => isSameItemRef(state.currentItem, entry.item))
    : false;
  const hasCurrentInPreferred = state.currentItem
    ? preferredEntries.some((entry) => isSameItemRef(state.currentItem, entry.item))
    : false;

  if (!hasCurrent) {
    if (!shouldPreserveCurrentItem()) {
      clearChoiceLocalDraftForItem(previousItem);
      state.currentItem = null;
      state.currentDetail = null;
      clearDetailOverride();
    }
  }

  if (isDesktopLayout()) {
    const fallback = preferredEntries[0] || allEntries[0] || null;
    if (!state.currentItem && fallback) {
      state.currentItem = toItemRef(fallback.item);
    } else if (state.currentItem && !hasCurrentInPreferred && fallback && !shouldPreserveCurrentItem()) {
      state.currentItem = toItemRef(fallback.item);
      state.currentDetail = null;
    }
  }

  if (state.detailOpen && !state.currentItem) {
    state.detailOpen = false;
    syncCurrentItemUrl(null);
  }
}

function allInboxEntries() {
  if (!state.inbox) {
    return [];
  }
  return [
    ...state.inbox.pending.map((item) => ({ item, status: "pending" })),
    ...state.inbox.completed.map((item) => ({ item, status: "completed" })),
  ];
}

function allTimelineEntries() {
  if (!state.timeline?.entries) {
    return [];
  }
  return state.timeline.entries.map((item) => ({ item, status: "timeline" }));
}

function allSelectableEntries() {
  return [...allInboxEntries(), ...allTimelineEntries()];
}

function listEntriesForTab(tab) {
  if (!state.inbox) {
    if (tab !== "timeline") {
      return [];
    }
  }
  if (tab === "pending") {
    return state.inbox.pending.map((item) => ({ item, status: "pending" }));
  }
  if (tab === "timeline") {
    return filteredTimelineEntries().map((item) => ({ item, status: "timeline" }));
  }
  if (tab === "completed") {
    return filteredCompletedEntries().map((item) => ({ item, status: "completed" }));
  }
  return [];
}

function listEntriesForCurrentTab() {
  return listEntriesForTab(state.currentTab);
}

function filteredTimelineEntries() {
  const entries = Array.isArray(state.timeline?.entries) ? state.timeline.entries : [];
  if (!entries.length) {
    return [];
  }
  if (!state.timelineThreadFilter || state.timelineThreadFilter === "all") {
    return entries;
  }
  return entries.filter((entry) => entry.threadId === state.timelineThreadFilter);
}

function filteredCompletedEntries() {
  const entries = Array.isArray(state.inbox?.completed) ? state.inbox.completed : [];
  if (!entries.length) {
    return [];
  }
  if (!state.completedThreadFilter || state.completedThreadFilter === "all") {
    return entries;
  }
  return entries.filter((entry) => entry.threadId === state.completedThreadFilter);
}

function syncTimelineThreadFilter() {
  const threads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
  if (!state.timelineThreadFilter || state.timelineThreadFilter === "all") {
    state.timelineThreadFilter = "all";
    return;
  }
  if (!threads.some((thread) => thread.id === state.timelineThreadFilter)) {
    state.timelineThreadFilter = "all";
  }
}

function completedThreads() {
  const items = Array.isArray(state.inbox?.completed) ? state.inbox.completed : [];
  if (!items.length) {
    return [];
  }
  const byThread = new Map();
  for (const item of items) {
    const threadId = normalizeClientText(item.threadId || "");
    if (!threadId) {
      continue;
    }
    const latestAtMs = Number(item.createdAtMs || 0);
    const label = resolvedThreadLabel(threadId, item.threadLabel || "");
    const previous = byThread.get(threadId);
    if (!previous || latestAtMs >= previous.latestAtMs) {
      byThread.set(threadId, {
        id: threadId,
        label,
        latestAtMs,
      });
    }
  }
  return [...byThread.values()].sort((left, right) => right.latestAtMs - left.latestAtMs);
}

function syncCompletedThreadFilter() {
  const threads = completedThreads();
  if (!state.completedThreadFilter || state.completedThreadFilter === "all") {
    state.completedThreadFilter = "all";
    return;
  }
  if (!threads.some((thread) => thread.id === state.completedThreadFilter)) {
    state.completedThreadFilter = "all";
  }
}

function renderPair() {
  const shouldInstallFromHomeScreen = Boolean(initialPairToken) && !shouldAutoPairFromBootstrapToken();
  app.innerHTML = `
    <main class="onboarding-shell">
      <section class="onboarding-card">
        <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
        <h1 class="hero-title">${escapeHtml(L("common.appName"))}</h1>
        <p class="hero-copy">${escapeHtml(L("pair.copy"))}</p>
        ${state.pairNotice ? `<p class="inline-alert inline-alert--success">${escapeHtml(state.pairNotice)}</p>` : ""}
        ${state.pairError ? `<p class="inline-alert inline-alert--danger">${escapeHtml(state.pairError)}</p>` : ""}
        ${shouldInstallFromHomeScreen ? `<p class="inline-alert inline-alert--warning">${escapeHtml(L("pair.installFromHomeScreen"))}</p>` : ""}
        <form id="pair-form" class="pair-form">
          <label class="field">
            <span class="field-label">${escapeHtml(L("pair.codeLabel"))}</span>
            <input name="code" placeholder="${escapeHtml(L("pair.codePlaceholder"))}" autocomplete="one-time-code">
          </label>
          <button class="primary primary--wide" type="submit">${escapeHtml(L("pair.connect"))}</button>
        </form>
        <section class="helper-card">
          <div class="helper-copy">
            <strong>${escapeHtml(L("pair.helperTitle"))}</strong>
            <p class="muted">${escapeHtml(L("pair.helperCopy"))}</p>
          </div>
          <div class="actions">
            <button class="secondary secondary--wide" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>
          </div>
        </section>
      </section>
      ${renderInstallGuideModal()}
    </main>
  `;

  document.querySelector("#pair-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await pair({ code: String(form.get("code") || "") });
      state.pairError = "";
      state.pairNotice = "";
      await refreshSession();
      await refreshAuthenticatedState();
      await renderShell();
    } catch (error) {
      state.pairError = error.message || String(error);
      renderPair();
    }
  });

  bindSharedUi(renderPair);
}

async function pair(payload) {
  const result = await apiPost("/api/session/pair", payload);
  if (result?.temporaryPairing !== true) {
    syncPairingTokenState("");
  }
  return result;
}

async function logout({ revokeCurrentDeviceTrust = false } = {}) {
  await apiPost("/api/session/logout", { revokeCurrentDeviceTrust });
  resetAuthenticatedState();
  state.pairNotice = revokeCurrentDeviceTrust
    ? L("notice.loggedOutDeviceRemoved")
    : L("notice.loggedOutKeepTrusted");
  syncPairingTokenState("");
  renderPair();
}

function resetAuthenticatedState() {
  state.session = null;
  state.inbox = null;
  state.timeline = null;
  state.devices = [];
  state.currentItem = null;
  state.currentDetail = null;
  state.currentDetailLoading = false;
  state.detailLoadingItem = null;
  state.detailOpen = false;
  state.choiceLocalDrafts = {};
  clearAllCompletionReplyDrafts();
  state.completionReplyDrafts = {};
  state.settingsSubpage = "";
  state.settingsScrollState = null;
  state.listScrollState = null;
  clearPinnedDetailState();
  state.pushStatus = null;
  state.pushNotice = "";
  state.pushError = "";
  state.deviceNotice = "";
  state.deviceError = "";
  state.logoutConfirmOpen = false;
  state.pairError = "";
}

async function revokeTrustedDevice(deviceId) {
  if (!deviceId) {
    return;
  }
  const result = await apiPost(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {});
  if (result?.currentDeviceRevoked) {
    resetAuthenticatedState();
    state.pairNotice = L("notice.loggedOutDeviceRemoved");
    syncPairingTokenState("");
    renderPair();
    return;
  }
  state.deviceNotice = L("notice.deviceRevoked");
  state.deviceError = "";
  await refreshAuthenticatedState();
  await renderShell();
}

async function renderShell() {
  const desktop = isDesktopLayout();
  const shouldShowDetail = state.currentTab !== "settings" && state.currentItem && (desktop || state.detailOpen);
  let detail = null;
  if (shouldShowDetail) {
    detail = renderableCurrentDetail();
    if (!detail) {
      queueCurrentDetailLoad();
    }
  }

  const shellClassName = [
    "app-shell",
    desktop ? "app-shell--desktop" : "app-shell--mobile",
    !desktop && (state.detailOpen || isSettingsSubpageOpen()) ? "app-shell--detail" : "",
  ]
    .filter(Boolean)
    .join(" ");

  app.innerHTML = `
    <div class="${shellClassName}">
      ${desktop ? renderDesktopHeader(detail) : renderMobileTopBar(detail)}
      ${renderTopBanner()}
      <main class="app-main">
        ${desktop ? renderDesktopWorkspace(detail) : renderMobileWorkspace(detail)}
      </main>
      ${desktop || state.detailOpen || isSettingsSubpageOpen() ? "" : renderBottomTabs()}
      ${renderInstallGuideModal()}
      ${renderLogoutConfirmModal()}
    </div>
  `;

  bindShellInteractions();
  applyPendingDetailScrollReset();
  applyPendingListScrollRestore();
  applyPendingSettingsSubpageScrollReset();
  applyPendingSettingsScrollRestore();
}

function applyPendingDetailScrollReset() {
  if (!state.pendingDetailScrollReset || isDesktopLayout() || !state.detailOpen) {
    return;
  }
  state.pendingDetailScrollReset = false;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const detailScroll = document.querySelector(".mobile-detail-scroll");
    if (detailScroll) {
      detailScroll.scrollTop = 0;
    }
  });
}

function applyPendingListScrollRestore() {
  if (!state.pendingListScrollRestore || isDesktopLayout() || state.detailOpen || !state.listScrollState) {
    return;
  }
  state.pendingListScrollRestore = false;
  const targetY = Number.isFinite(state.listScrollState.y) ? state.listScrollState.y : 0;
  requestAnimationFrame(() => {
    window.scrollTo({ top: targetY, left: 0, behavior: "auto" });
  });
}

function applyPendingSettingsSubpageScrollReset() {
  if (!state.pendingSettingsSubpageScrollReset || isDesktopLayout() || !isSettingsSubpageOpen()) {
    return;
  }
  state.pendingSettingsSubpageScrollReset = false;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
}

function applyPendingSettingsScrollRestore() {
  if (!state.pendingSettingsScrollRestore || isDesktopLayout() || isSettingsSubpageOpen() || !state.settingsScrollState) {
    return;
  }
  state.pendingSettingsScrollRestore = false;
  const targetY = Number.isFinite(state.settingsScrollState.y) ? state.settingsScrollState.y : 0;
  requestAnimationFrame(() => {
    window.scrollTo({ top: targetY, left: 0, behavior: "auto" });
  });
}

function currentViewportScrollY() {
  return window.scrollY || window.pageYOffset || document.documentElement?.scrollTop || 0;
}

function markThreadFilterInteraction() {
  state.threadFilterInteractionUntilMs = Date.now() + THREAD_FILTER_INTERACTION_DEFER_MS;
}

function clearThreadFilterInteraction() {
  state.threadFilterInteractionUntilMs = 0;
}

function shouldDeferRenderForActiveInteraction() {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLTextAreaElement &&
    activeElement.matches("[data-completion-reply-textarea]") &&
    normalizeClientText(activeElement.dataset.replyToken) === normalizeClientText(state.currentItem?.token)
  ) {
    return true;
  }
  if (
    activeElement instanceof HTMLSelectElement &&
    activeElement.matches("[data-timeline-thread-select], [data-completed-thread-select]")
  ) {
    return true;
  }
  return state.threadFilterInteractionUntilMs > Date.now();
}

function normalizeChoiceAnswersMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const output = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(rawValue ?? "").trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function getChoiceLocalDraft(token) {
  if (!token) {
    return {};
  }
  return normalizeChoiceAnswersMap(state.choiceLocalDrafts?.[token]);
}

function mergeChoiceLocalDraft(token, answers) {
  if (!token) {
    return;
  }
  const nextDraft = {
    ...getChoiceLocalDraft(token),
    ...normalizeChoiceAnswersMap(answers),
  };
  if (Object.keys(nextDraft).length === 0) {
    clearChoiceLocalDraft(token);
    return;
  }
  state.choiceLocalDrafts[token] = nextDraft;
}

function clearChoiceLocalDraft(token) {
  if (!token || !state.choiceLocalDrafts?.[token]) {
    return;
  }
  delete state.choiceLocalDrafts[token];
}

function clearChoiceLocalDraftForItem(itemRef) {
  if (itemRef?.kind !== "choice") {
    return;
  }
  clearChoiceLocalDraft(itemRef.token);
}

function getEffectiveChoiceDraftAnswers(detail) {
  return {
    ...normalizeChoiceAnswersMap(detail?.draftAnswers),
    ...getChoiceLocalDraft(detail?.token),
  };
}

function normalizeReplyMode(value) {
  return normalizeClientText(value).toLowerCase() === "plan" ? "plan" : "default";
}

const COMPLETION_REPLY_IMAGE_SUPPORT = false;

function normalizeCompletionReplyAttachment(value) {
  if (!COMPLETION_REPLY_IMAGE_SUPPORT) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const file = typeof File !== "undefined" && value.file instanceof File ? value.file : null;
  const name = normalizeClientText(value.name || file?.name || "");
  const type = normalizeClientText(value.type || file?.type || "");
  const size = Number(value.size ?? file?.size) || 0;
  const previewUrl = normalizeClientText(value.previewUrl || "");
  if (!file || !name || !type.startsWith("image/") || size <= 0) {
    return null;
  }
  return {
    file,
    name,
    type,
    size,
    previewUrl,
  };
}

function createCompletionReplyAttachment(file) {
  if (!COMPLETION_REPLY_IMAGE_SUPPORT) {
    return null;
  }
  if (!(typeof File !== "undefined" && file instanceof File)) {
    return null;
  }
  if (!normalizeClientText(file.type).startsWith("image/")) {
    return null;
  }
  return normalizeCompletionReplyAttachment({
    file,
    name: file.name,
    type: file.type,
    size: file.size,
    previewUrl: typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : "",
  });
}

function releaseCompletionReplyAttachment(attachment) {
  if (!attachment?.previewUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  try {
    URL.revokeObjectURL(attachment.previewUrl);
  } catch {
    // Ignore best-effort object URL cleanup errors.
  }
}

function getCompletionReplyDraft(token) {
  if (!token) {
    return {
      text: "",
      sentText: "",
      attachment: null,
      mode: "default",
      notice: "",
      error: "",
      warning: null,
      confirmOverride: false,
      collapsedAfterSend: false,
      sending: false,
    };
  }

  const draft = state.completionReplyDrafts?.[token] || {};
  return {
    text: String(draft.text ?? ""),
    sentText: normalizeClientText(draft.sentText ?? ""),
    attachment: normalizeCompletionReplyAttachment(draft.attachment),
    mode: normalizeReplyMode(draft.mode),
    notice: normalizeClientText(draft.notice),
    error: normalizeClientText(draft.error),
    warning: normalizeCompletionReplyWarning(draft.warning),
    confirmOverride: draft.confirmOverride === true,
    collapsedAfterSend: draft.collapsedAfterSend === true,
    sending: draft.sending === true,
  };
}

function normalizeCompletionReplyWarning(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const createdAtMs = Number(value.createdAtMs) || 0;
  const summary = normalizeClientText(value.summary || "");
  const kind = normalizeClientText(value.kind || "");
  if (!createdAtMs && !summary && !kind) {
    return null;
  }
  return {
    createdAtMs,
    summary,
    kind,
  };
}

function setCompletionReplyDraft(token, partialDraft) {
  if (!token) {
    return;
  }
  const previousStoredDraft = state.completionReplyDrafts?.[token] || {};
  const previousAttachment = normalizeCompletionReplyAttachment(previousStoredDraft.attachment);
  const nextDraft = {
    ...getCompletionReplyDraft(token),
    ...(partialDraft || {}),
  };
  const nextAttachment = Object.prototype.hasOwnProperty.call(partialDraft || {}, "attachment")
    ? normalizeCompletionReplyAttachment(partialDraft?.attachment)
    : normalizeCompletionReplyAttachment(nextDraft.attachment);
  if (previousAttachment?.previewUrl && previousAttachment.previewUrl !== nextAttachment?.previewUrl) {
    releaseCompletionReplyAttachment(previousAttachment);
  }
  state.completionReplyDrafts[token] = {
    text: String(nextDraft.text ?? ""),
    sentText: normalizeClientText(nextDraft.sentText ?? ""),
    attachment: nextAttachment,
    mode: normalizeReplyMode(nextDraft.mode),
    notice: normalizeClientText(nextDraft.notice),
    error: normalizeClientText(nextDraft.error),
    warning: normalizeCompletionReplyWarning(nextDraft.warning),
    confirmOverride: nextDraft.confirmOverride === true,
    collapsedAfterSend: nextDraft.collapsedAfterSend === true,
    sending: nextDraft.sending === true,
  };
}

function clearCompletionReplyDraft(token) {
  if (!token || !state.completionReplyDrafts?.[token]) {
    return;
  }
  releaseCompletionReplyAttachment(state.completionReplyDrafts[token]?.attachment);
  delete state.completionReplyDrafts[token];
}

function clearAllCompletionReplyDrafts() {
  for (const token of Object.keys(state.completionReplyDrafts || {})) {
    clearCompletionReplyDraft(token);
  }
}

function syncCompletionReplyComposerLiveState(replyForm, draft) {
  if (!replyForm) {
    return;
  }
  const normalizedDraft = draft || {
    text: "",
    confirmOverride: false,
    sending: false,
  };
  const submitButton = replyForm.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = normalizedDraft.sending === true || !normalizeClientText(normalizedDraft.text);
    if (!normalizedDraft.sending) {
      submitButton.textContent = L(normalizedDraft.confirmOverride ? "reply.sendConfirm" : "reply.send");
    }
  }

  const composer = replyForm.closest(".reply-composer");
  if (!composer) {
    return;
  }
  for (const alert of composer.querySelectorAll(".inline-alert--success, .inline-alert--danger, .inline-alert--warning")) {
    alert.remove();
  }
}

function renderDesktopHeader(detail) {
  return `
    <header class="app-header">
      <div class="brand-lockup">
        <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
        <div class="brand-copy">
          <h1 class="brand-title">${escapeHtml(L("common.appName"))}</h1>
          <p class="brand-subtitle">${escapeHtml(subtitleForCurrentView(detail))}</p>
        </div>
      </div>
      ${renderDesktopTabs()}
    </header>
  `;
}

function renderMobileTopBar(detail) {
  if (isSettingsSubpageOpen()) {
    const page = settingsPageMeta(state.settingsSubpage);
    return `
      <header class="mobile-topbar mobile-topbar--detail">
        <button class="mobile-topbar__back" type="button" data-settings-back>
          <span class="mobile-topbar__back-icon" aria-hidden="true">${renderIcon("back")}</span>
          <span class="mobile-topbar__back-label">${escapeHtml(L("common.back"))}</span>
        </button>
        <div class="mobile-topbar__heading mobile-topbar__heading--detail">
          <span class="mobile-topbar__eyebrow">${escapeHtml(L("common.settings"))}</span>
          <h1 class="mobile-topbar__title mobile-topbar__title--detail">${escapeHtml(page.title)}</h1>
        </div>
      </header>
    `;
  }

  if (state.detailOpen && (detail || state.currentItem)) {
    const loadingDetail = detail || buildDetailLoadingSnapshot();
    const detailKind = kindMeta(loadingDetail.kind);
    return `
      <header class="mobile-topbar mobile-topbar--detail">
        <button class="mobile-topbar__back" type="button" data-back-to-list>
          <span class="mobile-topbar__back-icon" aria-hidden="true">${renderIcon("back")}</span>
          <span class="mobile-topbar__back-label">${escapeHtml(L("common.back"))}</span>
        </button>
        <div class="mobile-topbar__heading mobile-topbar__heading--detail">
          <span class="mobile-topbar__eyebrow mobile-topbar__eyebrow--kind">
            <span class="mobile-topbar__eyebrow-icon" aria-hidden="true">${renderIcon(detailKind.icon)}</span>
            <span>${escapeHtml(detailKind.label)}</span>
          </span>
          <h1 class="mobile-topbar__title mobile-topbar__title--detail">${escapeHtml(detailDisplayTitle(loadingDetail))}</h1>
        </div>
      </header>
    `;
  }

  const meta = tabMeta(state.currentTab);
  return `
    <header class="mobile-topbar">
      <div class="mobile-topbar__heading">
        <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("common.appName"))}</span>
        <h1 class="mobile-topbar__title">${escapeHtml(meta.title)}</h1>
      </div>
    </header>
  `;
}

function renderableCurrentDetail(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  if (hasDetailOverride(itemRef)) {
    return state.detailOverride.detail;
  }
  if (state.currentDetail && isSameItemRef(state.currentDetail, itemRef)) {
    return state.currentDetail;
  }
  return null;
}

function selectedEntryForItem(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  return allSelectableEntries().find((entry) => isSameItemRef(entry.item, itemRef)) || null;
}

function buildDetailLoadingSnapshot(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  const entry = selectedEntryForItem(itemRef);
  const item = entry?.item || {};
  return {
    kind: itemRef.kind,
    token: itemRef.token,
    title: item.title || kindMeta(itemRef.kind).label,
    threadLabel: item.threadLabel || "",
    createdAtMs: Number(item.createdAtMs) || 0,
    readOnly:
      entry?.status === "completed" ||
      TIMELINE_MESSAGE_KINDS.has(itemRef.kind) ||
      itemRef.kind === "completion" ||
      (itemRef.kind === "choice" && item.supported === false),
    loading: true,
  };
}

async function fetchCurrentDetailForItem(itemRef = state.currentItem) {
  if (!itemRef) {
    return null;
  }
  if (hasDetailOverride(itemRef)) {
    return state.detailOverride.detail;
  }
  try {
    const detail = await apiGet(`/api/items/${encodeURIComponent(itemRef.kind)}/${encodeURIComponent(itemRef.token)}`);
    if (hasLaunchItemIntent(itemRef)) {
      state.launchItemIntent.status = "loaded";
    }
    return detail;
  } catch (error) {
    if (error.status === 401) {
      state.session = null;
      state.currentDetail = null;
      renderPair();
      return null;
    }
    await refreshInbox();
    try {
      const detail = await apiGet(`/api/items/${encodeURIComponent(itemRef.kind)}/${encodeURIComponent(itemRef.token)}`);
      if (hasLaunchItemIntent(itemRef)) {
        state.launchItemIntent.status = "loaded";
      }
      return detail;
    } catch {
      if (hasLaunchItemIntent(itemRef)) {
        clearChoiceLocalDraftForItem(itemRef);
        const fallbackDetail = buildLaunchItemFallbackDetail(itemRef);
        state.detailOverride = {
          ...itemRef,
          detail: fallbackDetail,
        };
        state.launchItemIntent.status = "resolved";
        return fallbackDetail;
      }
      ensureCurrentSelection();
      if (!state.currentItem) {
        return null;
      }
      return null;
    }
  }
}

function queueCurrentDetailLoad(itemRef = state.currentItem) {
  if (!itemRef || hasDetailOverride(itemRef)) {
    return;
  }
  if (state.currentDetailLoading && isSameItemRef(state.detailLoadingItem, itemRef)) {
    return;
  }

  const requestedItem = { ...itemRef };
  const requestId = ++detailLoadSequence;
  state.currentDetailLoading = true;
  state.detailLoadingItem = requestedItem;

  fetchCurrentDetailForItem(requestedItem)
    .then((detail) => {
      if (requestId !== detailLoadSequence) {
        return;
      }
      if (!detail) {
        if (!state.currentItem || !isSameItemRef(state.currentItem, requestedItem)) {
          return;
        }
        state.currentDetail = null;
        return;
      }
      if (!state.currentItem || !isSameItemRef(state.currentItem, requestedItem)) {
        return;
      }
      state.currentDetail = detail;
    })
    .finally(() => {
      if (requestId !== detailLoadSequence) {
        return;
      }
      state.currentDetailLoading = false;
      state.detailLoadingItem = null;
      renderCurrentSurface();
    });
}

function buildLaunchItemFallbackDetail(itemRef) {
  const itemStillVisible = allInboxEntries().some((entry) => isSameItemRef(itemRef, entry.item));
  const isHandled = !itemStillVisible;
  const body = resolveLaunchFallbackMessage(itemRef.kind, isHandled);
  return {
    kind: itemRef.kind,
    token: itemRef.token,
    title: state.currentDetail?.title || kindMeta(itemRef.kind).label,
    messageHtml: `<p>${escapeHtml(body)}</p><p>${escapeHtml(L("server.page.notFoundHint"))}</p>`,
    readOnly: true,
    actions: [],
  };
}

function resolveLaunchFallbackMessage(kind, isHandled) {
  if (kind === "approval") {
    return isHandled ? L("error.approvalAlreadyHandled") : L("error.approvalNotFound");
  }
  if (kind === "choice") {
    return isHandled ? L("error.choiceInputAlreadyHandled") : L("error.choiceInputNotFound");
  }
  return L("error.itemNotFound");
}

function shouldKeepDetailAfterAction(itemRef = state.currentItem) {
  return Boolean(itemRef && hasLaunchItemIntent(itemRef) && isFastPathItemRef(itemRef));
}

function pinActionOutcomeDetail(itemRef, detail) {
  if (!itemRef || !detail) {
    return;
  }
  state.currentItem = { ...itemRef };
  state.detailOverride = {
    ...itemRef,
    detail,
  };
  state.currentDetail = detail;
  state.detailOpen = true;
  if (hasLaunchItemIntent(itemRef)) {
    state.launchItemIntent.status = "resolved";
  }
}

function buildActionOutcomeDetail({ kind, title, message }) {
  return {
    kind,
    token: state.currentItem?.token || "",
    title: title || kindMeta(kind).label,
    messageHtml: `<p>${escapeHtml(message)}</p>`,
    readOnly: true,
    actions: [],
  };
}

function approvalOutcomeMessage(actionUrl) {
  return /\/accept$/u.test(String(actionUrl || ""))
    ? L("server.message.approvalAccepted")
    : L("server.message.approvalRejected");
}

function renderDesktopWorkspace(detail) {
  if (state.currentTab === "settings") {
    return `<section class="screen-block">${renderSettingsDetail({ mobile: false })}</section>`;
  }

  const entries = listEntriesForTab(state.currentTab);
  const shouldShowLoading =
    Boolean(state.currentItem) &&
    !detail &&
    (state.currentDetailLoading || !renderableCurrentDetail());
  return `
    <section class="desktop-workspace">
      <aside class="surface surface--list">
        ${renderListPanel({
          tab: state.currentTab,
          entries,
          desktop: true,
        })}
      </aside>
      <section class="surface surface--detail">
        ${detail ? renderDetailContent(detail, { mobile: false }) : shouldShowLoading ? renderDetailLoading({ mobile: false }) : renderDetailEmpty()}
      </section>
    </section>
  `;
}

function renderMobileWorkspace(detail) {
  if (state.currentTab === "settings") {
    return `<section class="screen-block ${isSettingsSubpageOpen() ? "screen-block--detail" : ""}">${renderSettingsDetail({ mobile: true })}</section>`;
  }

  if (state.detailOpen && detail) {
    return `<section class="screen-block screen-block--detail">${renderDetailContent(detail, { mobile: true })}</section>`;
  }

  if (state.detailOpen && state.currentItem) {
    return `<section class="screen-block screen-block--detail">${renderDetailLoading({ mobile: true })}</section>`;
  }

  return `
    <section class="screen-block">
      ${renderListPanel({
        tab: state.currentTab,
        entries: listEntriesForTab(state.currentTab),
        desktop: false,
      })}
    </section>
  `;
}

function renderListPanel({ tab, entries, desktop }) {
  if (tab === "timeline") {
    return renderTimelinePanel({ entries, desktop });
  }
  const meta = tabMeta(tab);
  const threadFilterHtml = tab === "completed" ? renderCompletedThreadDropdown() : "";
  if (!desktop) {
    return `
      <div class="screen-shell screen-shell--mobile">
        <div class="screen-header screen-header--mobile">
          <p class="screen-copy">${escapeHtml(meta.description)}</p>
          <span class="count-chip">${entries.length}</span>
        </div>
        ${threadFilterHtml}
        ${
          entries.length
            ? `<div class="card-list">
                ${entries.map((entry) => renderItemCard(entry, tab, false)).join("")}
              </div>`
            : renderEmptyList(tab)
        }
      </div>
    `;
  }

  return `
    <div class="screen-shell">
      <div class="screen-header">
        <div>
          <p class="screen-eyebrow">${escapeHtml(meta.eyebrow)}</p>
          <h2 class="screen-title">${escapeHtml(meta.title)}</h2>
        </div>
        <span class="count-chip">${entries.length}</span>
      </div>
      <p class="screen-copy">${escapeHtml(meta.description)}</p>
      ${threadFilterHtml}
      ${
        entries.length
          ? `<div class="card-list ${desktop ? "card-list--desktop" : ""}">
              ${entries.map((entry) => renderItemCard(entry, tab, true)).join("")}
            </div>`
          : renderEmptyList(tab)
      }
    </div>
  `;
}

function renderItemCard(entry, sourceTab, desktop) {
  if (entry.status === "completed" && entry.item.kind === "completion") {
    return renderCompletedCompletionCard(entry, sourceTab);
  }
  const kindInfo = kindMeta(entry.item.kind);
  const cardTitle = cardTitleForEntry(entry);
  const statusText = entry.status === "completed" ? L("common.completed") : L("common.actionNeeded");
  const intentText = itemIntentText(entry.item.kind, entry.status);
  const showCompletedTimestamp = entry.status === "completed" && sourceTab === "completed";
  const timestampLabel = showCompletedTimestamp ? formatTimelineTimestamp(entry.item.createdAtMs) : "";
  return `
    <button
      class="item-card item-card--${escapeHtml(kindInfo.tone)}"
      data-open-item-kind="${escapeHtml(entry.item.kind)}"
      data-open-item-token="${escapeHtml(entry.item.token)}"
      data-source-tab="${escapeHtml(sourceTab)}"
    >
      <div class="item-card__header">
        <div class="item-card__meta">
          <span class="type-pill type-pill--${escapeHtml(kindInfo.tone)}">${escapeHtml(kindInfo.label)}</span>
          ${
            desktop && sourceTab === "inbox"
              ? `<span class="status-pill status-pill--${escapeHtml(entry.status)}">${escapeHtml(statusText)}</span>`
              : ""
          }
        </div>
        <div class="item-card__header-right">
          ${timestampLabel ? `<span class="item-card__timestamp">${escapeHtml(timestampLabel)}</span>` : ""}
          <span class="item-card__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </div>
      </div>
      <div class="item-card__content">
        <h3 class="item-card__title">${escapeHtml(cardTitle || L("common.untitledItem"))}</h3>
        <p class="item-card__intent">
          <span class="item-card__intent-icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
          <span>${escapeHtml(intentText)}</span>
        </p>
        <p class="item-card__summary">${escapeHtml(entry.item.summary || fallbackSummaryForKind(entry.item.kind, entry.status))}</p>
        ${
          !desktop && sourceTab === "inbox"
            ? `<p class="item-card__status-note">${escapeHtml(statusText)}</p>`
            : ""
        }
      </div>
    </button>
  `;
}

function cardTitleForEntry(entry) {
  const item = entry?.item || {};
  const rawTitle = normalizeClientText(item.title || "");
  if (!rawTitle) {
    return "";
  }
  if (item.kind !== "approval") {
    return rawTitle;
  }

  const threadLabel = resolvedThreadLabel(item.threadId || "", item.threadLabel || "");
  if (threadLabel) {
    return threadLabel;
  }

  const approvalPrefix = `${normalizeClientText(kindMeta("approval").label)} | `;
  if (approvalPrefix.trim() && rawTitle.startsWith(approvalPrefix)) {
    return normalizeClientText(rawTitle.slice(approvalPrefix.length)) || rawTitle;
  }
  return rawTitle;
}

function renderCompletedCompletionCard(entry, sourceTab) {
  const item = entry.item;
  const kindInfo = kindMeta(item.kind);
  const summaryText = item.summary || fallbackSummaryForKind(item.kind, entry.status);
  const threadLabel = timelineEntryThreadLabel(item, true);
  const timestampLabel = formatTimelineTimestamp(item.createdAtMs);

  return `
    <button
      class="item-card item-card--${escapeHtml(kindInfo.tone)} item-card--completion-readonly"
      data-open-item-kind="${escapeHtml(item.kind)}"
      data-open-item-token="${escapeHtml(item.token)}"
      data-source-tab="${escapeHtml(sourceTab)}"
    >
      <div class="item-card__header">
        <div class="item-card__meta">
          <span class="type-pill type-pill--completion">${escapeHtml(L("common.task"))}</span>
        </div>
        <div class="item-card__header-right">
          ${timestampLabel ? `<span class="item-card__timestamp">${escapeHtml(timestampLabel)}</span>` : ""}
          <span class="item-card__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </div>
      </div>
      <div class="item-card__content">
        ${threadLabel ? `<p class="item-card__thread">${escapeHtml(threadLabel)}</p>` : ""}
        <h3 class="item-card__title">${escapeHtml(summaryText || L("common.untitledItem"))}</h3>
      </div>
    </button>
  `;
}

function renderTimelinePanel({ entries, desktop }) {
  const meta = tabMeta("timeline");
  const listClassName = desktop ? "timeline-list timeline-list--desktop" : "timeline-list";
  const threadsHtml = renderTimelineThreadDropdown();
  const bodyHtml = entries.length
    ? `<div class="${listClassName}">${entries.map((entry) => renderTimelineEntry(entry, { desktop })).join("")}</div>`
    : renderEmptyList("timeline");

  if (!desktop) {
    return `
      <div class="screen-shell screen-shell--mobile timeline-shell timeline-shell--mobile">
        <div class="screen-header screen-header--mobile">
          <p class="screen-copy">${escapeHtml(meta.description)}</p>
          <span class="count-chip">${entries.length}</span>
        </div>
        ${threadsHtml}
        ${bodyHtml}
      </div>
    `;
  }

  return `
    <div class="screen-shell timeline-shell">
      <div class="screen-header">
        <div>
          <p class="screen-eyebrow">${escapeHtml(meta.eyebrow)}</p>
          <h2 class="screen-title">${escapeHtml(meta.title)}</h2>
        </div>
        <span class="count-chip">${entries.length}</span>
      </div>
      <p class="screen-copy">${escapeHtml(meta.description)}</p>
      ${threadsHtml}
      ${bodyHtml}
    </div>
  `;
}

function renderTimelineThreadDropdown() {
  const threads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
  return renderThreadDropdown({
    inputId: "timeline-thread-select",
    dataAttribute: "data-timeline-thread-select",
    selectedThreadId: state.timelineThreadFilter,
    threads: threads.map((thread) => ({
      id: thread.id,
      label: dropdownThreadLabel(thread.id, thread.label || ""),
    })),
  });
}

function renderCompletedThreadDropdown() {
  return renderThreadDropdown({
    inputId: "completed-thread-select",
    dataAttribute: "data-completed-thread-select",
    selectedThreadId: state.completedThreadFilter,
    threads: completedThreads(),
  });
}

function renderThreadDropdown({ inputId, dataAttribute, selectedThreadId, threads }) {
  const options = [
    {
      id: "all",
      label: L("timeline.allThreads"),
    },
    ...threads.map((thread) => ({
      id: thread.id,
      label: dropdownThreadLabel(thread.id, thread.label || ""),
    })),
  ];

  return `
    <div class="timeline-thread-filter">
      <label class="timeline-thread-filter__label" for="${escapeHtml(inputId)}">${escapeHtml(L("timeline.filterLabel"))}</label>
      <div class="timeline-thread-select-wrap">
        <select id="${escapeHtml(inputId)}" class="timeline-thread-select" ${dataAttribute}>
          ${options
            .map(
              (thread) => `
                <option value="${escapeHtml(thread.id)}" ${selectedThreadId === thread.id ? "selected" : ""}>
                  ${escapeHtml(thread.label)}
                </option>
              `
            )
            .join("")}
        </select>
        <span class="timeline-thread-select__chevron" aria-hidden="true">${renderIcon("chevron-down")}</span>
      </div>
    </div>
  `;
}

function renderTimelineEntry(entry, { desktop }) {
  const item = entry.item;
  const kindInfo = kindMeta(item.kind);
  const kindClassName = escapeHtml(kindInfo.tone || "neutral");
  const kindNameClass = escapeHtml(String(item.kind || "item").replace(/_/gu, "-"));
  const isMessageLike = TIMELINE_MESSAGE_KINDS.has(item.kind) || item.kind === "completion";
  const primaryText = isMessageLike
    ? item.summary || fallbackSummaryForKind(item.kind, entry.status)
    : item.title || L("common.untitledItem");
  const secondaryText = isMessageLike ? "" : item.summary || fallbackSummaryForKind(item.kind, entry.status);
  const threadLabel = timelineEntryThreadLabel(item, isMessageLike);
  const timestampLabel = formatTimelineTimestamp(item.createdAtMs);
  const statusLabel = isMessageLike ? "" : L("common.actionNeeded");

  return `
    <button
      class="timeline-entry timeline-entry--${kindClassName} timeline-entry--kind-${kindNameClass} ${isMessageLike ? "timeline-entry--message" : "timeline-entry--operational"}"
      data-open-item-kind="${escapeHtml(item.kind)}"
      data-open-item-token="${escapeHtml(item.token)}"
      data-source-tab="timeline"
    >
      <div class="timeline-entry__meta">
        <span class="timeline-entry__kind">
          <span class="timeline-entry__kind-icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
          <span>${escapeHtml(kindInfo.label)}</span>
        </span>
        <span class="timeline-entry__meta-right">
          <span class="timeline-entry__time">${escapeHtml(timestampLabel)}</span>
          <span class="timeline-entry__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
        </span>
      </div>
      ${threadLabel ? `<p class="timeline-entry__thread">${escapeHtml(threadLabel)}</p>` : ""}
      <div class="timeline-entry__body">
        <p class="timeline-entry__title">${escapeHtml(primaryText)}</p>
        ${secondaryText ? `<p class="timeline-entry__summary">${escapeHtml(secondaryText)}</p>` : ""}
      </div>
      ${statusLabel ? `<div class="timeline-entry__footer"><span class="timeline-entry__status">${escapeHtml(statusLabel)}</span></div>` : ""}
    </button>
  `;
}

function timelineEntryThreadLabel(item, isMessage) {
  const threadLabel = resolvedThreadLabel(item.threadId || "", item.threadLabel || "");
  if (!threadLabel) {
    return "";
  }
  if (isMessage) {
    return threadLabel;
  }
  const title = normalizeClientText(item.title || "");
  return title.includes(threadLabel) ? "" : threadLabel;
}

function resolvedThreadLabel(threadId, explicitLabel = "") {
  const normalizedLabel = normalizeClientText(explicitLabel || "");
  if (normalizedLabel) {
    return normalizedLabel;
  }
  const normalizedThreadId = normalizeClientText(threadId || "");
  if (!normalizedThreadId) {
    return "";
  }
  const timelineThreads = Array.isArray(state.timeline?.threads) ? state.timeline.threads : [];
  const matchingThread = timelineThreads.find((thread) => thread.id === normalizedThreadId);
  const fallbackLabel = normalizeClientText(matchingThread?.label || "");
  return fallbackLabel || "";
}

function dropdownThreadLabel(threadId, explicitLabel = "") {
  return resolvedThreadLabel(threadId, explicitLabel) || L("timeline.unknownThread");
}

function formatTimelineTimestamp(value) {
  const createdAtMs = Number(value) || 0;
  if (!createdAtMs) {
    return "";
  }
  const date = new Date(createdAtMs);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const options = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(state.locale || DEFAULT_LOCALE, options).format(date);
  } catch {
    return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
  }
}

function formatSettingsTimestamp(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) {
    return L("common.unavailable");
  }
  try {
    return new Intl.DateTimeFormat(state.locale || DEFAULT_LOCALE, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function renderSettingsDetail({ mobile }) {
  const context = buildSettingsContext();
  if (state.settingsSubpage) {
    return renderSettingsSubpage(context, { mobile });
  }
  return renderSettingsRoot(context, { mobile });
}

function buildSettingsContext() {
  const push = state.pushStatus || {};
  const permission = push.notificationPermission || "default";
  const secureContext = push.secureContext === true;
  const standalone = push.standalone === true;
  const supportsPushValue = push.supportsPush === true;
  const serverEnabled = push.enabled === true;
  const canEnable =
    serverEnabled &&
    supportsPushValue &&
    secureContext &&
    standalone &&
    permission !== "denied" &&
    push.serverSubscribed !== true;
  const setupState = buildSettingsSetupState({
    serverEnabled,
    secureContext,
    standalone,
    supportsPushValue,
    permission,
    subscribed: push.serverSubscribed === true,
  });

  return {
    push,
    permission,
    secureContext,
    standalone,
    supportsPushValue,
    serverEnabled,
    canEnable,
    setupState,
    devices: Array.isArray(state.devices) ? state.devices : [],
    devicesError: state.deviceError,
    diagnostics: collectSettingsDiagnostics({
      push,
      permission,
      secureContext,
      standalone,
      supportsPushValue,
      serverEnabled,
    }),
  };
}

function buildSettingsSetupState({ serverEnabled, secureContext, standalone, supportsPushValue, permission, subscribed }) {
  const notifications = (() => {
    if (!serverEnabled) {
      return { tone: "muted", labelKey: "settings.status.notAvailable", copyKey: "settings.notifications.serverDisabled" };
    }
    if (!supportsPushValue) {
      return { tone: "muted", labelKey: "settings.status.unsupported", copyKey: "error.pushUnsupported" };
    }
    if (!secureContext) {
      return { tone: "warning", labelKey: "settings.status.needsHttps", copyKey: "settings.notifications.openHttps" };
    }
    if (!standalone) {
      return { tone: "warning", labelKey: "settings.status.needsHomeScreen", copyKey: "settings.notifications.openHomeScreen" };
    }
    if (permission === "denied") {
      return { tone: "danger", labelKey: "settings.status.blocked", copyKey: "banner.push.copy.denied" };
    }
    if (subscribed) {
      return { tone: "success", labelKey: "settings.status.ready", copyKey: "notice.notificationsEnabled" };
    }
    return { tone: "warning", labelKey: "settings.status.actionNeeded", copyKey: "banner.push.copy.default" };
  })();

  const install = standalone
    ? { tone: "success", labelKey: "settings.status.installed" }
    : { tone: "warning", labelKey: "settings.status.notInstalled" };

  const pairing = { tone: "success", labelKey: "settings.status.connected" };

  let nextStep = {
    titleKey: "settings.nextStep.enableNotifications.title",
    copyKey: "settings.nextStep.enableNotifications.copy",
  };
  let primaryAction = { kind: "push-enable", disabled: false };

  if (!serverEnabled) {
    nextStep = {
      titleKey: "settings.nextStep.serverDisabled.title",
      copyKey: "settings.nextStep.serverDisabled.copy",
    };
    primaryAction = { kind: "open-technical" };
  } else if (!secureContext) {
    nextStep = {
      titleKey: "settings.nextStep.openHttps.title",
      copyKey: "settings.nextStep.openHttps.copy",
    };
    primaryAction = { kind: "none" };
  } else if (!standalone) {
    nextStep = {
      titleKey: "settings.nextStep.install.title",
      copyKey: "settings.nextStep.install.copy",
    };
    primaryAction = { kind: "install-guide" };
  } else if (permission === "denied") {
    nextStep = {
      titleKey: "settings.nextStep.permissionBlocked.title",
      copyKey: "settings.nextStep.permissionBlocked.copy",
    };
    primaryAction = { kind: "none" };
  } else if (subscribed) {
    nextStep = {
      titleKey: "settings.nextStep.test.title",
      copyKey: "settings.nextStep.test.copy",
    };
    primaryAction = { kind: "push-test" };
  }

  return {
    notifications,
    install,
    pairing,
    nextStep,
    primaryAction,
  };
}

function collectSettingsDiagnostics({ permission, secureContext, standalone, supportsPushValue, serverEnabled }) {
  const issues = [];
  if (!serverEnabled) {
    issues.push(L("settings.notifications.serverDisabled"));
  }
  if (!supportsPushValue) {
    issues.push(L("error.pushUnsupported"));
  }
  if (!secureContext) {
    issues.push(L("settings.notifications.openHttps"));
  }
  if (secureContext && !standalone) {
    issues.push(L("settings.notifications.openHomeScreen"));
  }
  if (permission === "denied") {
    issues.push(L("banner.push.copy.denied"));
  }
  if (state.pushError) {
    issues.push(state.pushError);
  }
  return Array.from(new Set(issues.filter(Boolean)));
}

function settingsPageMeta(page) {
  switch (page) {
    case "notifications":
      return {
        id: "notifications",
        title: L("settings.notifications.title"),
        description: L("settings.notifications.copy"),
        icon: "notifications",
      };
    case "language":
      return {
        id: "language",
        title: L("settings.language.title"),
        description: L("settings.language.copy"),
        icon: "language",
      };
    case "install":
      return {
        id: "install",
        title: L("settings.install.title"),
        description: L("settings.install.copy"),
        icon: "homescreen",
      };
    case "device":
      return {
        id: "device",
        title: L("settings.device.title"),
        description: L("settings.device.copy"),
        icon: "iphone",
      };
    case "advanced":
      return {
        id: "advanced",
        title: L("settings.technical.title"),
        description: L("settings.technical.copy"),
        icon: "settings",
      };
    default:
      return settingsPageMeta("notifications");
  }
}

function renderSettingsRoot(context, { mobile }) {
  const languageValue = localeDisplayName(state.locale, state.locale) || state.locale;
  const generalRows = [
    renderSettingsNavRow({
      page: "notifications",
      icon: "notifications",
      title: L("settings.notifications.title"),
      value: L(context.setupState.notifications.labelKey),
    }),
    renderSettingsNavRow({
      page: "language",
      icon: "language",
      title: L("settings.language.title"),
      value: languageValue,
    }),
    !context.standalone
      ? renderSettingsNavRow({
          page: "install",
          icon: "homescreen",
          title: L("settings.install.title"),
          value: L(context.setupState.install.labelKey),
        })
      : "",
  ].filter(Boolean);
  const deviceRows = [
    renderSettingsNavRow({
      page: "device",
      icon: "iphone",
      title: L("settings.device.title"),
      value: context.devices.length
        ? L("settings.device.count", { count: context.devices.length })
        : L("settings.pairing.connected"),
    }),
  ];
  const advancedRows = [
    renderSettingsNavRow({
      page: "advanced",
      icon: "settings",
      title: L("settings.technical.title"),
      value: context.diagnostics.length ? L("settings.status.actionNeeded") : L("settings.status.info"),
    }),
  ];

  return `
    <div class="settings-screen">
      ${
        mobile
          ? ""
          : `
            <div class="screen-header">
              <div>
                <p class="screen-eyebrow">${escapeHtml(L("tab.settings.eyebrow"))}</p>
                <h2 class="screen-title">${escapeHtml(L("tab.settings.title"))}</h2>
              </div>
            </div>
          `
      }
      ${renderSettingsGroup(L("settings.group.general"), generalRows)}
      ${renderSettingsGroup(L("settings.pairing.title"), deviceRows)}
      ${renderSettingsGroup(L("settings.group.advanced"), advancedRows)}
    </div>
  `;
}

function renderSettingsSubpage(context, { mobile }) {
  const page = settingsPageMeta(state.settingsSubpage);
  const desktopHeader = !mobile
    ? `
      <div class="settings-page-header">
        <button class="secondary settings-inline-back" type="button" data-settings-back>
          <span aria-hidden="true">${renderIcon("back")}</span>
          <span>${escapeHtml(L("common.back"))}</span>
        </button>
        <div>
          <p class="screen-eyebrow">${escapeHtml(L("common.settings"))}</p>
          <h2 class="screen-title">${escapeHtml(page.title)}</h2>
        </div>
      </div>
    `
    : "";

  let content = "";
  switch (state.settingsSubpage) {
    case "notifications":
      content = renderSettingsNotificationsPage(context);
      break;
    case "language":
      content = renderSettingsLanguagePage();
      break;
    case "install":
      content = renderSettingsInstallPage();
      break;
    case "device":
      content = renderSettingsDevicePage(context);
      break;
    case "advanced":
      content = renderSettingsAdvancedPage(context);
      break;
    default:
      content = "";
  }

  return `
    <div class="settings-screen settings-screen--subpage">
      ${desktopHeader}
      <p class="settings-page-copy muted">${escapeHtml(page.description)}</p>
      ${content}
    </div>
  `;
}

function renderSettingsNotificationsPage(context) {
  const { push, permission, secureContext, standalone, supportsPushValue, serverEnabled } = context;
  const statusRows = [
    renderSettingsInfoRow(L("settings.row.status"), L(context.setupState.notifications.labelKey)),
    renderSettingsInfoRow(L("settings.row.notificationPermission"), permission),
    renderSettingsInfoRow(L("settings.row.currentDeviceSubscribed"), push.serverSubscribed ? L("common.yes") : L("common.no")),
    push.lastSuccessfulDeliveryAtMs
      ? renderSettingsInfoRow(
          L("settings.row.lastSuccessfulDelivery"),
          new Date(push.lastSuccessfulDeliveryAtMs).toLocaleString(state.locale)
        )
      : "",
  ].filter(Boolean);
  return `
    <div class="settings-page">
      ${renderSettingsGroup("", statusRows)}
      ${renderSettingsGroup(L("settings.group.advanced"), [
        renderSettingsInfoRow(L("settings.row.serverWebPush"), serverEnabled ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.secureContext"), secureContext ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.homeScreenApp"), standalone ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.browserSupport"), supportsPushValue ? L("common.yes") : L("common.no")),
      ])}
      ${state.pushNotice ? `<p class="inline-alert inline-alert--success">${escapeHtml(state.pushNotice)}</p>` : ""}
      ${state.pushError ? `<p class="inline-alert inline-alert--danger">${escapeHtml(state.pushError)}</p>` : ""}
      ${renderSettingsActionPanel(renderSettingsNotificationActions({
        push,
        canEnable: context.canEnable,
        standalone,
      }), L("settings.group.actions"))}
    </div>
  `;
}

function renderSettingsLanguagePage() {
  const overrideLocale = normalizeLocale(state.session?.deviceOverrideLocale || "");
  const options = [
    { value: "", label: L("common.useDeviceLanguage") },
    { value: "en", label: localeDisplayName("en", state.locale) },
    { value: "ja", label: localeDisplayName("ja", state.locale) },
  ];

  return `
    <div class="settings-page">
      ${renderSettingsGroup("", options.map(({ value, label }) => {
        const isSelected = (value || "") === overrideLocale;
        return `
          <button class="settings-choice-row" type="button" data-locale-option="${escapeHtml(value)}" aria-pressed="${isSelected ? "true" : "false"}">
            <span class="settings-row__body">
              <span class="settings-row__title">${escapeHtml(label)}</span>
            </span>
            <span class="settings-choice-row__check" aria-hidden="true">${isSelected ? renderIcon("check") : ""}</span>
          </button>
        `;
      }), { listClassName: "settings-list settings-list--compact" })}
      ${renderSettingsGroup(L("settings.group.values"), [
        renderSettingsInfoRow(L("settings.row.currentLanguage"), localeDisplayName(state.locale, state.locale) || state.locale),
        renderSettingsInfoRow(L("settings.row.languageSource"), L(`language.source.${state.localeSource}`)),
        renderSettingsInfoRow(L("settings.row.defaultLanguage"), localeDisplayName(state.defaultLocale, state.locale) || state.defaultLocale),
      ], { listClassName: "settings-list settings-list--compact" })}
    </div>
  `;
}

function renderSettingsInstallPage() {
  return `
    <div class="settings-page">
      <section class="settings-copy-block">
        <p class="muted">${escapeHtml(L("settings.install.copy"))}</p>
      </section>
      ${renderSettingsActionPanel(
        `<button class="primary primary--wide" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>`
      , L("settings.group.actions"))}
    </div>
  `;
}

function renderSettingsDevicePage(context) {
  const devices = Array.isArray(context.devices) ? context.devices : [];
  const currentDevice = devices.find((device) => device.currentDevice) || null;
  const otherDevices = devices.filter((device) => !device.currentDevice);
  return `
    <div class="settings-page">
      ${state.deviceNotice ? `<p class="inline-alert inline-alert--success">${escapeHtml(state.deviceNotice)}</p>` : ""}
      ${(state.deviceError || context.devicesError) ? `<p class="inline-alert inline-alert--danger">${escapeHtml(state.deviceError || context.devicesError)}</p>` : ""}
      ${renderDeviceSection(L("settings.device.section.current"), currentDevice ? [currentDevice] : [], L("settings.device.emptyCurrent"))}
      ${renderDeviceSection(L("settings.device.section.other"), otherDevices, L("settings.device.emptyOther"))}
      <section class="settings-group">
        <p class="settings-group__title">${escapeHtml(L("settings.device.addAnother.title"))}</p>
        <div class="settings-copy-block settings-copy-block--stacked">
          <div class="helper-copy">
            <strong>${escapeHtml(L("settings.device.addAnother.heading"))}</strong>
            <p class="muted">${escapeHtml(L("settings.device.addAnother.copy"))}</p>
          </div>
          <div class="settings-command-card">
            <span class="settings-command-card__label">${escapeHtml(L("settings.device.addAnother.commandLabel"))}</span>
            <code class="settings-command-card__value">npx viveworker setup --pair</code>
          </div>
        </div>
      </section>
      ${renderSettingsActionPanel(
        `<button class="secondary secondary--wide" type="button" data-open-logout-confirm>${escapeHtml(L("common.logOut"))}</button>`,
        L("settings.group.actions")
      )}
    </div>
  `;
}

function renderSettingsAdvancedPage(context) {
  return `
    <div class="settings-page">
      ${context.diagnostics.map((message) => `<p class="inline-alert">${escapeHtml(message)}</p>`).join("")}
      ${renderSettingsGroup("", [
        renderSettingsInfoRow(L("settings.row.serverWebPush"), context.serverEnabled ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.secureContext"), context.secureContext ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.homeScreenApp"), context.standalone ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.notificationPermission"), context.permission),
        renderSettingsInfoRow(L("settings.row.browserSupport"), context.supportsPushValue ? L("common.yes") : L("common.no")),
        renderSettingsInfoRow(L("settings.row.currentDeviceSubscribed"), context.push.serverSubscribed ? L("common.yes") : L("common.no")),
        context.push.lastSuccessfulDeliveryAtMs
          ? renderSettingsInfoRow(
              L("settings.row.lastSuccessfulDelivery"),
              new Date(context.push.lastSuccessfulDeliveryAtMs).toLocaleString(state.locale)
            )
          : "",
        renderSettingsInfoRow(L("settings.row.version"), state.appVersion || L("common.unavailable")),
      ].filter(Boolean), { listClassName: "settings-list settings-list--compact" })}
    </div>
  `;
}

function renderSettingsNotificationActions({ push, canEnable, standalone }) {
  if (push.serverSubscribed) {
    return `
      <button class="primary primary--wide" data-push-action="test">${escapeHtml(L("settings.action.sendTest"))}</button>
      <button class="secondary secondary--wide" data-push-action="disable">${escapeHtml(L("settings.action.disableNotifications"))}</button>
    `;
  }

  if (!push.enabled || push.supportsPush === false || push.secureContext === false) {
    return `<button class="secondary secondary--wide" type="button" data-open-technical>${escapeHtml(L("settings.action.reviewTechnical"))}</button>`;
  }

  if (push.notificationPermission === "denied") {
    return `<button class="secondary secondary--wide" type="button" data-open-technical>${escapeHtml(L("settings.action.reviewTechnical"))}</button>`;
  }

  if (!standalone) {
    return `<button class="secondary secondary--wide" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>`;
  }

  return `<button class="primary primary--wide" data-push-action="enable" ${canEnable ? "" : "disabled"}>${escapeHtml(L("settings.action.enableNotifications"))}</button>`;
}

function renderSettingsGroup(title, rows, options = {}) {
  const listClassName = options.listClassName || "settings-list";
  return `
    <section class="settings-group">
      ${title ? `<p class="settings-group__title">${escapeHtml(title)}</p>` : ""}
      <div class="${escapeHtml(listClassName)}">
        ${rows.join("")}
      </div>
    </section>
  `;
}

function renderSettingsNavRow({ page, icon, title, subtitle, value }) {
  return `
    <button class="settings-nav-row" type="button" data-settings-subpage="${escapeHtml(page)}">
      <span class="settings-row__icon" aria-hidden="true">${renderIcon(icon)}</span>
      <span class="settings-row__body">
        <span class="settings-row__title">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="settings-row__subtitle">${escapeHtml(subtitle)}</span>` : ""}
      </span>
      <span class="settings-row__value">${escapeHtml(value || "")}</span>
      <span class="settings-row__chevron" aria-hidden="true">${renderIcon("chevron-right")}</span>
    </button>
  `;
}

function renderSettingsInfoRow(label, value, options = {}) {
  const rowClassName = ["settings-info-row", options.rowClassName || ""].filter(Boolean).join(" ");
  const valueClassName = ["settings-info-row__value", options.valueClassName || ""].filter(Boolean).join(" ");
  return `
    <div class="${rowClassName}">
      <span class="settings-info-row__label">${escapeHtml(label)}</span>
      <span class="${valueClassName}">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderSettingsActionPanel(content, title = "") {
  return `
    <section class="settings-group">
      ${title ? `<p class="settings-group__title">${escapeHtml(title)}</p>` : ""}
      <div class="settings-action-panel">
        <div class="actions actions--stack">
          ${content}
        </div>
      </div>
    </section>
  `;
}

function renderDeviceSection(title, devices, emptyMessage) {
  return `
    <section class="settings-group">
      <p class="settings-group__title">${escapeHtml(title)}</p>
      ${
        devices.length
          ? `<div class="device-list">
              ${devices.map((device) => renderTrustedDeviceCard(device)).join("")}
            </div>`
          : `<div class="settings-copy-block"><p class="muted">${escapeHtml(emptyMessage)}</p></div>`
      }
    </section>
  `;
}

function renderTrustedDeviceCard(device) {
  const localeLabel = localeDisplayName(device.locale, state.locale) || device.locale || L("common.unavailable");
  const pushLabel = device.pushSubscribed ? L("common.yes") : L("common.no");
  const badge = device.currentDevice
    ? `<span class="device-card__badge">${escapeHtml(L("settings.device.thisDevice"))}</span>`
    : "";
  const actionLabel = device.currentDevice
    ? L("settings.action.removeThisDevice")
    : L("settings.action.revokeDevice");

  return `
    <article class="device-card">
      <div class="device-card__header">
        <div class="device-card__title-wrap">
          <div class="device-card__headline">
            <span class="device-card__icon" aria-hidden="true">${renderIcon(device.standalone ? "homescreen" : "iphone")}</span>
            <h3 class="device-card__title">${escapeHtml(device.displayName || L("settings.device.fallbackName"))}</h3>
          </div>
          <p class="device-card__subtitle">${escapeHtml(device.deviceId || "")}</p>
        </div>
        ${badge}
      </div>
      <div class="device-card__meta">
        ${renderDeviceMetaRow(L("settings.row.lastUsed"), formatSettingsTimestamp(device.lastAuthenticatedAtMs))}
        ${renderDeviceMetaRow(L("settings.row.pairedAt"), formatSettingsTimestamp(device.pairedAtMs))}
        ${renderDeviceMetaRow(L("settings.row.trustedUntil"), formatSettingsTimestamp(device.trustedUntilMs))}
        ${renderDeviceMetaRow(L("settings.row.pushStatus"), pushLabel)}
        ${renderDeviceMetaRow(L("settings.row.currentLanguage"), localeLabel)}
      </div>
      <div class="device-card__actions">
        <button
          class="secondary secondary--wide"
          type="button"
          data-device-revoke="${escapeHtml(device.deviceId)}"
          data-device-current="${device.currentDevice ? "true" : "false"}"
        >${escapeHtml(actionLabel)}</button>
      </div>
    </article>
  `;
}

function renderDeviceMetaRow(label, value) {
  return `
    <div class="device-card__meta-row">
      <span class="device-card__meta-label">${escapeHtml(label)}</span>
      <span class="device-card__meta-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderDetailContent(detail, { mobile }) {
  if (mobile) {
    if (detail.kind === "choice" && detail.supported) {
      return renderChoiceDetailMobile(detail);
    }
    return renderStandardDetailMobile(detail);
  }

  if (detail.kind === "choice" && detail.supported) {
    return renderChoiceDetailDesktop(detail);
  }

  return renderStandardDetailDesktop(detail);
}

function renderStandardDetailDesktop(detail) {
  const kindInfo = kindMeta(detail.kind);
  const spaciousBodyDetail = TIMELINE_MESSAGE_KINDS.has(detail.kind) || detail.kind === "completion";
  return `
    <div class="detail-shell">
      ${renderDetailMetaRow(detail, kindInfo)}
      <h2 class="detail-title detail-title--desktop">${escapeHtml(detailDisplayTitle(detail))}</h2>
      ${detail.readOnly ? "" : renderDetailLead(detail, kindInfo)}
      ${renderPreviousContextCard(detail)}
      <section class="detail-card detail-card--body ${spaciousBodyDetail ? "detail-card--message-body" : ""}">
        <div class="detail-body ${spaciousBodyDetail ? "detail-body--message " : ""}markdown">${detail.messageHtml || ""}</div>
      </section>
      ${renderCompletionReplyComposer(detail)}
      ${detail.readOnly ? "" : renderActionButtons(detail.actions || [])}
    </div>
  `;
}

function renderStandardDetailMobile(detail) {
  const kindInfo = kindMeta(detail.kind);
  const spaciousBodyDetail = TIMELINE_MESSAGE_KINDS.has(detail.kind) || detail.kind === "completion";
  return `
    <div class="mobile-detail-screen">
      <div class="detail-shell detail-shell--mobile">
        <div class="mobile-detail-scroll mobile-detail-scroll--detail">
          ${renderDetailMetaRow(detail, kindInfo, { mobile: true })}
          ${renderPreviousContextCard(detail, { mobile: true })}
          <section class="detail-card detail-card--body detail-card--mobile ${spaciousBodyDetail ? "detail-card--message-body" : ""}">
            ${detail.readOnly ? "" : renderDetailLead(detail, kindInfo, { mobile: true })}
            <div class="detail-body ${spaciousBodyDetail ? "detail-body--message " : ""}markdown">${detail.messageHtml || ""}</div>
          </section>
          ${renderCompletionReplyComposer(detail, { mobile: true })}
        </div>
        ${detail.readOnly ? "" : renderActionButtons(detail.actions || [], { mobileSticky: true })}
      </div>
    </div>
  `;
}

function renderDetailMetaRow(detail, kindInfo, options = {}) {
  const timestampLabel = detail.createdAtMs ? formatTimelineTimestamp(detail.createdAtMs) : "";
  const progressPill = options.progressLabel
    ? `<span class="status-pill status-pill--pending">${escapeHtml(options.progressLabel)}</span>`
    : detail.readOnly
      ? ""
      : `<span class="status-pill status-pill--pending">${escapeHtml(L("common.actionable"))}</span>`;
  return `
    <section class="detail-meta-row ${options.mobile ? "detail-meta-row--mobile" : ""}">
      <div class="detail-meta-row__left">
        <span class="type-pill type-pill--${escapeHtml(kindInfo.tone)}">${renderTypePillContent(kindInfo)}</span>
        ${progressPill}
      </div>
      ${timestampLabel ? `<span class="detail-meta-row__time">${escapeHtml(timestampLabel)}</span>` : ""}
    </section>
  `;
}

function renderDetailLead(detail, kindInfo, options = {}) {
  return `
    <p class="detail-lead ${options.mobile ? "detail-lead--mobile" : ""}">
      <span class="detail-lead__icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
      <span>${escapeHtml(detailIntentText(detail))}</span>
    </p>
  `;
}

function renderPreviousContextCard(detail, options = {}) {
  const context = detail?.previousContext;
  if (!context?.messageHtml || detail.kind !== "approval") {
    return "";
  }

  const contextKind = kindMeta(context.kind || "assistant_commentary");
  const timestampLabel = context.createdAtMs ? formatTimelineTimestamp(context.createdAtMs) : "";
  return `
    <section class="detail-card detail-card--context ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="detail-context-card__header">
        <div class="detail-context-card__eyebrow">
          <span class="detail-context-card__icon" aria-hidden="true">${renderIcon(contextKind.icon)}</span>
          <span>${escapeHtml(L("detail.previousMessage"))}</span>
        </div>
        ${timestampLabel ? `<span class="detail-context-card__time">${escapeHtml(timestampLabel)}</span>` : ""}
      </div>
      <p class="detail-context-card__kind">${escapeHtml(contextKind.label)}</p>
      <div class="detail-body detail-body--context markdown">${context.messageHtml}</div>
    </section>
  `;
}

function renderCompletionReplyComposer(detail, options = {}) {
  if (detail.kind !== "completion" || detail.reply?.enabled !== true) {
    return "";
  }

  const draft = getCompletionReplyDraft(detail.token);
  const planMode = draft.mode === "plan";
  const sendLabel = draft.sending
    ? L("reply.sendSending")
    : draft.confirmOverride
      ? L("reply.sendConfirm")
      : L("reply.send");
  const disabled = draft.sending || !normalizeClientText(draft.text);
  const warningTimestamp = draft.warning?.createdAtMs ? formatTimelineTimestamp(draft.warning.createdAtMs) : "";
  const showCollapsedState =
    draft.collapsedAfterSend && Boolean(draft.notice) && !draft.error && !draft.warning && !draft.sending;
  const attachmentName = draft.attachment?.name ? escapeHtml(draft.attachment.name) : "";
  const attachmentPreviewUrl = draft.attachment?.previewUrl ? escapeHtml(draft.attachment.previewUrl) : "";

  return `
    <section class="detail-card detail-card--reply ${options.mobile ? "detail-card--mobile" : ""}">
      <div class="reply-composer">
        <div class="reply-composer__copy">
          <span class="eyebrow-pill eyebrow-pill--quiet">${escapeHtml(L("reply.eyebrow"))}</span>
          <h3 class="reply-composer__title">${escapeHtml(L("reply.title"))}</h3>
          <p class="muted reply-composer__description">${escapeHtml(L("reply.copy"))}</p>
        </div>
        ${draft.notice ? `<p class="inline-alert inline-alert--success">${escapeHtml(draft.notice)}</p>` : ""}
        ${draft.error ? `<p class="inline-alert inline-alert--danger">${escapeHtml(draft.error)}</p>` : ""}
        ${
          draft.warning
            ? `
              <div class="inline-alert inline-alert--warning reply-warning">
                <p class="reply-warning__title">${escapeHtml(L("reply.warning.title"))}</p>
                <p class="reply-warning__copy">${escapeHtml(L("reply.warning.copy"))}</p>
                ${
                  draft.warning.summary || warningTimestamp
                    ? `
                      <p class="reply-warning__meta">
                        ${warningTimestamp ? `<span>${escapeHtml(warningTimestamp)}</span>` : ""}
                        ${draft.warning.summary ? `<span>${escapeHtml(draft.warning.summary)}</span>` : ""}
                      </p>
                    `
                    : ""
                }
              </div>
            `
            : ""
        }
        ${
          showCollapsedState
            ? `
              <div class="reply-sent-summary">
                ${
                  draft.sentText
                    ? `
                      <div class="reply-sent-summary__preview">
                        <p class="reply-sent-summary__label">${escapeHtml(L("reply.sentPreviewLabel"))}</p>
                        <p class="reply-sent-summary__text">${escapeHtml(draft.sentText)}</p>
                      </div>
                    `
                    : ""
                }
                <div class="actions actions--stack">
                  <button class="secondary secondary--wide" type="button" data-reopen-completion-reply data-token="${escapeHtml(detail.token)}">
                    ${escapeHtml(L("reply.sendAnother"))}
                  </button>
                </div>
              </div>
            `
            : `
              <form class="reply-composer__form" data-completion-reply-form data-token="${escapeHtml(detail.token)}">
                <label class="field reply-field">
                  <span class="field-label">${escapeHtml(L("reply.fieldLabel"))}</span>
                  <textarea
                    class="reply-field__input"
                    name="text"
                    rows="4"
                    placeholder="${escapeHtml(L("reply.placeholder"))}"
                    data-completion-reply-textarea
                    data-reply-token="${escapeHtml(detail.token)}"
                  >${escapeHtml(draft.text)}</textarea>
                </label>
                ${
                  detail.reply?.supportsImages
                    ? `
                      <div class="reply-attachment-field">
                        <div class="reply-attachment-field__header">
                          <span class="field-label">${escapeHtml(L("reply.imageLabel"))}</span>
                          ${
                            draft.attachment
                              ? `
                                <button
                                  class="secondary secondary--compact"
                                  type="button"
                                  data-reply-image-remove
                                  data-reply-token="${escapeHtml(detail.token)}"
                                >
                                  ${escapeHtml(L("reply.imageRemove"))}
                                </button>
                              `
                              : ""
                          }
                        </div>
                        <label class="reply-attachment-picker">
                          <input
                            class="reply-attachment-picker__input"
                            type="file"
                            accept="image/*"
                            data-reply-image-input
                            data-reply-token="${escapeHtml(detail.token)}"
                          >
                          <span class="reply-attachment-picker__label">${escapeHtml(L(draft.attachment ? "reply.imageReplace" : "reply.imageAdd"))}</span>
                          <span class="reply-attachment-picker__hint">${escapeHtml(L("reply.imageHint"))}</span>
                        </label>
                        ${
                          draft.attachment
                            ? `
                              <div class="reply-image-preview">
                                <img class="reply-image-preview__image" src="${attachmentPreviewUrl}" alt="${attachmentName}">
                                <div class="reply-image-preview__copy">
                                  <p class="reply-image-preview__name">${attachmentName}</p>
                                  <p class="reply-image-preview__meta">${escapeHtml(L("reply.imageAttached"))}</p>
                                </div>
                              </div>
                            `
                            : ""
                        }
                      </div>
                    `
                    : ""
                }
                ${
                  detail.reply?.supportsPlanMode
                    ? `
                      <label class="reply-mode-switch" data-reply-mode-switch>
                        <input
                          class="reply-mode-switch__input"
                          type="checkbox"
                          ${planMode ? "checked" : ""}
                          data-reply-mode-toggle
                          data-reply-token="${escapeHtml(detail.token)}"
                        >
                        <span class="reply-mode-switch__track" aria-hidden="true">
                          <span class="reply-mode-switch__thumb"></span>
                        </span>
                        <span class="reply-mode-switch__copy">
                          <span class="reply-mode-switch__title">
                            <span>${escapeHtml(L("reply.mode.planLabel"))}</span>
                            <span class="reply-mode-switch__state">${escapeHtml(L(planMode ? "reply.mode.on" : "reply.mode.off"))}</span>
                          </span>
                          <span class="reply-mode-switch__hint">${escapeHtml(L(planMode ? "reply.mode.planHint" : "reply.mode.defaultHint"))}</span>
                        </span>
                      </label>
                    `
                    : ""
                }
                <div class="actions actions--stack">
                  <button class="primary primary--wide" type="submit" ${disabled ? "disabled" : ""}>${escapeHtml(sendLabel)}</button>
                </div>
              </form>
            `
        }
      </div>
    </section>
  `;
}

function renderChoiceQuestions(detail) {
  const effectiveAnswers = getEffectiveChoiceDraftAnswers(detail);
  return detail.questions
    .map((question) => {
      const questionTitle = question.header || question.prompt;
      const promptCopy = question.prompt && question.prompt !== questionTitle ? question.prompt : "";
      const questionHint = choiceQuestionHintText(question);
      return `
        <fieldset class="choice-question">
          <legend>${escapeHtml(questionTitle)}</legend>
          ${promptCopy ? `<p class="muted choice-question__prompt">${escapeHtml(promptCopy)}</p>` : ""}
          ${questionHint ? `<p class="choice-question__hint">${escapeHtml(questionHint)}</p>` : ""}
          <div class="choice-options">
            ${question.options
              .map((option) => {
                const value = option.id || option.label;
                const checked = effectiveAnswers?.[question.id] === value ? "checked" : "";
                const optionDescription = choiceOptionHintText(option);
                return `
                  <label class="choice-option">
                    <input type="radio" name="${escapeHtml(question.id)}" value="${escapeHtml(value)}" ${checked} required>
                    <span class="choice-option__content">
                      <span class="choice-option__label">${escapeHtml(option.label)}</span>
                      ${optionDescription ? `<span class="choice-option__description">${escapeHtml(optionDescription)}</span>` : ""}
                    </span>
                  </label>
                `;
              })
              .join("")}
          </div>
        </fieldset>
      `;
    })
    .join("");
}

function choiceQuestionHintText(question) {
  if (!question || typeof question !== "object") {
    return "";
  }
  const title = normalizeClientText(question.header || question.prompt || "");
  const prompt = normalizeClientText(question.prompt || question.header || "");
  const hint =
    [
      question.tooltip,
      question.toolTip,
      question.hint,
      question.hintText,
      question.helpText,
      question.description,
      question.subtitle,
      question.detail,
    ]
      .map((value) => normalizeClientText(value))
      .find(Boolean) || "";

  if (!hint || hint === title || hint === prompt) {
    return "";
  }

  return hint;
}

function choiceOptionHintText(option) {
  if (!option || typeof option !== "object") {
    return "";
  }
  return [
    option.description,
    option.hint,
    option.hintText,
    option.helpText,
    option.subtitle,
    option.detail,
  ]
    .map((value) => normalizeClientText(value))
    .find(Boolean) || "";
}

function renderChoiceActionBar(detail) {
  return `
    <div class="detail-action-bar">
      <div class="actions actions--stack actions--sticky">
        ${detail.page > 1 ? `<button class="secondary secondary--wide" type="submit" data-flow="prev">${escapeHtml(L("common.back"))}</button>` : ""}
        ${
          detail.page < detail.totalPages
            ? `<button class="primary primary--wide" type="submit" data-flow="next">${escapeHtml(L("common.next"))}</button>`
            : `<button class="primary primary--wide" type="submit" data-flow="submit">${escapeHtml(L("choice.submit"))}</button>`
        }
      </div>
    </div>
  `;
}

function renderChoiceDetailDesktop(detail) {
  const kindInfo = kindMeta("choice");
  return `
    <div class="detail-shell">
      ${renderDetailMetaRow(detail, kindInfo, {
        progressLabel: L("detail.pageProgress", { page: detail.page, totalPages: detail.totalPages }),
      })}
      <h2 class="detail-title detail-title--desktop">${escapeHtml(detailDisplayTitle(detail))}</h2>
      ${renderDetailLead(detail, kindInfo)}
      <form class="choice-form" data-choice-form data-token="${escapeHtml(detail.token)}" data-page="${detail.page}" data-total-pages="${detail.totalPages}">
        <section class="detail-card detail-card--choice">
          <div class="choice-stack">
          ${renderChoiceQuestions(detail)}
          </div>
        </section>
        <div class="actions actions--stack">
          ${detail.page > 1 ? `<button class="secondary secondary--wide" type="submit" data-flow="prev">${escapeHtml(L("common.back"))}</button>` : ""}
          ${
            detail.page < detail.totalPages
              ? `<button class="primary primary--wide" type="submit" data-flow="next">${escapeHtml(L("common.next"))}</button>`
              : `<button class="primary primary--wide" type="submit" data-flow="submit">${escapeHtml(L("choice.submit"))}</button>`
          }
        </div>
      </form>
    </div>
  `;
}

function renderChoiceDetailMobile(detail) {
  const kindInfo = kindMeta("choice");
  return `
    <form class="choice-form choice-form--mobile" data-choice-form data-token="${escapeHtml(detail.token)}" data-page="${detail.page}" data-total-pages="${detail.totalPages}">
      <div class="mobile-detail-screen">
        <div class="detail-shell detail-shell--mobile">
          <div class="mobile-detail-scroll mobile-detail-scroll--detail">
            ${renderDetailMetaRow(detail, kindInfo, {
              mobile: true,
              progressLabel: L("detail.pageProgress", { page: detail.page, totalPages: detail.totalPages }),
            })}
            <section class="detail-card detail-card--choice detail-card--mobile">
              ${renderDetailLead(detail, kindInfo, { mobile: true })}
              <div class="choice-stack">
                ${renderChoiceQuestions(detail)}
              </div>
            </section>
          </div>
          ${renderChoiceActionBar(detail)}
        </div>
      </div>
    </form>
  `;
}

function renderActionButtons(actions, options = {}) {
  if (!actions.length) {
    return "";
  }
  const actionsHtml = `
    <div class="actions actions--stack ${options.mobileSticky ? "actions--sticky" : ""}">
      ${actions
        .map(
          (action) => `
            <button
              class="${escapeHtml(actionClassForTone(action.tone))}"
              data-action-url="${escapeHtml(action.url)}"
              data-action-body='${escapeHtml(JSON.stringify(action.body || {}))}'
            >
              ${escapeHtml(action.label)}
            </button>
          `
        )
        .join("")}
    </div>
  `;

  if (options.mobileSticky) {
    return `<div class="detail-action-bar">${actionsHtml}</div>`;
  }

  return actionsHtml;
}

function renderDetailLoading({ mobile }) {
  const snapshot = buildDetailLoadingSnapshot();
  if (!snapshot) {
    return renderDetailEmpty();
  }
  const kindInfo = kindMeta(snapshot.kind);
  const content = `
    ${renderDetailMetaRow(snapshot, kindInfo, {
      mobile,
      progressLabel: L("common.loading"),
    })}
    <section class="detail-card detail-card--body ${mobile ? "detail-card--mobile" : ""}">
      <div class="detail-loading">
        <p class="detail-loading__copy">${escapeHtml(L("detail.loadingCopy"))}</p>
        <div class="detail-loading__lines" aria-hidden="true">
          <span class="detail-loading__line detail-loading__line--long"></span>
          <span class="detail-loading__line detail-loading__line--mid"></span>
          <span class="detail-loading__line detail-loading__line--short"></span>
        </div>
      </div>
    </section>
  `;

  if (mobile) {
    return `
      <div class="mobile-detail-screen">
        <div class="detail-shell detail-shell--mobile">
          <div class="mobile-detail-scroll mobile-detail-scroll--detail">
            ${content}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="detail-shell">
      ${content}
    </div>
  `;
}

function renderDetailEmpty() {
  return `
    <div class="detail-empty">
      <span class="eyebrow-pill">${escapeHtml(L("common.select"))}</span>
      <h2 class="detail-title">${escapeHtml(L("detail.selectTitle"))}</h2>
      <p class="muted">${escapeHtml(L("detail.selectCopy"))}</p>
    </div>
  `;
}

function renderInstallBanner() {
  if (!shouldShowInstallBanner()) {
    return "";
  }
  return `
    <section class="install-banner">
      <div class="install-banner__copy">
        <strong>${escapeHtml(L("banner.install.title"))}</strong>
        <p class="muted">${escapeHtml(installBannerCopy())}</p>
      </div>
      <div class="actions install-banner__actions">
        <button class="secondary" type="button" data-install-guide-open>${escapeHtml(L("common.addToHomeScreen"))}</button>
        <button class="ghost" type="button" data-dismiss-install>${escapeHtml(L("common.notNow"))}</button>
      </div>
    </section>
  `;
}

function renderTopBanner() {
  if (!isDesktopLayout() && (state.detailOpen || isSettingsSubpageOpen())) {
    return "";
  }
  if (shouldShowInstallBanner()) {
    return renderInstallBanner();
  }
  if (shouldShowPushBanner()) {
    return renderPushBanner();
  }
  return "";
}

function renderPushBanner() {
  if (!shouldShowPushBanner()) {
    return "";
  }
  const canEnable = canEnableNotificationsFromCurrentContext();
  return `
    <section class="install-banner install-banner--push">
      <div class="install-banner__copy">
        <strong>${escapeHtml(L("banner.push.title"))}</strong>
        <p class="muted">${escapeHtml(pushBannerCopy())}</p>
      </div>
      <div class="actions install-banner__actions">
        ${
          canEnable
            ? `<button class="primary" type="button" data-push-action="enable">${escapeHtml(L("common.enableNow"))}</button>`
            : `<button class="secondary" type="button" data-open-settings-page="notifications">${escapeHtml(L("common.notificationSettings"))}</button>`
        }
        <button class="ghost" type="button" data-dismiss-push-banner>${escapeHtml(L("common.notNow"))}</button>
      </div>
    </section>
  `;
}

function renderInstallGuideModal() {
  if (!state.installGuideOpen) {
    return "";
  }
  return `
    <div class="modal-backdrop" data-install-guide-close>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="install-guide-title">
        <div class="stack">
          <span class="eyebrow-pill">${escapeHtml(L("common.appName"))}</span>
          <h2 id="install-guide-title" class="detail-title">${escapeHtml(L("install.guide.title"))}</h2>
          <p class="muted">${escapeHtml(installGuideIntro())}</p>
          <ol class="install-steps">
            ${installGuideSteps()
              .map((step) => `<li>${escapeHtml(step)}</li>`)
              .join("")}
          </ol>
          <div class="actions actions--stack">
            <button class="primary primary--wide" type="button" data-install-guide-close>${escapeHtml(L("common.gotIt"))}</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderLogoutConfirmModal() {
  if (!state.logoutConfirmOpen || !state.session?.authenticated) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-close-logout-confirm>
      <section class="modal-card modal-card--confirm" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
        <div class="helper-copy">
          <strong id="logout-confirm-title">${escapeHtml(L("logout.confirm.title"))}</strong>
          <p class="muted">${escapeHtml(L("logout.confirm.copy"))}</p>
        </div>
        <div class="logout-option">
          <div class="logout-option__copy">
            <strong>${escapeHtml(L("logout.confirm.keepTrustedTitle"))}</strong>
            <p class="muted">${escapeHtml(L("logout.confirm.keepTrustedCopy"))}</p>
          </div>
          <button class="primary primary--wide" type="button" data-logout-mode="session">${escapeHtml(L("logout.action.keepTrusted"))}</button>
        </div>
        <div class="logout-option logout-option--danger">
          <div class="logout-option__copy">
            <strong>${escapeHtml(L("logout.confirm.removeTitle"))}</strong>
            <p class="muted">${escapeHtml(L("logout.confirm.removeCopy"))}</p>
          </div>
          <button class="secondary secondary--wide" type="button" data-logout-mode="revoke">${escapeHtml(L("logout.action.removeDevice"))}</button>
        </div>
        <button class="ghost ghost--wide" type="button" data-close-logout-confirm>${escapeHtml(L("common.cancel"))}</button>
      </section>
    </div>
  `;
}

function renderDesktopTabs() {
  return `
    <nav class="segmented-nav" aria-label="Sections">
      ${renderTabButtons({ buttonClass: "segmented-nav__button", withIcons: false })}
    </nav>
  `;
}

function renderBottomTabs() {
  return `
    <nav class="bottom-nav" aria-label="Sections">
      ${renderTabButtons({ buttonClass: "bottom-nav__button", withIcons: true })}
    </nav>
  `;
}

function renderTabButtons({ buttonClass, withIcons }) {
  return tabs()
    .map(
      (tab) => `
        <button class="${buttonClass} ${state.currentTab === tab.id ? "is-active" : ""}" data-tab="${escapeHtml(tab.id)}">
          ${withIcons ? `<span class="tab-icon" aria-hidden="true">${renderIcon(tab.icon)}</span>` : ""}
          <span class="tab-label">${escapeHtml(tab.label)}</span>
        </button>
      `
    )
    .join("");
}

function bindShellInteractions() {
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", async () => {
      await switchTab(button.dataset.tab);
    });
  }

  for (const button of document.querySelectorAll("[data-open-settings], [data-open-settings-page]")) {
    button.addEventListener("click", async () => {
      clearChoiceLocalDraftForItem(state.currentItem);
      state.currentTab = "settings";
      state.detailOpen = false;
      state.settingsSubpage = "";
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      const nextPage = button.dataset.openSettingsPage || "";
      if (nextPage) {
        openSettingsSubpage(nextPage);
      }
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-open-technical]")) {
    button.addEventListener("click", async () => {
      clearChoiceLocalDraftForItem(state.currentItem);
      state.currentTab = "settings";
      state.detailOpen = false;
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      openSettingsSubpage("advanced");
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-settings-subpage]")) {
    button.addEventListener("click", async () => {
      openSettingsSubpage(button.dataset.settingsSubpage || "");
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-settings-back]")) {
    button.addEventListener("click", async () => {
      closeSettingsSubpage();
      await renderShell();
    });
  }

  for (const select of document.querySelectorAll("[data-timeline-thread-select]")) {
    const handleInteractionStart = () => {
      markThreadFilterInteraction();
    };
    const handleInteractionEnd = () => {
      clearThreadFilterInteraction();
    };
    select.addEventListener("pointerdown", handleInteractionStart);
    select.addEventListener("click", handleInteractionStart);
    select.addEventListener("focus", handleInteractionStart);
    select.addEventListener("blur", handleInteractionEnd);
    select.addEventListener("change", async () => {
      clearThreadFilterInteraction();
      state.timelineThreadFilter = select.value || "all";
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const select of document.querySelectorAll("[data-completed-thread-select]")) {
    const handleInteractionStart = () => {
      markThreadFilterInteraction();
    };
    const handleInteractionEnd = () => {
      clearThreadFilterInteraction();
    };
    select.addEventListener("pointerdown", handleInteractionStart);
    select.addEventListener("click", handleInteractionStart);
    select.addEventListener("focus", handleInteractionStart);
    select.addEventListener("blur", handleInteractionEnd);
    select.addEventListener("change", async () => {
      clearThreadFilterInteraction();
      state.completedThreadFilter = select.value || "all";
      alignCurrentItemToVisibleEntries();
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-open-item-kind][data-open-item-token]")) {
    button.addEventListener("click", async () => {
      openItem({
        kind: button.dataset.openItemKind,
        token: button.dataset.openItemToken,
        sourceTab: button.dataset.sourceTab,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-back-to-list]")) {
    button.addEventListener("click", async () => {
      clearChoiceLocalDraftForItem(state.currentItem);
      state.detailOpen = false;
      state.pendingListScrollRestore = !isDesktopLayout() && Boolean(state.listScrollState);
      clearPinnedDetailState();
      syncCurrentItemUrl(null);
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-action-url]")) {
    button.addEventListener("click", async () => {
      const body = button.dataset.actionBody ? JSON.parse(button.dataset.actionBody) : {};
      const activeItem = state.currentItem ? { ...state.currentItem } : null;
      const keepDetailOpen = shouldKeepDetailAfterAction(activeItem);
      await apiPost(button.dataset.actionUrl, body);
      if (keepDetailOpen && activeItem?.kind === "approval") {
        pinActionOutcomeDetail(
          activeItem,
          buildActionOutcomeDetail({
            kind: "approval",
            title: state.currentDetail?.title,
            message: approvalOutcomeMessage(button.dataset.actionUrl),
          })
        );
      }
      await refreshAuthenticatedState();
      if (!keepDetailOpen && !isDesktopLayout()) {
        state.detailOpen = false;
        syncCurrentItemUrl(null);
      }
      await renderShell();
    });
  }

  for (const input of document.querySelectorAll("[data-reply-mode-toggle][data-reply-token]")) {
    input.addEventListener("change", async () => {
      const token = input.dataset.replyToken || "";
      setCompletionReplyDraft(token, {
        mode: input.checked ? "plan" : "default",
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-reopen-completion-reply][data-token]")) {
    button.addEventListener("click", async () => {
      const token = button.dataset.token || "";
      setCompletionReplyDraft(token, {
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
        collapsedAfterSend: false,
      });
      await renderShell();
    });
  }

  for (const input of document.querySelectorAll("[data-reply-image-input][data-reply-token]")) {
    input.addEventListener("change", async () => {
      const token = input.dataset.replyToken || "";
      const [file] = Array.from(input.files || []);
      const nextAttachment = createCompletionReplyAttachment(file);
      if (!nextAttachment && file) {
        setCompletionReplyDraft(token, {
          error: L("error.completionReplyImageInvalidType"),
          notice: "",
          warning: null,
          confirmOverride: false,
        });
        await renderShell();
        return;
      }
      setCompletionReplyDraft(token, {
        attachment: nextAttachment,
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-reply-image-remove][data-reply-token]")) {
    button.addEventListener("click", async () => {
      const token = button.dataset.replyToken || "";
      setCompletionReplyDraft(token, {
        attachment: null,
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      });
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-open-logout-confirm]")) {
    button.addEventListener("click", async () => {
      state.logoutConfirmOpen = true;
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-logout-mode]")) {
    button.addEventListener("click", async () => {
      try {
        await logout({ revokeCurrentDeviceTrust: button.dataset.logoutMode === "revoke" });
      } catch (error) {
        state.deviceError = error.message || String(error);
        state.logoutConfirmOpen = false;
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-device-revoke]")) {
    button.addEventListener("click", async () => {
      state.deviceNotice = "";
      state.deviceError = "";
      state.logoutConfirmOpen = false;
      try {
        await revokeTrustedDevice(button.dataset.deviceRevoke || "");
      } catch (error) {
        state.deviceError = error.message || String(error);
        await renderShell();
      }
    });
  }

  for (const button of document.querySelectorAll("[data-push-action]")) {
    button.addEventListener("click", async () => {
      const action = button.dataset.pushAction;
      state.pushError = "";
      state.pushNotice = "";
      try {
        if (action === "enable") {
          await enableNotifications();
          state.pushBannerDismissed = false;
          writePushBannerDismissed(false);
          state.pushNotice = L("notice.notificationsEnabled");
        } else if (action === "disable") {
          await disableNotifications();
          state.pushBannerDismissed = false;
          writePushBannerDismissed(false);
          state.pushNotice = L("notice.notificationsDisabled");
        } else if (action === "test") {
          await apiPost("/api/push/test", {});
          state.pushNotice = L("notice.testNotificationSent");
        }
        await refreshPushStatus();
      } catch (error) {
        state.pushError = error.message || String(error);
      }
      await renderShell();
    });
  }

  for (const button of document.querySelectorAll("[data-locale-option]")) {
    button.addEventListener("click", async () => {
      state.pushError = "";
      state.pushNotice = "";
      try {
        await setLocaleOverride(button.dataset.localeOption || "");
        await refreshSession();
        await refreshAuthenticatedState();
      } catch (error) {
        state.pushError = error.message || String(error);
      }
      await renderShell();
    });
  }

  const draftForm = document.querySelector("[data-choice-form]");
  if (draftForm) {
    draftForm.addEventListener("change", () => {
      const token = draftForm.dataset.token;
      const form = new FormData(draftForm);
      mergeChoiceLocalDraft(token, Object.fromEntries(form.entries()));
    });

    draftForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(draftForm);
      const answers = Object.fromEntries(form.entries());
      const token = draftForm.dataset.token;
      const page = Number(draftForm.dataset.page || "1");
      const totalPages = Number(draftForm.dataset.totalPages || "1");
      const action = event.submitter?.dataset.flow || "submit";
      mergeChoiceLocalDraft(token, answers);
      if (action === "next" || action === "prev") {
        const delta = action === "next" ? 1 : -1;
        await apiPost(`/api/items/choice/${encodeURIComponent(token)}/draft`, {
          answers,
          page: Math.max(1, Math.min(totalPages, page + delta)),
        });
      } else {
        const activeItem = state.currentItem ? { ...state.currentItem } : null;
        const keepDetailOpen = shouldKeepDetailAfterAction(activeItem);
        await apiPost(`/api/items/choice/${encodeURIComponent(token)}/submit`, { answers });
        clearChoiceLocalDraft(token);
        if (keepDetailOpen && activeItem?.kind === "choice") {
          pinActionOutcomeDetail(
            activeItem,
            buildActionOutcomeDetail({
              kind: "choice",
              title: state.currentDetail?.title,
              message: L("server.message.choiceSubmitted"),
            })
          );
        } else if (!isDesktopLayout()) {
          state.detailOpen = false;
          syncCurrentItemUrl(null);
        }
      }
      await refreshAuthenticatedState();
      await renderShell();
    });
  }

  const replyForm = document.querySelector("[data-completion-reply-form]");
  if (replyForm) {
    const token = replyForm.dataset.token || "";
    const textarea = replyForm.querySelector("[data-completion-reply-textarea]");
    textarea?.addEventListener("input", () => {
      const nextDraft = {
        text: textarea.value,
        notice: "",
        error: "",
        warning: null,
        confirmOverride: false,
      };
      setCompletionReplyDraft(token, nextDraft);
      syncCompletionReplyComposerLiveState(replyForm, {
        ...getCompletionReplyDraft(token),
        ...nextDraft,
      });
    });

    replyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const draft = getCompletionReplyDraft(token);
      const text = normalizeClientText(new FormData(replyForm).get("text"));
      if (!text) {
        setCompletionReplyDraft(token, {
          text,
          error: L("error.completionReplyEmpty"),
          notice: "",
          warning: null,
          confirmOverride: false,
          sending: false,
        });
        await renderShell();
        return;
      }

      setCompletionReplyDraft(token, {
        text,
        error: "",
        notice: "",
        warning: null,
        sending: true,
      });
      await renderShell();

      try {
        const requestBody = new FormData();
        requestBody.set("text", text);
        requestBody.set("planMode", draft.mode === "plan" ? "true" : "false");
        requestBody.set("force", draft.confirmOverride === true ? "true" : "false");
        if (COMPLETION_REPLY_IMAGE_SUPPORT && draft.attachment?.file) {
          requestBody.append("image", draft.attachment.file, draft.attachment.name || draft.attachment.file.name);
        }
        await apiPost(`/api/items/completion/${encodeURIComponent(token)}/reply`, requestBody);
        setCompletionReplyDraft(token, {
          text: "",
          sentText: text,
          attachment: null,
          mode: draft.mode,
          sending: false,
          error: "",
          notice: L(draft.mode === "plan" ? "reply.notice.sentPlan" : "reply.notice.sentDefault"),
          warning: null,
          confirmOverride: false,
          collapsedAfterSend: true,
        });
        await refreshAuthenticatedState();
      } catch (error) {
        if (error.errorKey === "completion-reply-thread-advanced") {
          setCompletionReplyDraft(token, {
            text,
            sentText: "",
            attachment: draft.attachment,
            mode: draft.mode,
            sending: false,
            notice: "",
            error: "",
            warning: error.payload?.warning ?? null,
            confirmOverride: true,
            collapsedAfterSend: false,
          });
          await renderShell();
          return;
        }
        setCompletionReplyDraft(token, {
          text,
          sentText: "",
          attachment: draft.attachment,
          mode: draft.mode,
          sending: false,
          notice: "",
          error: error.message || String(error),
          warning: null,
          confirmOverride: false,
          collapsedAfterSend: false,
        });
      }

      await renderShell();
    });
  }

  bindSharedUi(renderShell);
}

function bindSharedUi(renderFn) {
  for (const button of document.querySelectorAll("[data-install-guide-open]")) {
    button.addEventListener("click", async () => {
      state.installGuideOpen = true;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-install-guide-close]")) {
    button.addEventListener("click", async (event) => {
      if (button.classList.contains("modal-backdrop")) {
        if (event.target.closest(".modal-card")) {
          return;
        }
      }
      state.installGuideOpen = false;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-close-logout-confirm]")) {
    button.addEventListener("click", async (event) => {
      if (button.classList.contains("modal-backdrop")) {
        if (event.target.closest(".modal-card")) {
          return;
        }
      }
      state.logoutConfirmOpen = false;
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-dismiss-install]")) {
    button.addEventListener("click", async () => {
      state.installBannerDismissed = true;
      writeInstallBannerDismissed(true);
      await renderFn();
    });
  }

  for (const button of document.querySelectorAll("[data-dismiss-push-banner]")) {
    button.addEventListener("click", async () => {
      state.pushBannerDismissed = true;
      writePushBannerDismissed(true);
      await renderFn();
    });
  }
}

function openSettingsSubpage(page) {
  if (!page) {
    return;
  }
  if (!isDesktopLayout()) {
    state.settingsScrollState = {
      y: currentViewportScrollY(),
    };
    state.pendingSettingsScrollRestore = false;
    state.pendingSettingsSubpageScrollReset = true;
  }
  state.settingsSubpage = page;
}

function closeSettingsSubpage() {
  if (!state.settingsSubpage) {
    return;
  }
  state.settingsSubpage = "";
  if (!isDesktopLayout() && state.settingsScrollState) {
    state.pendingSettingsScrollRestore = true;
  }
}

async function switchTab(tab) {
  state.currentTab = tab;
  state.pushNotice = "";
  state.pushError = "";
  state.settingsSubpage = "";
  if (tab === "settings" || !isDesktopLayout()) {
    clearChoiceLocalDraftForItem(state.currentItem);
    state.detailOpen = false;
    clearPinnedDetailState();
    syncCurrentItemUrl(null);
  } else {
    ensureCurrentSelection();
    alignCurrentItemToVisibleEntries();
    syncCurrentItemUrl(state.currentItem);
  }
  await renderShell();
}

function openItem({ kind, token, sourceTab }) {
  const previousItem = state.currentItem ? { ...state.currentItem } : null;
  clearPinnedDetailState();
  const nextTab = sourceTab || tabForItemKind(kind, state.currentTab);
  if (previousItem && (previousItem.kind !== kind || previousItem.token !== token)) {
    clearChoiceLocalDraftForItem(previousItem);
  }
  if (!isDesktopLayout()) {
    state.listScrollState = {
      tab: nextTab,
      y: currentViewportScrollY(),
    };
    state.pendingListScrollRestore = false;
  }
  state.currentItem = { kind, token };
  state.currentTab = nextTab;
  state.detailOpen = !isDesktopLayout();
  state.pendingDetailScrollReset = state.detailOpen;
  syncCurrentItemUrl(state.currentItem);
}

function subtitleForCurrentView(detail) {
  if (state.currentTab === "settings") {
    if (state.settingsSubpage) {
      return settingsPageMeta(state.settingsSubpage).description;
    }
    return L("shell.subtitle.settings");
  }
  if (detail && state.detailOpen && !isDesktopLayout()) {
    return L("shell.subtitle.detail");
  }
  return tabMeta(state.currentTab).description;
}

function alignCurrentItemToVisibleEntries() {
  if (!isDesktopLayout() || state.currentTab === "settings") {
    return;
  }
  const preferredEntries = listEntriesForCurrentTab();
  if (!preferredEntries.length) {
    state.currentItem = null;
    state.currentDetail = null;
    syncCurrentItemUrl(null);
    return;
  }
  if (!state.currentItem || !preferredEntries.some((entry) => isSameItemRef(state.currentItem, entry.item))) {
    state.currentItem = toItemRef(preferredEntries[0].item);
    state.currentDetail = null;
  }
}

function renderStatusRow(label, value) {
  return `
    <div class="status-row">
      <span class="status-row__label">${escapeHtml(label)}</span>
      <span class="status-row__value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderEmptyList(tab) {
  return `
    <div class="empty-state">
      <p class="empty-state__title">${escapeHtml(tabMeta(tab).title)}</p>
      <p class="muted">${escapeHtml(L(`empty.${tab}`))}</p>
    </div>
  `;
}

function isSettingsSubpageOpen() {
  return state.currentTab === "settings" && Boolean(state.settingsSubpage) && !isDesktopLayout();
}

function tabMeta(tab) {
  switch (tab) {
    case "pending":
      return {
        id: "pending",
        title: L("tab.pending.title"),
        label: L("tab.pending.label"),
        icon: "pending",
        eyebrow: L("tab.pending.eyebrow"),
        description: L("tab.pending.description"),
      };
    case "timeline":
      return {
        id: "timeline",
        title: L("tab.timeline.title"),
        label: L("tab.timeline.label"),
        icon: "timeline",
        eyebrow: L("tab.timeline.eyebrow"),
        description: L("tab.timeline.description"),
      };
    case "completed":
      return {
        id: "completed",
        title: L("tab.completed.title"),
        label: L("tab.completed.label"),
        icon: "completed",
        eyebrow: L("tab.completed.eyebrow"),
        description: L("tab.completed.description"),
      };
    case "settings":
      return {
        id: "settings",
        title: L("tab.settings.title"),
        label: L("tab.settings.label"),
        icon: "settings",
        eyebrow: L("tab.settings.eyebrow"),
        description: L("tab.settings.description"),
      };
    default:
      return tabMeta("timeline");
  }
}

function tabs() {
  return [
    tabMeta("pending"),
    tabMeta("timeline"),
    tabMeta("completed"),
    tabMeta("settings"),
  ];
}

function tabForItemKind(kind, fallback) {
  if (TIMELINE_MESSAGE_KINDS.has(kind)) {
    return "timeline";
  }
  if (kind === "completion") {
    return "completed";
  }
  if (fallback === "timeline") {
    return "timeline";
  }
  return kind === "approval" || kind === "plan" || kind === "choice"
    ? "pending"
    : fallback || "pending";
}

function kindMeta(kind) {
  switch (kind) {
    case "user_message":
      return { label: L("common.userMessage"), tone: "neutral", icon: "user-message" };
    case "assistant_commentary":
      return { label: L("common.assistantCommentary"), tone: "plan", icon: "assistant-commentary" };
    case "assistant_final":
      return { label: L("common.assistantFinal"), tone: "completion", icon: "assistant-final" };
    case "approval":
      return { label: L("common.approval"), tone: "approval", icon: "approval" };
    case "plan":
    case "plan_ready":
      return { label: L("common.plan"), tone: "plan", icon: "plan" };
    case "choice":
      return { label: L("common.choice"), tone: "choice", icon: "choice" };
    case "completion":
      return { label: L("common.completion"), tone: "completion", icon: "completion-item" };
    default:
      return { label: L("common.item"), tone: "neutral", icon: "item" };
  }
}

function renderTypePillContent(kindInfo) {
  return `
    <span class="type-pill__icon" aria-hidden="true">${renderIcon(kindInfo.icon)}</span>
    <span>${escapeHtml(kindInfo.label)}</span>
  `;
}

function itemIntentText(kind, status = "pending") {
  if (kind === "user_message") {
    return L("intent.userMessage");
  }
  if (kind === "assistant_commentary") {
    return L("intent.assistantCommentary");
  }
  if (kind === "assistant_final") {
    return L("intent.assistantFinal");
  }
  if (status === "completed") {
    return L("intent.completed");
  }
  switch (kind) {
    case "approval":
      return L("intent.approval");
    case "plan":
      return L("intent.plan");
    case "choice":
      return L("intent.choice");
    case "completion":
      return L("intent.completed");
    default:
      return L("summary.default");
  }
}

function detailIntentText(detail) {
  if (TIMELINE_MESSAGE_KINDS.has(detail.kind)) {
    return itemIntentText(detail.kind, "timeline");
  }
  if (detail.readOnly) {
    return L("intent.completed");
  }
  return itemIntentText(detail.kind, "pending");
}

function detailDisplayTitle(detail) {
  const threadLabel = normalizeClientText(detail?.threadLabel || "");
  if (threadLabel) {
    return threadLabel;
  }
  const title = normalizeClientText(detail?.title || "");
  if (!title) {
    return L("common.untitledItem");
  }
  const [prefix, ...rest] = title.split(" | ");
  const knownPrefixes = new Set([
    L("common.approval"),
    L("common.plan"),
    L("common.choice"),
    L("common.completion"),
    L("common.userMessage"),
    L("common.assistantCommentary"),
    L("common.assistantFinal"),
    "Approval",
    "Plan",
    "Choice",
    "Completed",
    "User message",
    "Commentary",
    "Final answer",
    "完了",
    "承認",
    "プラン",
    "選択",
    "メッセージ",
    "途中経過",
    "最終回答",
  ]);
  if (rest.length > 0 && knownPrefixes.has(prefix)) {
    return rest.join(" | ");
  }
  return title;
}

function fallbackSummaryForKind(kind, status) {
  if (status === "completed") {
    return L("summary.completed");
  }
  switch (kind) {
    case "user_message":
      return L("summary.userMessage");
    case "assistant_commentary":
      return L("summary.assistantCommentary");
    case "assistant_final":
      return L("summary.assistantFinal");
    case "approval":
      return L("summary.approval");
    case "plan":
    case "plan_ready":
      return L("summary.plan");
    case "choice":
      return L("summary.choice");
    default:
      return L("summary.default");
  }
}

function actionClassForTone(tone) {
  if (tone === "danger" || tone === "warn" || tone === "reject") {
    return "danger danger--wide";
  }
  if (tone === "primary" || tone === "ok" || tone === "approve") {
    return "primary primary--wide";
  }
  return "secondary secondary--wide";
}

function shouldShowInstallBanner() {
  if (state.installBannerDismissed || isStandaloneMode()) {
    return false;
  }
  return !isDesktopLayout();
}

function shouldShowPushBanner() {
  if (!state.session?.authenticated || state.currentTab === "settings") {
    return false;
  }
  const push = state.pushStatus || {};
  if (!push.enabled || !push.standalone || push.serverSubscribed || state.pushBannerDismissed) {
    return false;
  }
  return true;
}

function installBannerCopy() {
  if (isProbablySafari()) {
    return L("banner.install.copy.safari");
  }
  return L("banner.install.copy.other");
}

function installGuideIntro() {
  if (isProbablySafari()) {
    return L("install.guide.intro.safari");
  }
  return L("install.guide.intro.other");
}

function installGuideSteps() {
  const steps = [];
  if (!isProbablySafari()) {
    steps.push(L("install.guide.step.openSafari"));
  }
  steps.push(L("install.guide.step.tapShare"));
  steps.push(L("install.guide.step.chooseAdd"));
  steps.push(L("install.guide.step.tapAdd"));
  return steps;
}

function pushBannerCopy() {
  const push = state.pushStatus || {};
  if (!push.secureContext) {
    return L("banner.push.copy.https");
  }
  if (!push.standalone) {
    return L("banner.push.copy.standalone");
  }
  if (push.notificationPermission === "denied") {
    return L("banner.push.copy.denied");
  }
  return L("banner.push.copy.default");
}

function canEnableNotificationsFromCurrentContext() {
  const push = state.pushStatus || {};
  return (
    push.enabled === true &&
    push.supportsPush === true &&
    push.secureContext === true &&
    push.standalone === true &&
    push.notificationPermission !== "denied" &&
    push.serverSubscribed !== true
  );
}

function readInstallBannerDismissed() {
  try {
    return window.localStorage.getItem(INSTALL_BANNER_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstallBannerDismissed(value) {
  try {
    if (value) {
      window.localStorage.setItem(INSTALL_BANNER_DISMISS_KEY, "1");
    } else {
      window.localStorage.removeItem(INSTALL_BANNER_DISMISS_KEY);
    }
  } catch {
    // Ignore storage errors on private browsing or restricted environments.
  }
}

function readPushBannerDismissed() {
  try {
    return window.localStorage.getItem(PUSH_BANNER_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writePushBannerDismissed(value) {
  try {
    if (value) {
      window.localStorage.setItem(PUSH_BANNER_DISMISS_KEY, "1");
    } else {
      window.localStorage.removeItem(PUSH_BANNER_DISMISS_KEY);
    }
  } catch {
    // Ignore storage errors on private browsing or restricted environments.
  }
}

function isProbablySafari() {
  const userAgent = navigator.userAgent || "";
  return /Safari/iu.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/iu.test(userAgent);
}

function isDesktopLayout() {
  return window.innerWidth >= DESKTOP_BREAKPOINT;
}

function toItemRef(item) {
  return {
    kind: item.kind,
    token: item.token,
  };
}

function isSameItemRef(left, right) {
  return left?.kind === right?.kind && left?.token === right?.token;
}

function isFastPathItemRef(itemRef) {
  return itemRef?.kind === "approval" || itemRef?.kind === "choice";
}

function hasLaunchItemIntent(itemRef = state.currentItem) {
  return Boolean(state.launchItemIntent && isSameItemRef(state.launchItemIntent, itemRef));
}

function hasDetailOverride(itemRef = state.currentItem) {
  return Boolean(state.detailOverride && isSameItemRef(state.detailOverride, itemRef));
}

function shouldPreserveCurrentItem(itemRef = state.currentItem) {
  return Boolean(itemRef && (hasLaunchItemIntent(itemRef) || hasDetailOverride(itemRef)));
}

function clearLaunchItemIntent() {
  state.launchItemIntent = null;
}

function clearDetailOverride() {
  state.detailOverride = null;
}

function clearPinnedDetailState() {
  detailLoadSequence += 1;
  clearLaunchItemIntent();
  clearDetailOverride();
  state.currentDetail = null;
  state.currentDetailLoading = false;
  state.detailLoadingItem = null;
}

function renderIcon(name) {
  switch (name) {
    case "approval":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 18.5 6v5.4c0 4-2.7 7.6-6.5 9.1-3.8-1.5-6.5-5.1-6.5-9.1V6z"/><path d="m8.9 12 2.1 2.1 4.1-4.4"/></svg>`;
    case "plan":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><path d="m12 12 3.6-2.2"/><path d="M12 4.5v1.7"/><path d="M19.5 12h-1.7"/><path d="M12 19.5v-1.7"/><path d="M4.5 12h1.7"/></svg>`;
    case "choice":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="5.5" width="15" height="13" rx="2.5"/><path d="m8.2 12 1.6 1.6 3-3.2"/><path d="M13.8 10.2h2.2"/><path d="M13.8 13.8h2.2"/></svg>`;
    case "completion-item":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="m8.7 12.1 2 2.1 4.7-4.9"/></svg>`;
    case "item":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4.5" width="14" height="15" rx="2.5"/><path d="M8.5 9h7"/><path d="M8.5 12h7"/><path d="M8.5 15h4.5"/></svg>`;
    case "pending":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v5"/><path d="M12 16v5"/><path d="M4.8 6.8l3.5 3.5"/><path d="M15.7 15.7l3.5 3.5"/><path d="M3 12h5"/><path d="M16 12h5"/><path d="M4.8 17.2l3.5-3.5"/><path d="M15.7 8.3l3.5-3.5"/></svg>`;
    case "timeline":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H11l-3.5 3.1v-3.1H6.5a2 2 0 0 1-2-2z"/><path d="M8 8.8h8"/><path d="M8 11.8h5.5"/></svg>`;
    case "user-message":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Z"/><path d="M6.5 18.2a5.8 5.8 0 0 1 11 0"/></svg>`;
    case "assistant-commentary":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.2v5.6"/><path d="M9.2 9h5.6"/><path d="M6 14.8a6.7 6.7 0 0 0 12 0"/><path d="M8 4.8a7.6 7.6 0 0 1 8 0"/></svg>`;
    case "assistant-final":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6.5h12a1.8 1.8 0 0 1 1.8 1.8v6.1A1.8 1.8 0 0 1 18 16.2h-5.3L9 19.4v-3.2H6a1.8 1.8 0 0 1-1.8-1.8V8.3A1.8 1.8 0 0 1 6 6.5Z"/><path d="m9.2 11.3 1.7 1.7 3.6-3.8"/></svg>`;
    case "completed":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="m8.7 12.2 2.1 2.1 4.6-4.8"/></svg>`;
    case "settings":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.4 6a1 1 0 0 0 .82.5l2.84.28 1.16 2.02-1.8 2.22a1 1 0 0 0-.2.95l.62 2.78-2.04 1.18-2.58-1.1a1 1 0 0 0-.78 0l-2.58 1.1-2.04-1.18.62-2.78a1 1 0 0 0-.2-.95L5.78 8.8l1.16-2.02 2.84-.28a1 1 0 0 0 .82-.5L12 3.5Z"/><circle cx="12" cy="12" r="2.7"/></svg>`;
    case "notifications":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5a4 4 0 0 0-4 4v2.1c0 .9-.28 1.79-.8 2.52L6 15.2h12l-1.2-2.08a4.9 4.9 0 0 1-.8-2.52V8.5a4 4 0 0 0-4-4Z"/><path d="M10.2 18a2 2 0 0 0 3.6 0"/></svg>`;
    case "homescreen":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10 6.8h4"/><path d="M10.7 17.2h2.6"/></svg>`;
    case "iphone":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="7.2" y="2.8" width="9.6" height="18.4" rx="2.4"/><path d="M10 6.7h4"/><circle cx="12" cy="17.6" r="0.7" fill="currentColor" stroke="none"/></svg>`;
    case "language":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.8 0 7 3.8 7 8.5s-3.2 8.5-7 8.5-7-3.8-7-8.5 3.2-8.5 7-8.5Z"/><path d="M5.8 9h12.4"/><path d="M5.8 15h12.4"/><path d="M12 3.8c1.9 2 3 4.9 3 8.2s-1.1 6.2-3 8.2c-1.9-2-3-4.9-3-8.2s1.1-6.2 3-8.2Z"/></svg>`;
    case "link":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 13.6 8.3 15.7a3 3 0 0 1-4.2-4.2l2.8-2.8a3 3 0 0 1 4.2 0"/><path d="m13.6 10.4 2.1-2.1a3 3 0 1 1 4.2 4.2l-2.8 2.8a3 3 0 0 1-4.2 0"/><path d="m9.5 14.5 5-5"/></svg>`;
    case "check":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.8 12.5 3.2 3.2 7.2-7.4"/></svg>`;
    case "back":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
    case "chevron-down":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
    case "chevron-right":
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
    default:
      return "";
  }
}

function renderCurrentSurface() {
  if (!state.session?.authenticated) {
    renderPair();
    return;
  }
  renderShell().catch((error) => {
    const message = error.message || String(error);
    app.innerHTML = `
      <main class="onboarding-shell">
        <section class="onboarding-card">
          <span class="eyebrow-pill">${escapeHtml(L("common.codex"))}</span>
          <h1 class="hero-title">${escapeHtml(L("common.appName"))}</h1>
          <p class="hero-copy">${escapeHtml(message)}</p>
        </section>
      </main>
    `;
  });
}

async function enableNotifications() {
  if (!state.session?.webPushEnabled) {
    throw new Error(L("error.webPushDisabled"));
  }
  if (!window.isSecureContext) {
    throw new Error(L("error.notificationsRequireHttps"));
  }
  if (!supportsPush()) {
    throw new Error(L("error.pushUnsupported"));
  }
  if (!isStandaloneMode()) {
    throw new Error(L("error.openHomeScreen"));
  }

  const registration = await ensureServiceWorkerReady();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(L("error.notificationPermission", { status: permission }));
  }

  const status = await apiGet("/api/push/status");
  if (!status.enabled || !status.vapidPublicKey) {
    throw new Error(L("error.pushServerNotReady"));
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
  });

  await apiPost("/api/push/subscribe", {
    subscription: subscription.toJSON(),
    userAgent: navigator.userAgent,
    standalone: isStandaloneMode(),
  });
}

async function disableNotifications() {
  const registration = await ensureServiceWorkerReady();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe().catch(() => {});
    await apiPost("/api/push/unsubscribe", { endpoint: subscription.endpoint });
    return;
  }
  await apiPost("/api/push/unsubscribe", {});
}

async function ensureServiceWorkerReady() {
  if (state.serviceWorkerRegistration) {
    return state.serviceWorkerRegistration;
  }
  if (!("serviceWorker" in navigator)) {
    throw new Error(L("error.serviceWorkerUnavailable"));
  }
  state.serviceWorkerRegistration = await navigator.serviceWorker.ready;
  return state.serviceWorkerRegistration;
}

function supportsPush() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function handleServiceWorkerMessage(event) {
  const type = event?.data?.type || "";
  if (type === "pushsubscriptionchange") {
    refreshPushStatus().then(renderCurrentSurface).catch(() => {});
  }
}

async function apiGet(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const errorInfo = await readError(response);
    const error = new Error(errorInfo.message);
    error.code = response.status;
    error.status = response.status;
    error.errorKey = errorInfo.errorKey || "";
    throw error;
  }
  return response.json();
}

async function apiPost(url, body) {
  const isFormDataBody = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: isFormDataBody
      ? {
          Accept: "application/json",
        }
      : {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
    body: isFormDataBody ? body : JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const errorInfo = await readError(response);
    const error = new Error(errorInfo.message);
    error.code = response.status;
    error.status = response.status;
    error.errorKey = errorInfo.errorKey || "";
    error.payload = errorInfo.payload ?? null;
    throw error;
  }
  return response.json();
}

async function readError(response) {
  try {
    const payload = await response.json();
    const errorKey = typeof payload.error === "string" ? payload.error : "";
    const message = localizeApiError(errorKey || payload.message || response.statusText);
    return { message, errorKey, payload };
  } catch {
    return { message: localizeApiError(response.statusText), errorKey: "", payload: null };
  }
}

function localizeApiError(value) {
  const raw = normalizeClientText(value);
  if (!raw) {
    return "";
  }
  const map = {
    "pairing-unavailable": "error.pairingUnavailable",
    "invalid-pairing-credentials": "error.invalidPairingCredentials",
    "pairing-rate-limited": "error.pairingRateLimited",
    "authentication-required": "error.authenticationRequired",
    "origin-not-allowed": "error.originNotAllowed",
    "device-not-found": "error.deviceNotFound",
    "web-push-disabled": "error.webPushDisabled",
    "push-subscription-expired": "error.pushSubscriptionExpired",
    "item-not-found": "error.itemNotFound",
    "completion-reply-unavailable": "error.completionReplyUnavailable",
    "completion-reply-thread-advanced": "error.completionReplyThreadAdvanced",
    "completion-reply-empty": "error.completionReplyEmpty",
    "completion-reply-image-invalid-type": "error.completionReplyImageInvalidType",
    "completion-reply-image-too-large": "error.completionReplyImageTooLarge",
    "completion-reply-image-limit": "error.completionReplyImageLimit",
    "completion-reply-image-invalid-upload": "error.completionReplyImageInvalidUpload",
    "completion-reply-image-disabled": "error.completionReplyImageDisabled",
    "codex-ipc-not-connected": "error.codexIpcNotConnected",
    "approval-not-found": "error.approvalNotFound",
    "approval-already-handled": "error.approvalAlreadyHandled",
    "plan-request-not-found": "error.planRequestNotFound",
    "plan-request-already-handled": "error.planRequestAlreadyHandled",
    "choice-input-not-found": "error.choiceInputNotFound",
    "choice-input-read-only": "error.choiceInputReadOnly",
    "choice-input-already-handled": "error.choiceInputAlreadyHandled",
    "mkcert-root-ca-not-found": "error.mkcertRootCaNotFound",
  };
  const key = map[raw];
  return key ? L(key) : raw;
}

function normalizeClientText(value) {
  return String(value ?? "").trim();
}

function parseItemRef(value) {
  const [kind, token] = String(value || "").split(":");
  return kind && token ? { kind, token } : null;
}

function buildAppUrl(nextParams) {
  const query = nextParams.toString();
  return `/app${query ? `?${query}` : ""}`;
}

function syncCurrentItemUrl(itemRef) {
  const nextParams = new URLSearchParams(window.location.search);
  if (itemRef?.kind && itemRef?.token) {
    nextParams.set("item", `${itemRef.kind}:${itemRef.token}`);
  } else {
    nextParams.delete("item");
  }
  const nextUrl = buildAppUrl(nextParams);
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    history.replaceState({}, "", nextUrl);
  }
}

function updateManifestHref(pairToken) {
  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (!manifestLink) {
    return;
  }
  const token = String(pairToken || "");
  const href = token
    ? `/manifest.webmanifest?pairToken=${encodeURIComponent(token)}`
    : "/manifest.webmanifest";
  if (manifestLink.getAttribute("href") === href) {
    return;
  }
  manifestLink.setAttribute("href", href);
}

function syncPairingTokenState(pairToken) {
  const token = String(pairToken || "");
  updateManifestHref(token);

  const nextParams = new URLSearchParams(window.location.search);
  if (token) {
    nextParams.set("pairToken", token);
  } else {
    nextParams.delete("pairToken");
  }
  const nextUrl = buildAppUrl(nextParams);
  if (`${window.location.pathname}${window.location.search}` === nextUrl) {
    return;
  }
  history.replaceState({}, "", nextUrl);
}

function desiredBootstrapPairingToken() {
  if (state.session?.authenticated && !state.session?.temporaryPairing) {
    return "";
  }
  return initialPairToken;
}

function shouldAutoPairFromBootstrapToken() {
  if (!initialPairToken) {
    return false;
  }
  return true;
}

function shouldUseTemporaryBootstrapPairing() {
  return Boolean(initialPairToken) && !isStandaloneMode() && isProbablySafari();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = `${base64String}${padding}`.replace(/-/gu, "+").replace(/_/gu, "/");
  const rawData = window.atob(normalized);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
