import { logger } from "../shared/logger";
import { observeModuleLoad, waitForWebpackRequire } from "../shared/webpack-bridge";

type Nullable<T> = T | null;

type DiscordStores = {
  SelectedChannelStore: DiscordStore;
  SelectedGuildStore: DiscordStore;
  ChannelStore: Record<string, any>;
  GuildStore: Nullable<Record<string, any>>;
  UserStore: Nullable<Record<string, any>>;
  Constants: Nullable<{ ChannelTypes: Record<string, number> }>;
  NavigationUtils: Nullable<Record<string, (...args: any[]) => void>>;
  ChannelActions: Nullable<Record<string, (...args: any[]) => void>>;
  FluxDispatcher: Nullable<{
    dispatch: (action: Record<string, any>) => void;
    subscribe?: (event: string, handler: (...args: any[]) => void) => () => void;
  }>;
  UnreadStateStore: Nullable<{
    getUnreadCount?: (channelId: string) => number;
    getMentionCount?: (channelId: string) => number;
    getUnreadMentions?: (channelId: string) => number;
    hasUnread?: (channelId: string) => boolean;
    addChangeListener?: (listener: () => void) => void;
    removeChangeListener?: (listener: () => void) => void;
  }>;
};

type DiscordStore = {
  addChangeListener?: (listener: () => void) => void;
  removeChangeListener?: (listener: () => void) => void;
  subscribe?: (listener: () => void) => () => void;
  getChannelId?: () => string | undefined;
  getGuildId?: () => string | undefined;
};

type TabMeta = {
  channelId: string;
  guildId: string;
  title: string;
  iconUrl: string | null;
};

type TabEntry = TabMeta & {
  id: string;
};

type PendingNavigationTarget = {
  tabId: string;
  channelId: string;
  guildId: string;
  startedAt: number;
  attempts: number;
};

type NotificationCounts = {
  messages: number;
  mentions: number;
};

type ToastKind = "mention" | "message";

type ToastEntry = {
  id: string;
  channelId: string;
  guildId: string;
  title: string;
  kind: ToastKind;
  count: number;
  iconUrl: string;
  message: string;
  createdAt: number;
};

type ChannelLinkTarget = {
  guildId: string;
  channelId: string;
};

type ExtensionSettings = {
  autoOpenOnSwitch: boolean;
  openOnMiddleClick: boolean;
  openOnCtrlClick: boolean;
};

type RestoreActiveResult = "none" | "navigated" | "already-active";

const CONFIG = {
  maxTabs: 12,
  storageKey: "discordTabs.extension.state.v1",
  rootId: "discord-tabs-root"
};

const DEFAULT_TAB_ICON = "https://cdn.discordapp.com/embed/avatars/0.png";

const DEFAULT_SETTINGS: ExtensionSettings = {
  autoOpenOnSwitch: false,
  openOnMiddleClick: true,
  openOnCtrlClick: true
};

const FRIENDS_CHANNEL_PREFIX = "__friends__";
const FRIENDS_HOME_SLUG = "home";
const FRIENDS_HOME_CHANNEL_ID = `${FRIENDS_CHANNEL_PREFIX}${FRIENDS_HOME_SLUG}`;

type StorageAdapter = {
  kind: "bridge" | "local";
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
};

const STORAGE_CHANNEL = "discord-tabs-storage" as const;

type StorageBridgeAction = "ping" | "get" | "set" | "remove";

type StorageBridgeRequest = {
  channel: typeof STORAGE_CHANNEL;
  direction: "request";
  requestId: string;
  action: StorageBridgeAction;
  key?: string;
  value?: unknown;
};

type StorageBridgeResponse = {
  channel: typeof STORAGE_CHANNEL;
  direction: "response";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

function ensureStaticIconUrl(source: string | null | undefined): string | null {
  if (!source || typeof source !== "string" || source.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(source, location.origin);
    const hostname = parsed.hostname.toLowerCase();
    const isDiscordCdn =
      hostname.endsWith("discordapp.com") ||
      hostname.endsWith("discordapp.net") ||
      hostname.endsWith("discord.com");
    if (isDiscordCdn) {
      if (/\.gif$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\.gif$/i, ".png");
      }
      const formatParam = parsed.searchParams.get("format");
      if (typeof formatParam === "string" && formatParam.toLowerCase() === "gif") {
        parsed.searchParams.set("format", "png");
      }
      parsed.searchParams.delete("dynamic");
      parsed.searchParams.delete("animated");

      if (!parsed.searchParams.has("size") && /\/(?:icons|avatars)\//i.test(parsed.pathname)) {
        parsed.searchParams.set("size", "64");
      }
      if (!parsed.searchParams.has("quality") && /\.png$/i.test(parsed.pathname)) {
        parsed.searchParams.set("quality", "lossless");
      }

      return parsed.toString();
    }
  } catch {
    return source;
  }

  return source;
}

const TOAST_DURATION_MS = 4000;

const HEADER_SELECTORS = [
  "div[class^='container_'] > div[class^='base_'] > div[class^='bar_']",
  "div[class*='titleBar']"
];

const state = {
  stores: null as Nullable<DiscordStores>,
  tabs: [] as TabEntry[],
  selectedChannelId: null as Nullable<string>,
  activeTabId: null as Nullable<string>,
  pendingNavigationTabId: null as Nullable<string>,
  pendingNavigationTarget: null as Nullable<PendingNavigationTarget>,
  cleanupTasks: [] as Array<() => void>,
  root: null as Nullable<HTMLDivElement>,
  headerBar: null as Nullable<HTMLElement>,
  hiddenHeaderChild: null as Nullable<HTMLElement>,
  hiddenQuickSwitcher: null as Nullable<HTMLElement>,
  headerObserver: null as Nullable<MutationObserver>,
  lastMissingModules: null as Nullable<string>,
  lastLookupError: null as Nullable<string>,
  settings: { ...DEFAULT_SETTINGS },
  notificationCounts: new Map<string, NotificationCounts>(),
  toastRoot: null as Nullable<HTMLDivElement>,
  toasts: [] as ToastEntry[],
  toastTimers: new Map<string, number>(),
  draggingTabId: null as Nullable<string>,
  dragHoverTabId: null as Nullable<string>,
  dragHoverPosition: null as Nullable<"before" | "after">
};

