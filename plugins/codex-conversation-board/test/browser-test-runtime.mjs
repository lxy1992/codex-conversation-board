import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PACKAGED_PLAYWRIGHT = "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const path = process.env.PLAYWRIGHT_MODULE_PATH || PACKAGED_PLAYWRIGHT;
    if (!existsSync(path)) return null;
    return import(pathToFileURL(path).href);
  }
}

function browserExecutable(chromium) {
  const candidates = [
    process.env.BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const external = candidates.find((path) => path && existsSync(path));
  if (external) return external;
  try {
    const bundled = chromium.executablePath();
    return bundled && existsSync(bundled) ? bundled : null;
  } catch {
    return null;
  }
}

/**
 * 浏览器验收属于可选的端到端测试。公开仓库的贡献者若没有 Playwright 或
 * Chromium，测试会明确跳过，而不是依赖开发者电脑上的固定应用路径。
 */
export async function loadBrowserRuntime(testContext) {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    testContext.skip("Playwright is not installed; set PLAYWRIGHT_MODULE_PATH to enable browser tests");
    return null;
  }
  const executablePath = browserExecutable(playwright.chromium);
  if (!executablePath) {
    testContext.skip("Chromium is not installed; set BROWSER_PATH to enable browser tests");
    return null;
  }
  return {
    chromium: playwright.chromium,
    launchOptions: { executablePath, headless: true },
  };
}

export const browserTestRuntimeInternals = { browserExecutable, loadPlaywright };
