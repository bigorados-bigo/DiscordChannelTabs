/*
 * Storage bridge executed in the isolated world so it can access chrome.storage APIs.
 * It listens for window.postMessage events from the main content script (running in the
 * page world) and proxies persistence requests to chrome.storage.local.
 */

const CHANNEL = "discord-tabs-storage" as const;

type StorageAction = "ping" | "get" | "set" | "remove";

type StorageRequest = {
  channel: typeof CHANNEL;
  direction: "request";
  requestId: string;
  action: StorageAction;
  key?: string;
  value?: unknown;
};

type StorageResponse = {
  channel: typeof CHANNEL;
  direction: "response";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

declare const chrome: typeof globalThis extends { chrome: infer T } ? T : any;

function postResponse(base: Pick<StorageResponse, "requestId"> & Partial<StorageResponse>, target: Window) {
  const payload: StorageResponse = {
    channel: CHANNEL,
    direction: "response",
    ok: base.ok ?? false,
    requestId: base.requestId,
    value: base.value,
    error: base.error
  };
  target.postMessage(payload, "*");
}

async function handleRequest(event: MessageEvent<StorageRequest>) {
  const { data, source } = event;
  if (!source || source !== window) return;
  if (!data || data.channel !== CHANNEL || data.direction !== "request") return;

  const { requestId, action, key, value } = data;

  try {
    switch (action) {
      case "ping": {
        postResponse({ requestId, ok: true }, window);
        return;
      }
      case "get": {
        if (!key) throw new Error("Missing key for storage get");
        const result = await chrome.storage.local.get(key);
        postResponse({ requestId, ok: true, value: result?.[key] ?? null }, window);
        return;
      }
      case "set": {
        if (!key) throw new Error("Missing key for storage set");
        await chrome.storage.local.set({ [key]: value });
        postResponse({ requestId, ok: true }, window);
        return;
      }
      case "remove": {
        if (!key) throw new Error("Missing key for storage remove");
        await chrome.storage.local.remove(key);
        postResponse({ requestId, ok: true }, window);
        return;
      }
      default:
        throw new Error(`Unsupported action: ${String(action)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postResponse({ requestId, ok: false, error: message }, window);
  }
}

window.addEventListener("message", (event) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  void handleRequest(event as MessageEvent<StorageRequest>);
});