let storageAdapterPromise: Promise<StorageAdapter | null> | null = null;
let storageBridgeDetected = false;
let storageBridgeFailed = false;
let storageListenerRegistered = false;
const storageResponseResolvers = new Map<string, (response: StorageBridgeResponse) => void>();
let pendingPersistTimer: number | null = null;
let pendingPersistPayload: string | null = null;
let persistedOnce = false;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateStorageRequestId(): string {
  return `storage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAppPath(path: string): string {
  if (!path) return "/";
  const trimmed = path.replace(/\/+$/, "");
    const collapsed = trimmed.replace(/\/+/g, "/");
  return collapsed.length > 0 ? collapsed : "/";
}

function isSnowflake(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d+$/.test(value);
}

function createFriendsChannelId(slug?: string): string {
  const normalized = (slug ?? FRIENDS_HOME_SLUG).trim().toLowerCase();
  const safe = normalized.length > 0 ? normalized : FRIENDS_HOME_SLUG;
  return `${FRIENDS_CHANNEL_PREFIX}${safe}`;
}

function isFriendsChannelId(channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  return channelId.startsWith(FRIENDS_CHANNEL_PREFIX);
}

function getFriendsSlugFromChannelId(channelId: string): string {
  if (!isFriendsChannelId(channelId)) return "";
  const slug = channelId.slice(FRIENDS_CHANNEL_PREFIX.length);
  return slug.length > 0 ? slug : FRIENDS_HOME_SLUG;
}

function formatFriendsTitleFromSlug(slug: string): string {
  if (!slug || slug === FRIENDS_HOME_SLUG) {
    return "Friends";
  }
  const words = slug.split(/[-_\/]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  if (words.length === 0) {
    return "Friends";
  }
  return `Friends – ${words.join(" ")}`;
}

function resolveFriendsTitle(channelId: string, fallbackTitle?: string): string {
  if (fallbackTitle && fallbackTitle.length > 0) {
    return fallbackTitle;
  }
  return formatFriendsTitleFromSlug(getFriendsSlugFromChannelId(channelId));
}

function resolveFriendsIcon(fallbackIcon?: string | null): string | null {
  if (fallbackIcon && fallbackIcon.length > 0) {
    return ensureStaticIconUrl(fallbackIcon);
  }
  return DEFAULT_TAB_ICON;
}

function buildTabRelativePath(tab: Pick<TabEntry, "guildId" | "channelId">): string {
  if (isFriendsChannelId(tab.channelId)) {
    const slug = getFriendsSlugFromChannelId(tab.channelId);
    return slug === FRIENDS_HOME_SLUG ? "/channels/@me" : `/channels/@me/${slug}`;
  }

  if (tab.guildId && tab.guildId !== "@me") {
    return `/channels/${tab.guildId}/${tab.channelId}`;
  }

  return `/channels/@me/${tab.channelId}`;
}

function buildAbsolutePath(relativePath: string): string {
  return `${location.origin}${relativePath}`;
}

function parseChannelsPath(path: string): ChannelLinkTarget | null {
  if (!path) return null;

  let working = path.trim();
  if (!working) return null;

  if (working.includes("://")) {
    try {
      working = new URL(working).pathname;
    } catch {
      try {
        working = new URL(working, location.origin).pathname;
      } catch {
        return null;
      }
    }
  }

  const hashIndex = working.indexOf("#");
  if (hashIndex >= 0) {
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf("?");
  if (queryIndex >= 0) {
    working = working.slice(0, queryIndex);
  }

  if (!working.startsWith("/")) {
    if (working.startsWith("channels/")) {
      working = `/${working}`;
    } else {
      return null;
    }
  }

  const normalized = normalizeAppPath(working);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  if (segments[0] !== "channels") {
    return null;
  }

  const guildSegment = segments[1];
  if (!guildSegment) {
    return null;
  }

  if (guildSegment === "@me") {
    const remainder = segments.slice(2);
    if (remainder.length === 0) {
      return { guildId: "@me", channelId: FRIENDS_HOME_CHANNEL_ID };
    }

    const channelSegment = remainder[0];
    if (isSnowflake(channelSegment)) {
      return { guildId: "@me", channelId: channelSegment };
    }

    const slugRaw = remainder.join("/");
    let slug = slugRaw;
    try {
      slug = decodeURIComponent(slugRaw);
    } catch {
      // ignore decode failures and use raw slug
    }
    return { guildId: "@me", channelId: createFriendsChannelId(slug) };
  }

  if (segments.length < 3) {
    return null;
  }

  const channelSegment = segments[2];
  return { guildId: guildSegment, channelId: channelSegment };
}

function registerStorageResponseListener(): void {
  if (storageListenerRegistered || typeof window === "undefined") return;
  window.addEventListener("message", (event: MessageEvent<StorageBridgeResponse>) => {
    const data = event.data;
    if (!data || data.channel !== STORAGE_CHANNEL || data.direction !== "response") {
      return;
    }
    if (event.source !== window) {
      return;
    }
    const resolver = storageResponseResolvers.get(data.requestId);
    if (resolver) {
      storageResponseResolvers.delete(data.requestId);
      resolver(data);
    }
  });
  storageListenerRegistered = true;
}

function sendStorageBridgeRequest(action: StorageBridgeAction, key?: string, value?: unknown): Promise<StorageBridgeResponse> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Window unavailable for storage bridge"));
  }

  registerStorageResponseListener();

  return new Promise((resolve, reject) => {
    const requestId = generateStorageRequestId();
    const timeoutId = window.setTimeout(() => {
      storageResponseResolvers.delete(requestId);
      reject(new Error("storage bridge timeout"));
    }, 700);

    storageResponseResolvers.set(requestId, (response) => {
      window.clearTimeout(timeoutId);
      resolve(response);
    });

    const payload: StorageBridgeRequest = {
      channel: STORAGE_CHANNEL,
      direction: "request",
      requestId,
      action,
      key,
      value
    };

    window.postMessage(payload, "*");
  });
}

async function tryInitialiseBridge(): Promise<boolean> {
  if (storageBridgeDetected) return true;
  if (storageBridgeFailed) return false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await sendStorageBridgeRequest("ping");
      if (response.ok) {
        storageBridgeDetected = true;
        logger.info("DiscordTabs: storage bridge ready");
        return true;
      }
    } catch (err) {
      if (attempt === 2) {
        logger.warn("DiscordTabs: storage bridge ping failed", err);
      }
    }
    await wait(50);
  }

  storageBridgeFailed = true;
  return false;
}

async function resolveStorageAdapter(): Promise<StorageAdapter | null> {
  if (storageAdapterPromise) {
    return storageAdapterPromise;
  }

  storageAdapterPromise = (async (): Promise<StorageAdapter | null> => {
    if (await tryInitialiseBridge()) {
      return {
        kind: "bridge",
        async getItem(key) {
          const response = await sendStorageBridgeRequest("get", key);
          if (!response.ok) {
            throw new Error(response.error ?? "bridge get failed");
          }
          const value = response.value;
          return typeof value === "string" ? value : value == null ? null : String(value);
        },
        async setItem(key, value) {
          const response = await sendStorageBridgeRequest("set", key, value);
          if (!response.ok) {
            throw new Error(response.error ?? "bridge set failed");
          }
        },
        async removeItem(key) {
          const response = await sendStorageBridgeRequest("remove", key);
          if (!response.ok) {
            throw new Error(response.error ?? "bridge remove failed");
          }
        }
      } satisfies StorageAdapter;
    }

    const storage = getStorage();
    if (storage) {
      logger.info("DiscordTabs: using localStorage fallback for persistence");
      return {
        kind: "local",
        async getItem(key) {
          return storage.getItem(key);
        },
        async setItem(key, value) {
          storage.setItem(key, value);
        },
        async removeItem(key) {
          storage.removeItem(key);
        }
      } satisfies StorageAdapter;
    }

    logger.warn("DiscordTabs: no persistent storage available");
    return null;
  })();

  return storageAdapterPromise;
}

function serializeStateForPersistence(): string {
  return JSON.stringify({
    tabs: state.tabs.map((tab) => ({ ...tab })),
    settings: { ...state.settings },
    activeTabId: state.activeTabId
  });
}

function main() {
  if (!isDiscordApp()) {
    logger.info("Not on discord app, aborting", location.pathname);
    return;
  }

  whenReady(async () => {
    try {
      await initialise();
    } catch (err) {
      logger.error("Failed to initialise", err);
    }
  });
}

function isDiscordApp(): boolean {
  return location.pathname.startsWith("/app") || location.pathname.startsWith("/channels");
}

function whenReady(callback: () => void) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}

async function initialise() {
  await waitForBody();
  ensureRoot();
  attachDebugHelpers();
  const header = await waitForHeaderBar();
  attachRootToHeader(header);
  startHeaderWatcher();
  await loadPersistedState();
  installChannelOpenListeners();

  const stores = await waitForStores();
  state.stores = stores;
  logger.info("DiscordTabs: stores resolved", {
    navigationUtils: stores.NavigationUtils ? Object.keys(stores.NavigationUtils) : null,
    hasChannelActions: Boolean(stores.ChannelActions),
    hasFluxDispatcher: Boolean(stores.FluxDispatcher)
  });

  hydratePersistedTabs();
  ensureActiveTabState();

  renderTabs();
  wireChannelListener();

  const restoreResult = attemptRestoreLastActiveTab();
  if (restoreResult !== "navigated") {
    onChannelSwitch();
  }

  setupNotificationTracking();

  window.addEventListener("beforeunload", teardown, { once: true });
}

async function waitForBody(): Promise<void> {
  if (document.body) return;
  await new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

async function waitForHeaderBar(): Promise<HTMLElement> {
  const existing = queryHeaderBar();
  if (existing) return existing;

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const candidate = queryHeaderBar();
      if (candidate) {
        observer.disconnect();
        resolve(candidate);
      }
    });

    const target = document.body ?? document.documentElement;
    observer.observe(target, { childList: true, subtree: true });
  });
}

function queryHeaderBar(): HTMLElement | null {
  for (const selector of HEADER_SELECTORS) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement) {
      return element;
    }
  }
  return null;
}

function attachRootToHeader(header: HTMLElement) {
  const root = ensureRoot();

  if (!root) return;

  if (state.headerBar !== header) {
    if (state.hiddenHeaderChild) {
      state.hiddenHeaderChild.removeAttribute("data-discord-tabs-hidden");
      state.hiddenHeaderChild = null;
    }
    if (state.hiddenQuickSwitcher) {
      state.hiddenQuickSwitcher.removeAttribute("data-discord-tabs-hidden");
      state.hiddenQuickSwitcher = null;
    }
    state.headerBar = header;
  }

  if (root.parentElement !== header) {
    header.insertBefore(root, header.firstChild ?? null);
  }

  const leftSection = header.querySelector(":scope > div:first-of-type:not(#discord-tabs-root)");
  if (leftSection instanceof HTMLElement) {
    if (state.hiddenHeaderChild && state.hiddenHeaderChild !== leftSection) {
      state.hiddenHeaderChild.removeAttribute("data-discord-tabs-hidden");
    }
    leftSection.setAttribute("data-discord-tabs-hidden", "true");
    state.hiddenHeaderChild = leftSection;
  } else if (state.hiddenHeaderChild) {
    state.hiddenHeaderChild.removeAttribute("data-discord-tabs-hidden");
    state.hiddenHeaderChild = null;
  }

  const quickSwitcher = header.querySelector<HTMLElement>(
    "[role='button'][aria-label*='Quick Switcher']"
  );
  if (quickSwitcher) {
    if (state.hiddenQuickSwitcher && state.hiddenQuickSwitcher !== quickSwitcher) {
      state.hiddenQuickSwitcher.removeAttribute("data-discord-tabs-hidden");
    }
    quickSwitcher.setAttribute("data-discord-tabs-hidden", "true");
    state.hiddenQuickSwitcher = quickSwitcher;
  }

  header.classList.add("discord-tabs-header");
}

function startHeaderWatcher() {
  if (state.headerObserver || !document.body) return;

  const observer = new MutationObserver(() => {
    const header = queryHeaderBar();
    if (header) {
      attachRootToHeader(header);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  state.headerObserver = observer;
  state.cleanupTasks.push(() => {
    observer.disconnect();
    state.headerObserver = null;
  });
}

function attachDebugHelpers() {
  (window as unknown as Record<string, unknown>).DiscordTabsDebug = {
    get state() {
      return JSON.parse(JSON.stringify({
        tabs: state.tabs,
        selectedChannelId: state.selectedChannelId,
        settings: state.settings
      }));
    },
    clearTabs() {
      state.tabs = [];
      persistState();
      renderTabs();
    },
    reload() {
      renderTabs();
    },
    updateSettings(partial: Partial<ExtensionSettings>) {
      state.settings = {
        ...state.settings,
        ...partial
      };
      persistState();
      renderTabs();
    }
  };
}

async function waitForStores(): Promise<DiscordStores> {
  const webpackRequire = await waitForWebpackRequire();

  return new Promise((resolve) => {
    let disposed = false;

    function finish(mod: DiscordStores) {
      if (disposed) return;
      disposed = true;
      disposeObserver();
      state.lastLookupError = null;
      resolve(mod);
    }

    function handleLookupError(error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.lastLookupError !== message) {
        state.lastLookupError = message;
        logger.warn("Module discovery error", error);
      }
    }

    function checkStores() {
      try {
        const modules = findStores(webpackRequire);
        if (modules) {
          finish(modules);
        }
      } catch (error) {
        handleLookupError(error);
      }
    }

    const disposeObserver = observeModuleLoad(checkStores);

    // Initial attempt right away
    checkStores();

    // Fallback log to help debugging if discovery takes too long
    setTimeout(() => {
      if (!disposed) {
        logger.warn("Module lookup taking longer than expected");
      }
    }, 5000);
  });
}

function findStores(webpackRequire: any): DiscordStores | null {
  const cacheEntries = getModuleCacheEntries(webpackRequire);

  const findModule = (matcher: (exp: any) => boolean): any => {
    for (const { exports } of cacheEntries) {
      const unwrapped = unwrapExports(exports);
      if (!unwrapped) continue;
      try {
        if (matcher(unwrapped)) return unwrapped;
      } catch {
        // Ignore modules that throw when inspected.
      }
    }
    return findByFactorySource(matcher, webpackRequire);
  };

  const findByPropSets = (candidates: string[][]): any => {
    for (const props of candidates) {
      const match = findModule((exp) => matchesProps(exp, props));
      if (match) return match;
    }
    return null;
  };

  const SelectedChannelStore = findByPropSets([
    ["getChannelId", "getLastSelectedChannelId"],
    ["getChannelId", "getMostRecentSelectedChannelId"],
    ["getChannelId", "getMostRecentSelectedGuildId"],
    ["getFocusedChannelId", "getChannelId"]
  ]) as DiscordStore;

  const SelectedGuildStore = findByPropSets([
    ["getGuildId", "getLastSelectedGuildId"],
    ["getGuildId", "getMostRecentSelectedGuildId"],
    ["getFocusedGuildId", "getGuildId"]
  ]) as DiscordStore;

  const ChannelStore = findByPropSets([
    ["getChannel", "hasChannel"],
    ["getChannel", "getMutableBasicChannel"],
    ["getBasicChannel", "getMutableBasicChannel"],
    ["getChannel", "getBasicChannel"]
  ]);

  const GuildStore = findByPropSets([
    ["getGuild", "getGuilds"],
    ["getGuild", "getGuildCount"],
    ["getGuild", "hasGuild"],
    ["getGuild", "getGuildIds"]
  ]) ?? null;

  const UserStore =
    findByPropSets([
      ["getUser", "getUsers"],
      ["getUser", "getCurrentUser"],
      ["getCurrentUser", "getUsers"],
      ["getUser", "findUser"]
    ]) ?? findModule((exp) => hasKeysLike(exp, ["getUser"])) ?? null;

  const Constants =
    findModule((exp) => typeof exp?.ChannelTypes === "object") ??
    findModule((exp) => hasKeysLike(exp, ["ChannelTypes", "GUILD_TEXT"])) ??
    null;

  const NavigationUtils = findModule((exp) => hasNavigatorMethods(exp));

  const ChannelActions =
    findByPropSets([
      ["selectChannel", "selectPrivateChannel"],
      ["selectChannel", "selectConnectedChannel"],
      ["selectVoiceChannel", "selectChannel"]
    ]) ?? null;

  const FluxDispatcher =
    findModule(
      (exp) => typeof exp?.dispatch === "function" && typeof exp?.subscribe === "function"
    ) ?? null;

  const UnreadStateStore =
    findByPropSets([
      ["getUnreadCount", "getMentionCount", "hasUnread"],
      ["hasUnread", "getMentionCount"],
      ["getUnreadCount", "getTotalMentionCount"]
    ]) ??
    findModule(
      (exp) => typeof exp?.getUnreadCount === "function" && typeof exp?.hasUnread === "function"
    ) ??
    null;

  const requiredMissing = [
    ["SelectedChannelStore", SelectedChannelStore],
    ["SelectedGuildStore", SelectedGuildStore],
    ["ChannelStore", ChannelStore]
  ].filter(([, value]) => !value);

  if (requiredMissing.length) {
    const signature = requiredMissing.map(([key]) => key).join(", ");
    if (state.lastMissingModules !== signature) {
      state.lastMissingModules = signature;
      logger.info("Still missing modules", signature);
    }
    return null;
  }

  state.lastMissingModules = null;

  return {
    SelectedChannelStore,
    SelectedGuildStore,
    ChannelStore,
    GuildStore,
    UserStore,
    Constants,
    NavigationUtils,
    ChannelActions,
    FluxDispatcher,
    UnreadStateStore
  };
}

function unwrapExports(moduleExports: any): any {
  const visited = new Set<any>();
  function inner(target: any): any {
    if (!target || typeof target !== "object") return target;
    if (visited.has(target)) return target;
    visited.add(target);

    const defaultExport = getSafeProperty(target, "default");
    const targetKeys = getSafeKeys(target);
    if (defaultExport && targetKeys && targetKeys.length <= 2 && isObjectLike(defaultExport)) {
      return inner(defaultExport);
    }

    const zExport = getSafeProperty(target, "Z");
    if (zExport && zExport !== target && isObjectLike(zExport)) {
      return inner(zExport);
    }

    const zpExport = getSafeProperty(target, "ZP");
    if (zpExport && zpExport !== target && isObjectLike(zpExport)) {
      return inner(zpExport);
    }

    return target;
  }

  return inner(moduleExports);
}

function getSafeProperty(target: any, prop: string): any {
  if (!target) return undefined;
  try {
    return (target as Record<string, any>)[prop];
  } catch {
    return undefined;
  }
}

function getSafeKeys(target: any): string[] | null {
  if (!target) return null;
  try {
    return Object.keys(target);
  } catch {
    return null;
  }
}

function isObjectLike(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function matchesProps(target: any, props: string[]): boolean {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
  try {
    const keys = Object.keys(target);
    return props.every((prop) => prop in target || keys.some((key) => key.toLowerCase() === prop.toLowerCase()));
  } catch {
    return false;
  }
}

function hasKeysLike(target: any, props: string[]): boolean {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
  try {
    const keys = Object.keys(target);
    return props.every((prop) => keys.some((key) => key.toLowerCase().includes(prop.toLowerCase())) || prop in target);
  } catch {
    return false;
  }
}

function getModuleCacheEntries(webpackRequire: any): Array<{ id: string | number; exports: unknown }> {
  const cache = webpackRequire?.c;
  if (!cache) return [];

  if (cache instanceof Map) {
    return Array.from(cache.entries()).map(([id, mod]) => ({ id: id as string | number, exports: (mod as { exports?: unknown })?.exports }));
  }

  return Object.entries(cache).map(([id, mod]) => ({ id: id as string | number, exports: (mod as { exports?: unknown })?.exports }));
}

function getModuleFactoryEntries(webpackRequire: any): Array<{ id: string | number; factory: unknown }> {
  const modules = webpackRequire?.m;
  if (!modules) return [];

  if (modules instanceof Map) {
    return Array.from(modules.entries()).map(([id, factory]) => ({ id: id as string | number, factory }));
  }

  return Object.entries(modules).map(([id, factory]) => ({ id: id as string | number, factory }));
}

function findByFactorySource(matcher: (exp: any) => boolean, webpackRequire: any): any {
  for (const { id, factory } of getModuleFactoryEntries(webpackRequire)) {
    if (typeof factory !== "function") continue;

    tryExecuteModule(webpackRequire, id);
    const exports = getModuleExportsById(webpackRequire, id);
    const unwrapped = unwrapExports(exports);
    if (!unwrapped) continue;

    try {
      if (matcher(unwrapped)) return unwrapped;
    } catch {
      // Ignore modules that throw on inspection.
    }
  }
  return DEFAULT_TAB_ICON;
}

function tryExecuteModule(webpackRequire: any, id: string | number): void {
  try {
    webpackRequire(id);
  } catch {
    // Module may not be executable yet; ignore errors.
  }
}

function getModuleExportsById(webpackRequire: any, id: string | number): unknown {
  const cache = webpackRequire?.c;
  if (!cache) return null;

  if (cache instanceof Map) {
    return cache.get(id)?.exports ?? null;
  }

  const mod = cache[id as keyof typeof cache];
  return mod?.exports ?? null;
}

function hasNavigatorMethods(exp: any): boolean {
  if (!exp || typeof exp !== "object") return false;
  return ["transitionTo", "transitionToGuild", "transitionToChannel"].some((key) => typeof exp[key] === "function");
}

function ensureRoot(): HTMLDivElement {
  if (state.root) {
    return state.root;
  }

  const root = document.createElement("div");
  root.id = CONFIG.rootId;
  root.className = "discord-tabs";
  root.style.pointerEvents = "auto";
  root.style.position = "relative";
  root.style.zIndex = "10";
  root.setAttribute("role", "tablist");
  root.addEventListener("click", handleTabClick);
  root.addEventListener("auxclick", handleTabAuxClick);
  root.addEventListener("keydown", handleTabKeydown);
  state.root = root;
  return root;
}

function renderTabs() {
  const root = ensureRoot();
  const header = state.headerBar ?? queryHeaderBar();
  if (header) {
    attachRootToHeader(header);
  }

  ensureActiveTabState();

  root.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const tab of state.tabs) {
    const tabElement = document.createElement("div");
    tabElement.className = "discord-tab";
    tabElement.draggable = state.tabs.length > 1;
    if (tab.id === state.activeTabId) {
      tabElement.classList.add("active");
    }
    tabElement.dataset.tabId = tab.id;
    tabElement.dataset.channelId = tab.channelId;
    tabElement.dataset.guildId = tab.guildId;
    tabElement.setAttribute("role", "tab");
    tabElement.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
    tabElement.tabIndex = tab.id === state.activeTabId ? 0 : -1;

    tabElement.addEventListener("dragstart", handleTabDragStart);
    tabElement.addEventListener("dragend", handleTabDragEnd);
    tabElement.addEventListener("dragover", handleTabDragOver);
    tabElement.addEventListener("dragleave", handleTabDragLeave);
    tabElement.addEventListener("drop", handleTabDrop);

    const iconSpan = document.createElement("span");
    iconSpan.className = "discord-tab__icon";
    const icon = document.createElement("img");
    icon.src = ensureStaticIconUrl(tab.iconUrl) ?? DEFAULT_TAB_ICON;
    icon.alt = "";
    icon.width = 16;
    icon.height = 16;
    icon.decoding = "async";
    icon.loading = "lazy";
    iconSpan.appendChild(icon);

    const nameSpan = document.createElement("span");
    nameSpan.className = "discord-tab__name";
    nameSpan.textContent = tab.title;

    let badgeGroup: HTMLSpanElement | null = null;
    const counts = state.notificationCounts.get(tab.channelId);
    if (counts && tab.id !== state.activeTabId) {
      const mentionCount = Math.max(0, counts.mentions);
      const messageCount = Math.max(0, counts.messages);
      const hasMention = mentionCount > 0;
      const hasMessage = messageCount > 0;
      if (hasMention || hasMessage) {
        badgeGroup = document.createElement("span");
        badgeGroup.className = "discord-tab__badgeGroup";
        if (hasMention) {
          badgeGroup.appendChild(createTabBadge("mention", mentionCount));
          tabElement.classList.add("has-mentions");
        }
        if (hasMessage) {
          badgeGroup.appendChild(createTabBadge("message", messageCount));
        }
        if (badgeGroup.childNodes.length) {
          tabElement.classList.add("has-notifications");
        }
      }
    }

    const closeSpan = document.createElement("span");
    closeSpan.className = "discord-tab__close";
    closeSpan.textContent = "×";
    closeSpan.dataset.tabId = tab.id;
    closeSpan.addEventListener("click", (event) => {
      event.stopPropagation();
      const targetId = (event.currentTarget as HTMLElement | null)?.dataset.tabId;
      if (targetId) {
        removeTab(targetId);
      }
    });

    tabElement.appendChild(iconSpan);
    tabElement.appendChild(nameSpan);
    if (badgeGroup && badgeGroup.childNodes.length) {
      tabElement.appendChild(badgeGroup);
    }
    tabElement.appendChild(closeSpan);
    fragment.appendChild(tabElement);
  }

  root.appendChild(fragment);
}

function formatBadgeCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value > 99) return "99+";
  return String(Math.floor(value));
}

function createTabBadge(kind: "mention" | "message", count: number): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = `discord-tab__badge discord-tab__badge--${kind}`;
  element.textContent = formatBadgeCount(count);
  return element;
}

function ensureToastRoot(): HTMLDivElement | null {
  if (state.toastRoot && document.body?.contains(state.toastRoot)) {
    return state.toastRoot;
  }
  if (!document.body) return null;

  const root = state.toastRoot ?? document.createElement("div");
  root.id = "discord-tabs-toast-root";
  root.className = "discord-tabs-toast-root";
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-atomic", "false");
  document.body.appendChild(root);
  state.toastRoot = root;
  return root;
}

function renderToasts() {
  const root = ensureToastRoot();
  if (!root) return;

  root.textContent = "";
  if (!state.toasts.length) {
    root.style.display = "none";
    return;
  }

  root.style.display = "flex";
  for (const toast of state.toasts) {
    const element = document.createElement("div");
    element.className = `discord-tabs-toast discord-tabs-toast--${toast.kind}`;
    element.dataset.channelId = toast.channelId;
    element.dataset.toastId = toast.id;

    const iconWrapper = document.createElement("span");
    iconWrapper.className = "discord-tabs-toast__icon";
    const icon = document.createElement("img");
    icon.src = ensureStaticIconUrl(toast.iconUrl) ?? DEFAULT_TAB_ICON;
    icon.alt = "";
    icon.width = 32;
    icon.height = 32;
    icon.decoding = "async";
    icon.loading = "lazy";
    iconWrapper.appendChild(icon);

    const content = document.createElement("div");
    content.className = "discord-tabs-toast__content";

    const title = document.createElement("div");
    title.className = "discord-tabs-toast__title";
    title.textContent = toast.title;

    const message = document.createElement("div");
    message.className = "discord-tabs-toast__message";
    message.textContent = toast.message;

    const badge = document.createElement("span");
    badge.className = `discord-tabs-toast__badge discord-tabs-toast__badge--${toast.kind}`;
    badge.textContent = formatBadgeCount(toast.count);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "discord-tabs-toast__dismiss";
    dismiss.textContent = "×";
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();
      dismissToast(toast.id);
    });

    content.appendChild(title);
    content.appendChild(message);

    element.appendChild(iconWrapper);
    element.appendChild(content);
    element.appendChild(badge);
    element.appendChild(dismiss);

    element.addEventListener("click", () => {
      dismissToast(toast.id);
      const linked = state.tabs.find((t) => t.channelId === toast.channelId && t.guildId === toast.guildId);
      if (linked) {
        navigateTo(linked);
      }
    });

    root.appendChild(element);
  }
}

function scheduleToastDismiss(id: string) {
  const existing = state.toastTimers.get(id);
  if (typeof existing === "number") {
    window.clearTimeout(existing);
  }
  const timeout = window.setTimeout(() => dismissToast(id), TOAST_DURATION_MS);
  state.toastTimers.set(id, timeout);
}

function dismissToast(id: string) {
  const index = state.toasts.findIndex((toast) => toast.id === id);
  if (index === -1) return;
  state.toasts.splice(index, 1);
  const timer = state.toastTimers.get(id);
  if (typeof timer === "number") {
    window.clearTimeout(timer);
  }
  state.toastTimers.delete(id);
  renderToasts();
}

function dismissToastsForChannel(channelId: string) {
  const toRemove = state.toasts.filter((toast) => toast.channelId === channelId);
  if (!toRemove.length) return;

  for (const toast of toRemove) {
    const timer = state.toastTimers.get(toast.id);
    if (typeof timer === "number") {
      window.clearTimeout(timer);
      state.toastTimers.delete(toast.id);
    }
  }

  state.toasts = state.toasts.filter((toast) => toast.channelId !== channelId);
  renderToasts();
}

function showNotificationToast(tab: TabEntry, kind: ToastKind, delta: number) {
  if (delta <= 0) return;

  const toastId = `${tab.channelId}:${kind}`;
  const existing = state.toasts.find((toast) => toast.id === toastId);
  const iconUrl = ensureStaticIconUrl(tab.iconUrl) ?? DEFAULT_TAB_ICON;
  const updatedCount = Math.max(1, delta + (existing?.count ?? 0));
  const message = formatToastMessage(kind, updatedCount);

  if (existing) {
    existing.count = updatedCount;
    existing.message = message;
    existing.title = tab.title;
    existing.iconUrl = iconUrl;
    existing.createdAt = Date.now();
    scheduleToastDismiss(toastId);
    renderToasts();
    return;
  }

  const entry: ToastEntry = {
    id: toastId,
    channelId: tab.channelId,
    guildId: tab.guildId,
    title: tab.title,
    kind,
    count: updatedCount,
    iconUrl,
    message,
    createdAt: Date.now()
  };

  state.toasts.unshift(entry);
  scheduleToastDismiss(toastId);
  renderToasts();
}

function formatToastMessage(kind: ToastKind, count: number): string {
  const normalized = count > 99 ? "99+" : String(Math.max(1, Math.floor(count)));
  if (kind === "mention") {
    return normalized === "1"
      ? "New mention"
      : `${normalized} new mentions`;
  }
  return normalized === "1"
    ? "New message"
    : `${normalized} new messages`;
}

function setupNotificationTracking() {
  refreshAllNotificationCounts();
  renderTabs();
  const store = state.stores?.UnreadStateStore;
  if (!store) {
    return;
  }

  const handler = () => handleUnreadStateChange();
  if (typeof store.addChangeListener === "function") {
    store.addChangeListener(handler);
    state.cleanupTasks.push(() => store.removeChangeListener?.(handler));
    handler();
  } else {
    handler();
    const interval = window.setInterval(handler, 2000);
    state.cleanupTasks.push(() => window.clearInterval(interval));
  }
}

function refreshAllNotificationCounts() {
  state.notificationCounts.clear();
  for (const tab of state.tabs) {
    const counts = getNotificationCountsForChannel(tab.channelId);
    if (counts.messages > 0 || counts.mentions > 0) {
      state.notificationCounts.set(tab.channelId, counts);
    }
  }
}

function refreshNotificationCountForChannel(channelId: string) {
  if (!channelId) return;
  const counts = getNotificationCountsForChannel(channelId);
  if (counts.messages > 0 || counts.mentions > 0) {
    state.notificationCounts.set(channelId, counts);
  } else {
    state.notificationCounts.delete(channelId);
  }
}

function getNotificationCountsForChannel(channelId: string): NotificationCounts {
  const store = state.stores?.UnreadStateStore;
  if (!store) {
    return { messages: 0, mentions: 0 };
  }

  const unreadCount = coerceCount(typeof store.getUnreadCount === "function" ? store.getUnreadCount(channelId) : undefined);
  const mentionCount = coerceCount(
    typeof store.getMentionCount === "function"
      ? store.getMentionCount(channelId)
      : typeof store.getUnreadMentions === "function"
        ? store.getUnreadMentions(channelId)
        : undefined
  );

  let messageCount = Math.max(0, unreadCount);
  const safeMentionCount = Math.max(0, mentionCount);

  if (safeMentionCount > 0 && messageCount > 0) {
    messageCount = Math.max(messageCount - safeMentionCount, 0);
  }

  if (messageCount <= 0 && safeMentionCount === 0) {
    if (typeof store.hasUnread === "function" && store.hasUnread(channelId)) {
      messageCount = 1;
    }
  }

  return {
    messages: messageCount,
    mentions: safeMentionCount
  };
}

function handleUnreadStateChange() {
  if (!state.stores?.UnreadStateStore) return;

  let shouldRender = false;

  for (const tab of state.tabs) {
    const previous = state.notificationCounts.get(tab.channelId) ?? { messages: 0, mentions: 0 };
    const current = getNotificationCountsForChannel(tab.channelId);
    const mentionDelta = Math.max(0, current.mentions - previous.mentions);
    const messageDelta = Math.max(0, current.messages - previous.messages);

    if (current.mentions > 0 || current.messages > 0) {
      state.notificationCounts.set(tab.channelId, current);
    } else if (previous.mentions > 0 || previous.messages > 0) {
      state.notificationCounts.delete(tab.channelId);
    }

    if (previous.mentions !== current.mentions || previous.messages !== current.messages) {
      shouldRender = true;
    }

    if (tab.id !== state.activeTabId) {
      if (mentionDelta > 0) {
        showNotificationToast(tab, "mention", mentionDelta);
      } else if (messageDelta > 0) {
        showNotificationToast(tab, "message", messageDelta);
      }
    }
  }

  if (shouldRender) {
    renderTabs();
  }
}

function coerceCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function handleTabClick(event: MouseEvent) {
  if (event.button !== 0) return;
  const tabElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(".discord-tab");
  if (!tabElement || tabElement.closest(".discord-tab__close")) return;

  event.preventDefault();
  event.stopPropagation();
  activateTabElement(tabElement);
}

function handleTabAuxClick(event: MouseEvent) {
  if (event.button !== 1) return;
  const tabElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(".discord-tab");
  if (!tabElement) return;
  event.preventDefault();
  event.stopPropagation();
  const tabId = tabElement.dataset.tabId;
  if (tabId) {
    removeTab(tabId);
  }
}

function handleTabKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const tabElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(".discord-tab");
  if (!tabElement) return;
  event.preventDefault();
  activateTabElement(tabElement);
}

function handleTabDragStart(event: DragEvent) {
  const tabElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!tabElement) return;
  if ((event.target as HTMLElement | null)?.closest(".discord-tab__close")) {
    event.preventDefault();
    return;
  }

  const tabId = tabElement.dataset.tabId;
  if (!tabId) return;

  state.draggingTabId = tabId;
  tabElement.classList.add("dragging");
  clearDragHoverState();

  const transfer = event.dataTransfer;
  if (transfer) {
    transfer.effectAllowed = "move";
    transfer.setData("text/plain", tabId);
  }
}

function handleTabDragEnd(event: DragEvent) {
  const tabElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (tabElement) {
    tabElement.classList.remove("dragging");
  }
  state.draggingTabId = null;
  clearDragHoverState();
}

function handleTabDragOver(event: DragEvent) {
  const tabElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const draggingId = state.draggingTabId;
  if (!tabElement || !draggingId) return;
  const targetId = tabElement.dataset.tabId;
  if (!targetId || targetId === draggingId) return;

  event.preventDefault();
  const transfer = event.dataTransfer;
  if (transfer) {
    transfer.dropEffect = "move";
  }

  const rect = tabElement.getBoundingClientRect();
  const midpoint = rect.left + rect.width / 2;
  const position: "before" | "after" = event.clientX <= midpoint ? "before" : "after";
  updateDragHoverState(tabElement, position);
}

function handleTabDragLeave(event: DragEvent) {
  const tabElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!tabElement) return;
  if (state.dragHoverTabId !== tabElement.dataset.tabId) return;

  const rect = tabElement.getBoundingClientRect();
  if (event.clientX <= rect.left || event.clientX >= rect.right || event.clientY <= rect.top || event.clientY >= rect.bottom) {
    tabElement.classList.remove("drag-hover-before", "drag-hover-after");
    state.dragHoverTabId = null;
    state.dragHoverPosition = null;
  }
}

function reorderTabs(
  tabs: TabEntry[],
  draggingId: string,
  targetId: string,
  position: "before" | "after"
): TabEntry[] | null {
  if (draggingId === targetId) return null;

  const currentIndex = tabs.findIndex((tab) => tab.id === draggingId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);

  if (currentIndex === -1 || targetIndex === -1) {
    return null;
  }

  let insertIndex = targetIndex;
  if (currentIndex < targetIndex) {
    insertIndex -= 1;
  }
  if (position === "after") {
    insertIndex += 1;
  }

  if (insertIndex === currentIndex) {
    return null;
  }

  const next = tabs.slice();
  const [dragged] = next.splice(currentIndex, 1);
  if (!dragged) return null;

  if (insertIndex < 0) {
    insertIndex = 0;
  } else if (insertIndex > next.length) {
    insertIndex = next.length;
  }

  next.splice(insertIndex, 0, dragged);
  return next;
}

function handleTabDrop(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  const tabElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const draggingId = state.draggingTabId ?? event.dataTransfer?.getData("text/plain") ?? null;
  if (!tabElement || !draggingId) {
    clearDragHoverState();
    state.draggingTabId = null;
    return;
  }

  if (!tabElement || !draggingId) {
    clearDragHoverState();
    state.draggingTabId = null;
    return;
  }

  const fallbackTargetId = tabElement.dataset.tabId ?? null;
  const targetId = state.dragHoverTabId ?? fallbackTargetId;
  if (!targetId) {
    const draggingElement = state.root?.querySelector<HTMLElement>(`.discord-tab[data-tab-id="${draggingId}"]`);
    draggingElement?.classList.remove("dragging");
    state.draggingTabId = null;
    clearDragHoverState();
    return;
  }

  const storedPosition = state.dragHoverPosition;
  let position: "before" | "after" = storedPosition ?? "after";
  if (!storedPosition) {
    const rect = tabElement.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    position = event.clientX > midpoint ? "after" : "before";
  }

  const reordered = reorderTabs(state.tabs, draggingId, targetId, position);

  const draggingElement = state.root?.querySelector<HTMLElement>(`.discord-tab[data-tab-id="${draggingId}"]`);
  draggingElement?.classList.remove("dragging");
  state.draggingTabId = null;
  clearDragHoverState();

  if (!reordered) {
    return;
  }

  state.tabs = reordered;

  if (state.activeTabId) {
    const active = getTabById(state.activeTabId);
    state.selectedChannelId = active?.channelId ?? state.selectedChannelId;
  }

  persistState();
  renderTabs();
}

function updateDragHoverState(tabElement: HTMLElement, position: "before" | "after") {
  const targetId = tabElement.dataset.tabId ?? null;
  if (!targetId) return;

  if (state.dragHoverTabId && (state.dragHoverTabId !== targetId || state.dragHoverPosition !== position)) {
    const previous = state.root?.querySelector<HTMLElement>(`.discord-tab[data-tab-id="${state.dragHoverTabId}"]`);
    previous?.classList.remove("drag-hover-before", "drag-hover-after");
  }

  tabElement.classList.remove("drag-hover-before", "drag-hover-after");
  tabElement.classList.add(position === "before" ? "drag-hover-before" : "drag-hover-after");
  state.dragHoverTabId = targetId;
  state.dragHoverPosition = position;
}

function clearDragHoverState() {
  if (!state.dragHoverTabId) return;
  const previous = state.root?.querySelector<HTMLElement>(`.discord-tab[data-tab-id="${state.dragHoverTabId}"]`);
  previous?.classList.remove("drag-hover-before", "drag-hover-after");
  state.dragHoverTabId = null;
  state.dragHoverPosition = null;
}

function activateTabElement(element: HTMLElement) {
  const tab = getTabById(element.dataset.tabId ?? null);
  if (!tab) return;
  logger.info("DiscordTabs: activating tab", {
    id: tab.id,
    channelId: tab.channelId,
    guildId: tab.guildId
  });
  navigateTo(tab);
}

function navigateTo(tab: TabEntry) {
  if (!tab.channelId) {
    logger.warn("DiscordTabs: refusing to navigate - missing channelId", tab);
    return;
  }

  state.activeTabId = tab.id;
  state.selectedChannelId = tab.channelId;
  state.pendingNavigationTabId = tab.id;
  const previousTarget = state.pendingNavigationTarget?.tabId === tab.id ? state.pendingNavigationTarget : null;
  state.pendingNavigationTarget = {
    tabId: tab.id,
    channelId: tab.channelId,
    guildId: tab.guildId,
    startedAt: previousTarget ? previousTarget.startedAt : Date.now(),
    attempts: previousTarget ? previousTarget.attempts : 0
  };
  persistState();
  renderTabs();

  const relativePath = buildTabRelativePath(tab);
  const absolutePath = buildAbsolutePath(relativePath);
  void runNavigationStrategies(tab, relativePath, absolutePath);
}

function attemptDomNavigation(tab: TabEntry, relativePath: string, absolutePath: string): boolean {
  const selectors = [
    `a[href='${relativePath}']`,
    `a[href='${absolutePath}']`,
    `a[href^='${absolutePath}#']`,
    `[data-list-item-id*='${tab.channelId}'] a[href]`,
    `[data-list-item-id*='${tab.guildId}'] a[href]`,
    `a[href*='${tab.channelId}']`
  ];

  for (const selector of selectors) {
    const anchor = document.querySelector(selector) as HTMLAnchorElement | null;
    if (!anchor) continue;
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });
    anchor.dispatchEvent(event);
    anchor.click();
    logger.info("DiscordTabs: navigated via DOM click", { selector, href: anchor.href });
    return true;
  }

  return false;
}

function callChannelActionsSelectChannel(
  channelActions: Nullable<Record<string, (...args: any[]) => void>>,
  guildId: string | null,
  channelId: string
): boolean {
  const fn = channelActions?.selectChannel;
  if (typeof fn !== "function") {
    return false;
  }

  const payload: Record<string, any> = { channelId };
  if (guildId) {
    payload.guildId = guildId;
  }

  let lastError: unknown = null;

  const attempts: Array<() => void> = [
    () => fn(payload)
  ];

  if (guildId) {
    attempts.push(() => fn(guildId, channelId));
  } else {
    attempts.push(() => fn(channelId));
  }

  for (const attempt of attempts) {
    try {
      attempt();
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  logger.warn("DiscordTabs: selectChannel invocation failed", lastError);
  return false;
}

function callTransitionToChannel(
  navigationUtils: Nullable<Record<string, (...args: any[]) => void>>,
  guildId: string | null,
  channelId: string
): boolean {
  const fn = navigationUtils?.transitionToChannel;
  if (typeof fn !== "function") return false;

  const payload = { guildId: guildId ?? undefined, channelId };
  try {
    fn(payload);
    return true;
  } catch (err) {
    try {
      if (guildId) {
        fn(guildId, channelId);
      } else {
        fn(channelId);
      }
      return true;
    } catch (fallbackErr) {
      logger.warn("DiscordTabs: transitionToChannel invocation failed", fallbackErr);
    }
  }

  return false;
}

function callTransitionToGuild(
  navigationUtils: Nullable<Record<string, (...args: any[]) => void>>,
  guildId: string
): boolean {
  const fn = navigationUtils?.transitionToGuild;
  if (typeof fn !== "function") return false;

  try {
    if (fn.length >= 1) {
      fn(guildId);
    } else {
      fn({ guildId });
    }
    return true;
  } catch (err) {
    logger.warn("DiscordTabs: transitionToGuild invocation failed", err);
  }

  return false;
}

async function waitForChannelAvailability(channelId: string, expectedGuildId: string | null, timeoutMs: number): Promise<boolean> {
  if (isFriendsChannelId(channelId)) {
    return true;
  }
  const store = state.stores?.ChannelStore;
  if (typeof store?.getChannel !== "function") {
    return true;
  }

  const validate = () => {
    const channel = store.getChannel?.(channelId);
    if (!channel) return false;
    if (!expectedGuildId || expectedGuildId === "@me") return true;
    return channel.guild_id === expectedGuildId;
  };

  if (validate()) {
    return true;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await wait(75);
    if (validate()) {
      return true;
    }
  }

  logger.warn("DiscordTabs: channel availability timeout", { channelId, expectedGuildId, timeoutMs });
  return false;
}

function isNavigationSatisfied(tab: TabEntry): boolean {
  if (isFriendsChannelId(tab.channelId)) {
    return normalizeAppPath(location.pathname) === normalizeAppPath(buildTabRelativePath(tab));
  }

  const currentChannelId = state.stores?.SelectedChannelStore.getChannelId?.();
  if (currentChannelId && currentChannelId === tab.channelId) {
    return true;
  }

  const currentPath = location.pathname;
  return currentPath.includes(tab.channelId);
}

async function waitForNavigation(tab: TabEntry, stage: string, timeoutMs = 1500): Promise<boolean> {
  if (isNavigationSatisfied(tab)) {
    logger.info("DiscordTabs: navigation confirmed", {
      stage,
      attempt: -1,
      channelId: tab.channelId,
      guildId: tab.guildId,
      path: location.pathname
    });
    return true;
  }

  const SelectedChannelStore = state.stores?.SelectedChannelStore;

  if (!SelectedChannelStore) {
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / 75));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await wait(75);
      if (isNavigationSatisfied(tab)) {
        logger.info("DiscordTabs: navigation confirmed", {
          stage,
          attempt,
          channelId: tab.channelId,
          guildId: tab.guildId,
          path: location.pathname
        });
        return true;
      }
    }

    logger.warn("DiscordTabs: navigation confirmation failed", {
      stage,
      expectedChannelId: tab.channelId,
      currentChannelId: state.stores?.SelectedChannelStore.getChannelId?.(),
      path: location.pathname
    });
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeoutId = window.setTimeout(() => finish(false), timeoutMs);
    const pollInterval = Math.min(100, Math.max(50, timeoutMs / 10));
    const pollId = window.setInterval(check, pollInterval);

    function finish(success: boolean) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(pollId);
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (err) {
          logger.warn("DiscordTabs: navigation listener cleanup failed", err);
        }
      }
      if (success) {
        logger.info("DiscordTabs: navigation confirmed", {
          stage,
          attempt: null,
          channelId: tab.channelId,
          guildId: tab.guildId,
          path: location.pathname
        });
      } else {
        logger.warn("DiscordTabs: navigation confirmation failed", {
          stage,
          expectedChannelId: tab.channelId,
          currentChannelId: state.stores?.SelectedChannelStore.getChannelId?.(),
          path: location.pathname
        });
      }
      resolve(success);
    }

    function check() {
      if (isNavigationSatisfied(tab)) {
        finish(true);
      }
    }

    if (typeof SelectedChannelStore.addChangeListener === "function") {
      const listener = () => check();
      SelectedChannelStore.addChangeListener(listener);
      unsubscribe = () => SelectedChannelStore.removeChangeListener?.(listener);
    } else if (typeof SelectedChannelStore.subscribe === "function") {
      const maybeUnsub = SelectedChannelStore.subscribe(() => check());
      unsubscribe = typeof maybeUnsub === "function" ? maybeUnsub : null;
    }

    check();
  });
}

type NavigationStrategy = {
  name: string;
  execute: () => boolean | void | Promise<boolean | void>;
  shouldAttempt?: () => boolean;
  timeoutMs?: number;
};

async function tryNavigationStrategy(strategy: NavigationStrategy, tab: TabEntry): Promise<boolean> {
  if (isNavigationSatisfied(tab)) {
    return true;
  }

  if (strategy.shouldAttempt && !strategy.shouldAttempt()) {
    return false;
  }

  logger.info("DiscordTabs: attempting navigation strategy", { strategy: strategy.name });

  let executed = false;

  try {
    const result = await strategy.execute();
    executed = result !== false;
  } catch (err) {
    executed = true;
    logger.warn(`DiscordTabs: strategy ${strategy.name} threw`, err);
  }

  if (!executed) {
    logger.info("DiscordTabs: navigation strategy produced no action", { strategy: strategy.name });
    return false;
  }

  const confirmed = await waitForNavigation(tab, strategy.name, strategy.timeoutMs);

  if (!confirmed) {
    logger.info("DiscordTabs: navigation strategy incomplete", { strategy: strategy.name });
  }

  return confirmed;
}

async function runNavigationStrategies(tab: TabEntry, path: string, absolutePath: string): Promise<void> {
  const stores = state.stores;
  const NavigationUtils = stores?.NavigationUtils;
  const ChannelActions = stores?.ChannelActions;
  const fluxDispatcher = stores?.FluxDispatcher;
  const SelectedGuildStore = stores?.SelectedGuildStore;
  const currentGuildId = SelectedGuildStore?.getGuildId?.();
  const isDmTarget = tab.guildId === "@me";
  const guildIdForNavigation = isDmTarget ? null : tab.guildId;
  const isCurrentDm = isDirectMessagesGuildId(currentGuildId);
  const isFriendsTab = isFriendsChannelId(tab.channelId);
  const isDifferentGuild = isDmTarget
    ? !isCurrentDm
    : Boolean(guildIdForNavigation && guildIdForNavigation !== currentGuildId);

  if (isNavigationSatisfied(tab)) {
    logger.info("DiscordTabs: channel already active", {
      channelId: tab.channelId,
      guildId: tab.guildId,
      path
    });
    return;
  }

  if (isDifferentGuild) {
    let contextReady = true;
    if (isDmTarget) {
      contextReady = await ensureDirectMessagesSelected();
    } else if (guildIdForNavigation) {
      contextReady = await ensureGuildSelection(guildIdForNavigation);
    }

    if (!contextReady) {
      logger.warn("DiscordTabs: failed to confirm context selection", {
        targetGuildId: tab.guildId,
        currentGuildId: SelectedGuildStore?.getGuildId?.()
      });
    }
  }

  logger.info("DiscordTabs: navigation utils capabilities", {
    transitionTo: typeof NavigationUtils?.transitionTo,
    transitionToGuild: typeof NavigationUtils?.transitionToGuild,
    transitionToChannel: typeof NavigationUtils?.transitionToChannel
  });

  if (!isFriendsTab && guildIdForNavigation) {
    await waitForChannelAvailability(tab.channelId, guildIdForNavigation, isDifferentGuild ? 2500 : 1500);
  }

  const strategies: NavigationStrategy[] = [];

  const channelTimeout = isDifferentGuild ? 2300 : 1400;
  const dispatcherTimeout = isDifferentGuild ? 2100 : 1200;
  const transitionTimeout = isDifferentGuild ? 1900 : 1100;
  const routerTimeout = isDifferentGuild ? 1600 : 900;

  strategies.push({
    name: "DOM click",
    execute: () => attemptDomNavigation(tab, path, absolutePath),
    timeoutMs: 450
  });

  if (!isFriendsTab && isDifferentGuild && guildIdForNavigation && typeof NavigationUtils?.transitionToGuild === "function") {
    strategies.push({
      name: "NavigationUtils.transitionToGuild",
      execute: () => callTransitionToGuild(NavigationUtils, guildIdForNavigation),
      shouldAttempt: () => SelectedGuildStore?.getGuildId?.() !== guildIdForNavigation,
      timeoutMs: 700
    });
  }

  if (!isFriendsTab && typeof ChannelActions?.selectChannel === "function") {
    strategies.push({
      name: "ChannelActions.selectChannel",
      execute: () => callChannelActionsSelectChannel(ChannelActions, guildIdForNavigation, tab.channelId),
      timeoutMs: channelTimeout
    });
  }

  if (!isFriendsTab && typeof fluxDispatcher?.dispatch === "function") {
    strategies.push({
      name: "FluxDispatcher CHANNEL_SELECT",
      execute: () => {
        const payload: Record<string, any> = {
          type: "CHANNEL_SELECT",
          channelId: tab.channelId,
          context: "discord-tabs"
        };
        if (guildIdForNavigation) {
          payload.guildId = guildIdForNavigation;
        }
        fluxDispatcher!.dispatch(payload);
        return true;
      },
      timeoutMs: dispatcherTimeout
    });
  }

  if (!isFriendsTab && typeof NavigationUtils?.transitionToChannel === "function") {
    strategies.push({
      name: "NavigationUtils.transitionToChannel",
      execute: () => callTransitionToChannel(NavigationUtils, guildIdForNavigation, tab.channelId),
      timeoutMs: transitionTimeout
    });
  }

  if (typeof NavigationUtils?.transitionTo === "function") {
    strategies.push({
      name: "NavigationUtils.transitionTo",
      execute: () => {
        NavigationUtils!.transitionTo(path);
        return true;
      },
      shouldAttempt: () => location.pathname !== path,
      timeoutMs: routerTimeout
    });
  }

  for (const strategy of strategies) {
    const success = await tryNavigationStrategy(strategy, tab);
    if (success) {
      return;
    }
  }

  if (state.pendingNavigationTarget?.tabId === tab.id) {
    state.pendingNavigationTarget = null;
    if (state.pendingNavigationTabId === tab.id) {
      state.pendingNavigationTabId = null;
    }
  }

  logger.warn("DiscordTabs: navigation strategies exhausted", {
    path,
    absolutePath,
    channelId: tab.channelId,
    guildId: tab.guildId,
    currentChannelId: stores?.SelectedChannelStore.getChannelId?.(),
    currentPath: location.pathname
  });
}

async function ensureGuildSelection(targetGuildId: string | null): Promise<boolean> {
  if (!targetGuildId) return true;
  if (targetGuildId === "@me") {
    return ensureDirectMessagesSelected();
  }

  const stores = state.stores;
  const SelectedGuildStore = stores?.SelectedGuildStore;
  const NavigationUtils = stores?.NavigationUtils;
  const fluxDispatcher = stores?.FluxDispatcher;

  if (typeof SelectedGuildStore?.getGuildId !== "function") {
    return true;
  }

  if (SelectedGuildStore.getGuildId?.() === targetGuildId) {
    return true;
  }

  const attemptStrategies = () => {
    let attempted = false;

    if (typeof NavigationUtils?.transitionToGuild === "function") {
      try {
        const fn = NavigationUtils.transitionToGuild;
        if (fn.length >= 1) {
          fn(targetGuildId);
        } else {
          fn({ guildId: targetGuildId });
        }
        attempted = true;
        logger.info("DiscordTabs: issued transitionToGuild", { targetGuildId });
      } catch (err) {
        logger.warn("DiscordTabs: transitionToGuild threw", err);
      }
    }

    if (typeof fluxDispatcher?.dispatch === "function") {
      try {
        fluxDispatcher.dispatch({
          type: "GUILD_SELECT",
          guildId: targetGuildId,
          context: "discord-tabs"
        });
        attempted = true;
        logger.info("DiscordTabs: dispatched GUILD_SELECT", { targetGuildId });
      } catch (err) {
        logger.warn("DiscordTabs: dispatch GUILD_SELECT failed", err);
      }
    }

    if (attemptGuildDomClick(targetGuildId)) {
      attempted = true;
    }

    return attempted;
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attempted = attemptStrategies();
    const waitMs = attempt === 0 ? 500 : 900;
    const success = await waitForGuildSelection(targetGuildId, `guild-ensure#${attempt + 1}`, waitMs);
    if (success) {
      return true;
    }
    if (!attempted) {
      break;
    }
    await wait(40);
  }

  return SelectedGuildStore.getGuildId?.() === targetGuildId;
}

