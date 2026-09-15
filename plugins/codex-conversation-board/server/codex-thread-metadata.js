import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || resolve(homedir(), ".codex");

export const DEFAULT_CODEX_THREAD_CATALOG_PATH = resolve(CODEX_HOME, "sqlite/codex-dev.db");

let sqliteModulePromise = null;

function sqliteModule() {
  sqliteModulePromise ??= import("node:sqlite");
  return sqliteModulePromise;
}

function cleanTitle(value) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!result) return null;
  return result.length > 180 ? `${result.slice(0, 177)}…` : result;
}

/**
 * 从 Codex 桌面端的本机目录批量读取卡片标题。
 *
 * 这条路径只读取标题字段，不启动新的 App Server，也不读取消息正文；因此可以跟随
 * 现有的五秒活动轮询运行，让已经打开的看板及时同步原生侧栏里的改名结果。
 */
export class CodexThreadMetadataService {
  constructor({
    catalogPath = process.env.CODEX_THREAD_CATALOG_PATH || DEFAULT_CODEX_THREAD_CATALOG_PATH,
    logger = null,
  } = {}) {
    this.catalogPath = catalogPath;
    this.logger = logger;
    this.lastReportedError = null;
  }

  async read(threadIds) {
    const ids = [...new Set((Array.isArray(threadIds) ? threadIds : []).map(String))]
      .filter(Boolean);
    if (ids.length === 0) return {};

    try {
      await access(this.catalogPath);
      const { DatabaseSync } = await sqliteModule();
      const database = new DatabaseSync(this.catalogPath, { readOnly: true });
      try {
        const placeholders = ids.map(() => "?").join(", ");
        const rows = database.prepare(`
          SELECT thread_id, display_title
          FROM local_thread_catalog
          WHERE thread_id IN (${placeholders})
            AND source_kind <> 'chatgpt'
            AND missing_candidate = 0
          ORDER BY COALESCE(source_recency_at, source_updated_at, source_created_at, 0) DESC
        `).all(...ids);
        const requested = new Set(ids);
        const metadata = {};
        for (const row of rows) {
          if (!requested.has(row.thread_id) || metadata[row.thread_id]) continue;
          const title = cleanTitle(row.display_title);
          if (title) metadata[row.thread_id] = { title };
        }
        this.lastReportedError = null;
        return metadata;
      } finally {
        database.close();
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error.message !== this.lastReportedError) {
        this.logger?.error?.(`读取 Codex 对话标题失败: ${error.message}`);
        this.lastReportedError = error.message;
      }
      return {};
    }
  }
}

export const codexThreadMetadataInternals = { cleanTitle };
