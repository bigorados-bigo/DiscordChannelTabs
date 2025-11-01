import { logger } from "../shared/logger";

type WebpackRequire = {
  (moduleId: string | number): unknown;
  c: Record<string | number, { exports: unknown }>;
  m: Record<string | number, (module: unknown, exports: unknown, require: WebpackRequire) => void>;
};

let cachedRequire: WebpackRequire | null = null;

export async function waitForWebpackRequire(): Promise<WebpackRequire> {
  if (cachedRequire) return cachedRequire;

  await waitForChunkArray();

  const chunkArray = (window as unknown as Record<string, any>).webpackChunkdiscord_app as unknown[];

  return new Promise((resolve, reject) => {
    try {
      chunkArray.push([
        [Symbol("discord-tabs-hook")],
        {},
        (require: WebpackRequire) => {
          cachedRequire = require;
          resolve(require);
        }
      ]);
    } catch (err) {
      reject(err);
    }
  });
}

async function waitForChunkArray(): Promise<void> {
  const win = window as unknown as Record<string, any>;
  if (Array.isArray(win.webpackChunkdiscord_app)) return;

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (Array.isArray(win.webpackChunkdiscord_app)) {
        clearInterval(interval);
        resolve();
      }
    }, 25);
  });
}

export function observeModuleLoad(onUpdate: () => void): () => void {
  const chunkArray = (window as unknown as Record<string, any>).webpackChunkdiscord_app as unknown[];
  const originalPush = chunkArray.push.bind(chunkArray);

  function patchedPush(...args: unknown[]) {
    const result = originalPush(...args);
    try {
      onUpdate();
    } catch (err) {
      logger.warn("Module observer error", err);
    }
    return result;
  }

  chunkArray.push = patchedPush as typeof chunkArray.push;

  return () => {
    chunkArray.push = originalPush;
  };
}