function attemptGuildDomClick(guildId: string): boolean {
  const selectors = [
    `[data-list-item-id='guildsnav___${guildId}']`,
    `[data-list-item-id='guildsnav_${guildId}']`,
    `a[href='/channels/${guildId}']`
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });
    element.dispatchEvent(event);
    if (typeof element.click === "function") {
      element.click();
    }
    logger.info("DiscordTabs: guild navigation via DOM click", { selector });
    return true;
  }

  return false;
}

function isDirectMessagesGuildId(value: unknown): boolean {
  return value == null || value === "@me";
}

function attemptDirectMessageDomClick(): boolean {
  const selectors = [
    "a[href='/channels/@me']",
    "[data-list-item-id='guildsnav___home']",
    "[data-list-item-id='guildsnav___@me']",
    "[data-list-item-id='guildsnav__@me']",
    "[data-nav-item='home']"
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    });
    element.dispatchEvent(event);
    if (typeof element.click === "function") {
      element.click();
    }
    logger.info("DiscordTabs: dm navigation via DOM click", { selector });
    return true;
  }

  return false;
}

async function ensureDirectMessagesSelected(): Promise<boolean> {
  const stores = state.stores;
  const SelectedGuildStore = stores?.SelectedGuildStore;
  const NavigationUtils = stores?.NavigationUtils;
  const fluxDispatcher = stores?.FluxDispatcher;

  if (typeof SelectedGuildStore?.getGuildId !== "function") {
    return true;
  }

  if (isDirectMessagesGuildId(SelectedGuildStore.getGuildId?.())) {
    return true;
  }

  const attemptStrategies = () => {
    let attempted = false;

    if (typeof NavigationUtils?.transitionTo === "function") {
      try {
        NavigationUtils.transitionTo("/channels/@me");
        attempted = true;
        logger.info("DiscordTabs: issued transitionTo @me");
      } catch (err) {
        logger.warn("DiscordTabs: transitionTo('/channels/@me') failed", err);
      }
    }

    if (typeof NavigationUtils?.transitionToGuild === "function") {
      try {
        const fn = NavigationUtils.transitionToGuild;
        if (fn.length >= 1) {
          fn("@me");
        } else {
          fn({ guildId: "@me" });
        }
        attempted = true;
        logger.info("DiscordTabs: invoked transitionToGuild @me");
      } catch (err) {
        try {
          NavigationUtils.transitionToGuild({ guildId: "@me" });
          attempted = true;
          logger.info("DiscordTabs: invoked transitionToGuild @me (fallback)");
        } catch (fallbackErr) {
          logger.warn("DiscordTabs: transitionToGuild('@me') failed", fallbackErr);
        }
      }
    }

    if (typeof fluxDispatcher?.dispatch === "function") {
      try {
        fluxDispatcher.dispatch({
          type: "GUILD_SELECT",
          guildId: null,
          context: "discord-tabs"
        });
        attempted = true;
        logger.info("DiscordTabs: dispatched GUILD_SELECT null");
      } catch (err) {
        logger.warn("DiscordTabs: dispatch GUILD_SELECT null failed", err);
      }
    }

    if (attemptDirectMessageDomClick()) {
      attempted = true;
    }

    return attempted;
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attempted = attemptStrategies();
    const waitMs = attempt === 0 ? 500 : 900;
    const success = await waitForGuildSelection(null, `dm-ensure#${attempt + 1}`, waitMs);
    if (success) {
      return true;
    }
    if (!attempted) {
      break;
    }
    await wait(60);
  }

  return isDirectMessagesGuildId(SelectedGuildStore.getGuildId?.());
}

