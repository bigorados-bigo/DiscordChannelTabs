const PREFIX = "[DiscordTabs]";

export const logger = {
  info: (...args: unknown[]) => {
    console.info(PREFIX, ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(PREFIX, ...args);
  },
  error: (...args: unknown[]) => {
    console.error(PREFIX, ...args);
  }
};
