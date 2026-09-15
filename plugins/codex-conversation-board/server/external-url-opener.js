import { execFile } from "node:child_process";

const ALLOWED_PROTOCOLS = new Set(["codex:", "claude:"]);

function commandForPlatform(platform, url) {
  if (platform === "darwin") return { file: "/usr/bin/open", args: [url] };
  if (platform === "win32") return { file: "explorer.exe", args: [url] };
  return { file: "xdg-open", args: [url] };
}

/**
 * 通过操作系统注册的 URL Scheme 打开 Codex 或 Claude。
 *
 * 仅允许固定协议，并使用 execFile 而不是 shell，避免会话标题或 ID 被解释为命令。
 */
export class ExternalUrlOpener {
  constructor({ platform = process.platform, execFileFn = execFile } = {}) {
    this.platform = platform;
    this.execFileFn = execFileFn;
  }

  async open(value) {
    let url;
    try {
      url = new URL(String(value ?? ""));
    } catch {
      throw new Error("无效的应用链接");
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw new Error(`不允许打开 ${url.protocol || "未知"} 链接`);
    }
    const target = url.toString();
    const { file, args } = commandForPlatform(this.platform, target);
    await new Promise((resolveOpen, rejectOpen) => {
      this.execFileFn(file, args, { timeout: 5_000 }, (error) => {
        if (error) rejectOpen(new Error(`无法打开对话：${error.message}`));
        else resolveOpen();
      });
    });
    return { navigated: true, navigation: "external-deep-link" };
  }
}

export const externalUrlOpenerInternals = { ALLOWED_PROTOCOLS, commandForPlatform };