async function waitForGuildSelection(guildId: string | null, stage: string, timeoutMs = 700): Promise<boolean> {
  const SelectedGuildStore = state.stores?.SelectedGuildStore;
  if (typeof SelectedGuildStore?.getGuildId !== "function") {
    return false;
  }

  const matchesTarget = () => {
    const current = SelectedGuildStore.getGuildId?.();
    if (guildId === null) {
      return isDirectMessagesGuildId(current);
    }
    if (guildId === "@me") {
      return isDirectMessagesGuildId(current);
    }
    return current === guildId;
  };

  if (matchesTarget()) {
    logger.info("DiscordTabs: guild already selected", { stage, guildId: guildId ?? "@me" });
    return true;
  }

  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: (() => void) | null = null;

    const timeout = window.setTimeout(() => finish(false, "timeout"), timeoutMs);

    function check() {
      if (matchesTarget()) {
        finish(true, "store-update");
      }
    }

    function finish(success: boolean, reason: "store-update" | "timeout") {
      if (finished) return;
      finished = true;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (err) {
          logger.warn("DiscordTabs: guild listener cleanup failed", err);
        }
      }
      window.clearTimeout(timeout);
      if (success) {
        logger.info("DiscordTabs: guild selection confirmed", {
          stage,
          guildId: guildId ?? "@me",
          reason
        });
      }
      resolve(success);
    }

    if (typeof SelectedGuildStore.addChangeListener === "function") {
      const listener = () => check();
      SelectedGuildStore.addChangeListener(listener);
      unsubscribe = () => SelectedGuildStore.removeChangeListener?.(listener);
    } else if (typeof SelectedGuildStore.subscribe === "function") {
      const maybeUnsub = SelectedGuildStore.subscribe(() => check());
      unsubscribe = typeof maybeUnsub === "function" ? maybeUnsub : null;
    }
      return matchesTarget();
    check();
  });
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch (err) {
    logger.warn("localStorage unavailable", err);
  }
  return null;
}

async function loadPersistedState(): Promise<void> {
  try {
    const adapter = await resolveStorageAdapter();
    if (!adapter) {
      return;
    }

    const raw = await adapter.getItem(CONFIG.storageKey);
    if (!raw) {
      logger.info("DiscordTabs: no persisted state found");
      return;
    }

    const parsed = JSON.parse(raw);
    let parsedTabs = 0;
    if (Array.isArray(parsed?.tabs)) {
      state.tabs = parsed.tabs
        .map((tab: unknown) => normalizeTabEntry(tab))
        .filter((tab: TabEntry | null): tab is TabEntry => Boolean(tab));
      parsedTabs = state.tabs.length;
    }
    if (typeof parsed?.activeTabId === "string" && parsed.activeTabId.length) {
      state.activeTabId = parsed.activeTabId;
    }
    if (parsed?.settings && typeof parsed.settings === "object") {
      state.settings = {
        ...DEFAULT_SETTINGS,
        ...filterSettings(parsed.settings)
      };
    }

    logger.info("DiscordTabs: restored persisted state", {
      tabCount: parsedTabs,
      activeTabId: state.activeTabId,
      adapter: adapter.kind
    });
  } catch (err) {
    logger.warn("Failed to restore state", err);
  }
}

function hydratePersistedTabs(): void {
  if (!state.stores || state.tabs.length === 0) {
    return;
  }

  const ChannelStore = state.stores.ChannelStore;
  let mutated = false;
  let updated = 0;
  let unresolved = 0;

  state.notificationCounts.clear();

  for (const tab of state.tabs) {
    const previousChannelId = tab.channelId;
    const previousGuildId = tab.guildId;
    const previousTitle = tab.title;
    const previousIcon = tab.iconUrl ?? null;

  const meta = deriveTabMeta(tab.channelId, tab.guildId, tab.title, tab.iconUrl ?? undefined);
    const nextIcon = meta.iconUrl ?? null;

    tab.channelId = meta.channelId;
    tab.guildId = meta.guildId;
    tab.title = meta.title;
    tab.iconUrl = nextIcon;

    if (
      previousChannelId !== tab.channelId ||
      previousGuildId !== tab.guildId ||
      previousTitle !== tab.title ||
      previousIcon !== nextIcon
    ) {
      mutated = true;
      updated += 1;
    }

    if (previousChannelId !== tab.channelId) {
      dismissToastsForChannel(previousChannelId);
    }

    refreshNotificationCountForChannel(tab.channelId);

    if (typeof ChannelStore?.getChannel === "function" && !ChannelStore.getChannel(tab.channelId)) {
      unresolved += 1;
    }
  }

  if (mutated) {
    persistState();
  }

  if (state.tabs.length > 0) {
    logger.info("DiscordTabs: hydrated persisted tabs", {
      total: state.tabs.length,
      metadataUpdated: updated,
      unresolved
    });
  }
}

function persistState() {
  pendingPersistPayload = serializeStateForPersistence();
  if (pendingPersistTimer !== null) {
    return;
  }

  pendingPersistTimer = window.setTimeout(() => {
    pendingPersistTimer = null;
    const payload = pendingPersistPayload;
    pendingPersistPayload = null;
    if (!payload) return;
    void persistStateAsync(payload);
  }, 120);
}

async function persistStateAsync(serialized: string): Promise<void> {
  try {
    const adapter = await resolveStorageAdapter();
    if (!adapter) {
      return;
    }
    await adapter.setItem(CONFIG.storageKey, serialized);
    if (!persistedOnce) {
      persistedOnce = true;
      logger.info("DiscordTabs: persisted state", {
        tabCount: state.tabs.length,
        activeTabId: state.activeTabId,
        adapter: adapter.kind
      });
    }
  } catch (err) {
    logger.warn("Failed to persist state", err);
  }
}

function attemptRestoreLastActiveTab(): RestoreActiveResult {
  if (!state.activeTabId) {
    return "none";
  }

  const tab = getTabById(state.activeTabId);
  if (!tab) {
    state.activeTabId = null;
    persistState();
    return "none";
  }

  if (isNavigationSatisfied(tab)) {
    state.selectedChannelId = tab.channelId;
    logger.info("DiscordTabs: restored session on active channel", {
      tabId: tab.id,
      channelId: tab.channelId,
      guildId: tab.guildId
    });
    return "already-active";
  }

  logger.info("DiscordTabs: restoring last active tab", {
    tabId: tab.id,
    channelId: tab.channelId,
    guildId: tab.guildId
  });
  navigateTo(tab);
  return "navigated";
}

function filterSettings(value: Record<string, unknown>): Partial<ExtensionSettings> {
  const result: Partial<ExtensionSettings> = {};
  if (typeof value.autoOpenOnSwitch === "boolean") {
    result.autoOpenOnSwitch = value.autoOpenOnSwitch;
  }
  if (typeof value.openOnMiddleClick === "boolean") {
    result.openOnMiddleClick = value.openOnMiddleClick;
  }
  if (typeof value.openOnCtrlClick === "boolean") {
    result.openOnCtrlClick = value.openOnCtrlClick;
  }
  return result;
}

type AddTabOptions = {
  makeActive?: boolean;
  skipRender?: boolean;
};

function generateTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTabEntry(value: unknown): TabEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const channelId = typeof record.channelId === "string" ? record.channelId : null;
  const guildId = typeof record.guildId === "string" ? record.guildId : null;
  const title = typeof record.title === "string" ? record.title : null;
  const iconUrl = typeof record.iconUrl === "string" && record.iconUrl.length ? record.iconUrl : null;
  if (!channelId || !guildId || !title) {
    return null;
  }
  const id = typeof record.id === "string" && record.id.length ? record.id : generateTabId();
  return { id, channelId, guildId, title, iconUrl: ensureStaticIconUrl(iconUrl) };
}

function createTabEntry(meta: TabMeta): TabEntry {
  return {
    id: generateTabId(),
    ...meta,
    iconUrl: ensureStaticIconUrl(meta.iconUrl) ?? null
  };
}

function getTabById(id: string | null): TabEntry | null {
  if (!id) return null;
  return state.tabs.find((tab) => tab.id === id) ?? null;
}

function ensureActiveTabState() {
  if (!state.tabs.length) {
    const target = getCurrentChannelTarget();
    if (target) {
      const meta = deriveTabMeta(target.channelId, target.guildId);
      addTab(meta, { makeActive: true, skipRender: true });
    }
    return;
  }

  const hasActive = state.activeTabId ? state.tabs.some((tab) => tab.id === state.activeTabId) : false;
  if (!hasActive) {
    const first = state.tabs[0];
    state.activeTabId = first?.id ?? null;
    state.selectedChannelId = first?.channelId ?? null;
    persistState();
  }
}

function getCurrentChannelTarget(): ChannelLinkTarget | null {
  const pathTarget = parseChannelsPath(location.pathname);
  if (pathTarget) {
    return pathTarget;
  }

  const channelId = state.stores?.SelectedChannelStore.getChannelId?.();
  if (channelId) {
    const guildId = state.stores?.SelectedGuildStore.getGuildId?.() ?? "@me";
    return { channelId, guildId };
  }

  return null;
}

function updateTabFromMeta(tab: TabEntry, meta: TabMeta) {
  const previousChannelId = tab.channelId;
  tab.channelId = meta.channelId;
  tab.guildId = meta.guildId;
  tab.title = meta.title;
  tab.iconUrl = meta.iconUrl ?? null;
  if (tab.id === state.activeTabId) {
    state.selectedChannelId = tab.channelId;
  }
  if (previousChannelId !== tab.channelId) {
    state.notificationCounts.delete(previousChannelId);
    dismissToastsForChannel(previousChannelId);
  }
  refreshNotificationCountForChannel(tab.channelId);
}

function addTab(meta: TabMeta, options: AddTabOptions = {}) {
  const { makeActive = false, skipRender = false } = options;
  const entry = createTabEntry(meta);
  state.tabs.push(entry);
  refreshNotificationCountForChannel(entry.channelId);

  if (state.tabs.length > CONFIG.maxTabs) {
    const removed = state.tabs.shift();
    if (removed?.id === state.activeTabId) {
      state.activeTabId = state.tabs[0]?.id ?? null;
      state.selectedChannelId = state.tabs[0]?.channelId ?? null;
    }
  }

  if (makeActive || !state.activeTabId) {
    state.activeTabId = entry.id;
    state.selectedChannelId = entry.channelId;
  }

  persistState();

  if (!skipRender) {
    renderTabs();
  }

  return entry;
}

function removeTab(tabId: string) {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;

  if (state.draggingTabId === tabId) {
    state.draggingTabId = null;
    clearDragHoverState();
  }

  const [removed] = state.tabs.splice(index, 1);
  state.notificationCounts.delete(removed.channelId);
  dismissToastsForChannel(removed.channelId);
  if (state.pendingNavigationTabId === removed.id) {
    state.pendingNavigationTabId = null;
  }
  if (state.pendingNavigationTarget?.tabId === removed.id) {
    state.pendingNavigationTarget = null;
  }
  let nextActive: TabEntry | null = null;

  if (removed.id === state.activeTabId) {
    nextActive = state.tabs[index] ?? state.tabs[index - 1] ?? state.tabs[0] ?? null;
  }

  if (!state.tabs.length) {
    state.activeTabId = null;
    state.selectedChannelId = null;
  }

  persistState();

  if (nextActive) {
    navigateTo(nextActive);
    return;
  }

  if (state.activeTabId && !state.tabs.some((tab) => tab.id === state.activeTabId)) {
    const fallback = state.tabs[0] ?? null;
    state.activeTabId = fallback?.id ?? null;
    state.selectedChannelId = fallback?.channelId ?? null;
    persistState();
  }

  renderTabs();
}

function installChannelOpenListeners() {
  const ctrlClickHandler = (event: MouseEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (!state.settings.openOnCtrlClick) return;
    handleChannelOpenIntent(event, "ctrl");
  };

  const auxClickHandler = (event: MouseEvent) => {
    if (event.button !== 1) return;
    if (!state.settings.openOnMiddleClick) return;
    handleChannelOpenIntent(event, "middle");
  };

  document.addEventListener("click", ctrlClickHandler, true);
  document.addEventListener("auxclick", auxClickHandler, true);

  state.cleanupTasks.push(() => {
    document.removeEventListener("click", ctrlClickHandler, true);
    document.removeEventListener("auxclick", auxClickHandler, true);
  });
}

type ChannelOpenTrigger = "ctrl" | "middle";

function handleChannelOpenIntent(event: MouseEvent, _trigger: ChannelOpenTrigger) {
  const anchor = findChannelLink(event.target as Node | null);
  if (!anchor) return;
  if (!isChannelNavigationLink(anchor)) return;

  const target = parseChannelLink(anchor);
  if (!target) return;

  event.preventDefault();
  event.stopPropagation();

  const fallbackTitle = extractChannelTitle(anchor);
  const fallbackIcon = extractChannelIcon(anchor);
  const meta = deriveTabMeta(target.channelId, target.guildId, fallbackTitle ?? undefined, fallbackIcon ?? undefined);
  addTab(meta, { makeActive: false });
}

function findChannelLink(node: Node | null): HTMLAnchorElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLAnchorElement) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function isChannelNavigationLink(anchor: HTMLAnchorElement): boolean {
  if (anchor.closest(`#${CONFIG.rootId}`)) return false;
  const href = anchor.getAttribute("href") ?? "";
  if (!href.startsWith("/channels/")) return false;
  const inSidebar = Boolean(anchor.closest("[class*='sidebar_']"));
  const inPrivateChannels = Boolean(anchor.closest("[class*='privateChannels']"));
  return inSidebar || inPrivateChannels;
}

function parseChannelLink(anchor: HTMLAnchorElement): ChannelLinkTarget | null {
  const href = anchor.getAttribute("href") ?? "";
  const directTarget = parseChannelsPath(href);
  if (directTarget) {
    return directTarget;
  }

  try {
    const url = new URL(anchor.href);
    return parseChannelsPath(url.pathname);
  } catch {
    return null;
  }
}

function extractChannelTitle(anchor: HTMLAnchorElement): string | null {
  const ariaLabel = anchor.getAttribute("aria-label");
  if (ariaLabel) {
    return ariaLabel.replace(/ – unread.*$/i, "").trim();
  }
  const text = anchor.textContent?.trim();
  return text && text.length ? text : null;
}

function extractChannelIcon(anchor: HTMLAnchorElement): string | null {
  const imageCandidate = anchor.querySelector<HTMLImageElement>("img[src]");
  if (imageCandidate?.src) {
    return imageCandidate.src;
  }

  const styledElement = anchor.querySelector<HTMLElement>("[style*='background-image']");
  if (styledElement) {
    const style = styledElement.getAttribute("style") ?? "";
    const match = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (match && match[2]) {
      return match[2];
    }
  }

  const siblingImage = anchor.previousElementSibling?.querySelector?.("img[src]") as HTMLImageElement | undefined;
  if (siblingImage?.src) {
    return siblingImage.src;
  }

  return null;
}

function wireChannelListener() {
  const stores = state.stores;
  if (!stores) return;

  const handler = () => onChannelSwitch();
  const { SelectedChannelStore } = stores;

  if (typeof SelectedChannelStore?.addChangeListener === "function") {
    SelectedChannelStore.addChangeListener(handler);
    state.cleanupTasks.push(() => SelectedChannelStore.removeChangeListener?.(handler));
    return;
  }

  if (typeof SelectedChannelStore?.subscribe === "function") {
    const unsubscribe = SelectedChannelStore.subscribe(handler);
    if (typeof unsubscribe === "function") {
      state.cleanupTasks.push(unsubscribe);
    }
  }
}

function teardown() {
  for (const dispose of state.cleanupTasks.splice(0)) {
    try {
      dispose();
    } catch (err) {
      logger.warn("Listener cleanup failed", err);
    }
  }

  if (state.hiddenHeaderChild) {
    state.hiddenHeaderChild.removeAttribute("data-discord-tabs-hidden");
    state.hiddenHeaderChild = null;
  }

  if (state.hiddenQuickSwitcher) {
    state.hiddenQuickSwitcher.removeAttribute("data-discord-tabs-hidden");
    state.hiddenQuickSwitcher = null;
  }

  if (state.headerObserver) {
    state.headerObserver.disconnect();
    state.headerObserver = null;
  }

  for (const timeout of state.toastTimers.values()) {
    window.clearTimeout(timeout);
  }
  state.toastTimers.clear();
  state.toasts = [];

  if (state.toastRoot?.parentElement) {
    state.toastRoot.parentElement.removeChild(state.toastRoot);
  }
  state.toastRoot = null;
  state.notificationCounts.clear();

  if (state.root?.parentElement) {
    state.root.parentElement.removeChild(state.root);
  }
  state.root = null;
}

function onChannelSwitch() {
  const header = queryHeaderBar();
  if (header) {
    attachRootToHeader(header);
  }

  const target = getCurrentChannelTarget();
  if (!target) {
    logger.info("No channel selected yet");
    return;
  }

  const existingTabMatch = state.tabs.find((tab) => tab.channelId === target.channelId && tab.guildId === target.guildId) ?? null;
  const meta = deriveTabMeta(
    target.channelId,
    target.guildId,
    existingTabMatch?.title ?? undefined,
    existingTabMatch?.iconUrl ?? undefined
  );
  const pendingTabId = state.pendingNavigationTabId;
  const pendingTarget = state.pendingNavigationTarget;
  const matchesPending = Boolean(
    pendingTabId &&
    pendingTarget &&
    pendingTarget.tabId === pendingTabId &&
    pendingTarget.channelId === meta.channelId &&
    pendingTarget.guildId === meta.guildId
  );

  if (pendingTabId && pendingTarget && !matchesPending) {
    const elapsed = Date.now() - pendingTarget.startedAt;
    const tabEntry = getTabById(pendingTabId);
    if (tabEntry && pendingTarget.attempts < 3 && elapsed < 4000) {
      pendingTarget.attempts += 1;
      logger.info("DiscordTabs: pending navigation mismatch", {
        tabId: pendingTabId,
        expected: {
          channelId: pendingTarget.channelId,
          guildId: pendingTarget.guildId
        },
        actual: {
          channelId: meta.channelId,
          guildId: meta.guildId
        },
        attempt: pendingTarget.attempts,
        elapsed
      });
      window.setTimeout(() => navigateTo(tabEntry), 50);
    } else {
      logger.warn("DiscordTabs: pending navigation abandoned", {
        tabId: pendingTabId,
        expected: {
          channelId: pendingTarget.channelId,
          guildId: pendingTarget.guildId
        },
        actual: {
          channelId: meta.channelId,
          guildId: meta.guildId
        },
        attempts: pendingTarget.attempts,
        elapsed
      });
      state.pendingNavigationTabId = null;
      state.pendingNavigationTarget = null;
    }

    state.selectedChannelId = meta.channelId;
    state.notificationCounts.delete(meta.channelId);
    dismissToastsForChannel(meta.channelId);
    return;
  }

  state.pendingNavigationTabId = null;
  if (matchesPending) {
    state.pendingNavigationTarget = null;
  }

  let activeTab: TabEntry | null = matchesPending && pendingTabId ? getTabById(pendingTabId) : null;

  if (!activeTab) {
    activeTab = getTabById(state.activeTabId);
  }

  if (!activeTab) {
    activeTab = existingTabMatch;
  }

  if (!activeTab) {
    activeTab = addTab(meta, { makeActive: true, skipRender: true });
  } else {
    updateTabFromMeta(activeTab, meta);
    state.activeTabId = activeTab.id;
  }

  state.selectedChannelId = meta.channelId;
  state.notificationCounts.delete(meta.channelId);
  dismissToastsForChannel(meta.channelId);

  if (state.settings.autoOpenOnSwitch) {
    const existing = state.tabs.find((tab) => tab.channelId === meta.channelId && tab.guildId === meta.guildId);
    if (!existing) {
      addTab(meta, { makeActive: false, skipRender: true });
    }
  }

  persistState();
  renderTabs();
}

function deriveTabMeta(
  channelId: string,
  guildId: string,
  fallbackTitle?: string,
  fallbackIcon?: string | null
): TabMeta {
  const normalizedFallbackIcon = ensureStaticIconUrl(fallbackIcon ?? null);

  if (isFriendsChannelId(channelId)) {
    return {
      channelId,
      guildId: "@me",
      title: resolveFriendsTitle(channelId, fallbackTitle),
      iconUrl: resolveFriendsIcon(normalizedFallbackIcon ?? null)
    };
  }

  const stores = state.stores;
  if (!stores) {
    return {
      channelId,
      guildId,
      title: fallbackTitle ?? channelId,
      iconUrl: normalizedFallbackIcon ?? DEFAULT_TAB_ICON
    };
  }

  const channel = stores.ChannelStore.getChannel?.(channelId) ?? null;
  if (!channel) {
    return {
      channelId,
      guildId,
      title: fallbackTitle ?? `Unknown ${channelId}`,
      iconUrl: normalizedFallbackIcon ?? DEFAULT_TAB_ICON
    };
  }

  const channelType = channel.type;
  const ChannelTypes = stores.Constants?.ChannelTypes ?? {
    DM: 1,
    GROUP_DM: 3,
    GUILD_VOICE: 2,
    GUILD_CATEGORY: 4
  };

  switch (channelType) {
    case ChannelTypes?.DM:
    case ChannelTypes?.GROUP_DM: {
      const recipientId = channel.recipients?.[0];
      const userStore = stores.UserStore;
      const rawRecipient = Array.isArray(channel.rawRecipients)
        ? channel.rawRecipients[0] ?? null
        : null;
      const recipient = recipientId ? userStore?.getUser?.(recipientId) ?? rawRecipient : rawRecipient;
      const fallbackName = rawRecipient?.globalName || rawRecipient?.username || null;
      const name = recipient?.globalName
        || recipient?.username
        || fallbackName
        || channel.name
        || `DM ${recipientId ?? channelId}`;
      return {
        channelId,
        guildId: "@me",
        title: name,
        iconUrl: resolveDirectMessageIcon(channelId, channel, recipient, rawRecipient, recipientId)
          ?? normalizedFallbackIcon
          ?? DEFAULT_TAB_ICON
      };
    }
    case ChannelTypes?.GUILD_VOICE:
      return {
        channelId,
        guildId,
        title: `🔊 ${channel.name}`,
        iconUrl: resolveGuildChannelIcon(guildId) ?? normalizedFallbackIcon ?? DEFAULT_TAB_ICON
      };
    case ChannelTypes?.GUILD_CATEGORY:
      return {
        channelId,
        guildId,
        title: `📁 ${channel.name}`,
        iconUrl: resolveGuildChannelIcon(guildId) ?? normalizedFallbackIcon ?? DEFAULT_TAB_ICON
      };
    default:
      return {
        channelId,
        guildId,
        title: channel.name || fallbackTitle || `Channel ${channelId}`,
        iconUrl: resolveGuildChannelIcon(guildId) ?? normalizedFallbackIcon ?? DEFAULT_TAB_ICON
      };
  }
}

function resolveGuildChannelIcon(guildId: string): string | null {
  if (!guildId || guildId === "@me") return null;
  const stores = state.stores;
  const guild = stores?.GuildStore?.getGuild?.(guildId);
  if (!guild) return DEFAULT_TAB_ICON;

  try {
    if (typeof guild.getIconURL === "function") {
      const iconUrl = ensureStaticIconUrl(guild.getIconURL(false, 64, "png"));
      if (iconUrl) return iconUrl;
    }
  } catch (err) {
    logger.warn("resolveGuildChannelIcon#getIconURL failed", err);
  }

  const iconHash = guild.icon ?? guild.getIcon?.();
  const guildIdValue = guild.id ?? guildId;
  if (typeof iconHash === "string" && iconHash.length && typeof guildIdValue === "string") {
    const url = `https://cdn.discordapp.com/icons/${guildIdValue}/${iconHash}.png?size=64`;
    return ensureStaticIconUrl(url) ?? DEFAULT_TAB_ICON;
  }

  return DEFAULT_TAB_ICON;
}

function resolveDirectMessageIcon(
  channelId: string,
  channel: any,
  recipient: any,
  rawRecipient: any,
  recipientId: string | undefined
): string | null {
  const groupIconHash = channel?.icon;
  if (typeof groupIconHash === "string" && groupIconHash.length) {
    const url = `https://cdn.discordapp.com/channel-icons/${channelId}/${groupIconHash}.png?size=64`;
    const ensured = ensureStaticIconUrl(url);
    if (ensured) {
      return ensured;
    }
  }

  const candidate = recipient ?? rawRecipient ?? null;

  try {
    const maybeGetAvatar = candidate?.getAvatarURL ?? channel?.getAvatarURL;
    if (typeof maybeGetAvatar === "function") {
      const avatarUrl = ensureStaticIconUrl(maybeGetAvatar.call(candidate, false, 64, "png"));
      if (avatarUrl) {
        return avatarUrl;
      }
    }
  } catch (err) {
    logger.warn("resolveDirectMessageIcon#getAvatarURL failed", err);
  }

  const candidateId = candidate?.id ?? candidate?.userId ?? candidate?.user_id ?? recipientId;

  const avatarHash = typeof candidate?.avatar === "string" && !candidate.avatar.startsWith("http")
    ? candidate.avatar
    : typeof candidate?.avatarHash === "string"
      ? candidate.avatarHash
      : typeof rawRecipient?.avatar === "string" && !rawRecipient.avatar.startsWith("http")
        ? rawRecipient.avatar
        : typeof rawRecipient?.avatarHash === "string"
          ? rawRecipient.avatarHash
          : null;

  if (avatarHash && typeof candidateId === "string") {
    const url = `https://cdn.discordapp.com/avatars/${candidateId}/${avatarHash}.png?size=64`;
    const ensured = ensureStaticIconUrl(url);
    if (ensured) {
      return ensured;
    }
  }

  const directUrlCandidates = [
    candidate?.avatar,
    candidate?.avatarUrl,
    candidate?.avatarURL,
    candidate?.avatar_url,
    rawRecipient?.avatar,
    rawRecipient?.avatarUrl,
    rawRecipient?.avatarURL,
    rawRecipient?.avatar_url
  ];

  for (const value of directUrlCandidates) {
    if (typeof value === "string" && value.length && value.startsWith("http")) {
      const ensured = ensureStaticIconUrl(value);
      if (ensured) {
        return ensured;
      }
    }
  }

  const discriminator = candidate?.discriminator ?? candidate?.user?.discriminator ?? rawRecipient?.discriminator ?? null;

  return buildFallbackAvatar(candidateId, discriminator);
}

function buildFallbackAvatar(userId: string | undefined, discriminator: string | null): string | null {
  const source = typeof discriminator === "string" && discriminator.length
    ? discriminator
    : typeof userId === "string"
      ? userId
      : null;
  if (!source) {
    return DEFAULT_TAB_ICON;
  }

  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

main();
