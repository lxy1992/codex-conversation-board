import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_CODEX_GLOBAL_STATE_PATH = resolve(
  process.env.CODEX_HOME || resolve(homedir(), ".codex"),
  ".codex-global-state.json",
);

const PERSISTED_ATOM_STATE_KEY = "electron-persisted-atom-state";
const UNREAD_THREAD_IDS_KEY = "unread-thread-ids-by-host-v1";
const THREAD_READ_STATE_KEY = "electron-thread-read-state-v1";

/**
 * 汇总新版 Codex 按账号身份和执行主机隔离保存的未读对话。
 * 对话 ID 本身全局唯一，看板只需判断 ID 是否未读，不需要反推出内部哈希主机键。
 */
function readIdentityScopedUnreadIds(root) {
  const unreadByIdentity = root?.[THREAD_READ_STATE_KEY]?.unreadByIdentity;
  if (!unreadByIdentity || typeof unreadByIdentity !== "object") return null;

  const ids = new Set();
  for (const unreadByHost of Object.values(unreadByIdentity)) {
    if (!unreadByHost || typeof unreadByHost !== "object") continue;
    for (const values of Object.values(unreadByHost)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === "string") ids.add(value);
      }
    }
  }
  return ids;
}

/**
 * 读取 Codex 桌面端自己维护的未读对话集合。
 * 该字段正是原生侧栏蓝点使用的持久化状态，因此看板不再根据完成事件猜测未读。
 */
export async function readNativeUnreadThreadIds({
  filePath = process.env.CODEX_GLOBAL_STATE_PATH || DEFAULT_CODEX_GLOBAL_STATE_PATH,
  hostId = "local",
} = {}) {
  const root = JSON.parse(await readFile(filePath, "utf8"));

  // Codex 26.903 起使用身份隔离的新结构；只要它存在，就以它为准，避免旧迁移数据产生假未读。
  const identityScopedIds = readIdentityScopedUnreadIds(root);
  if (identityScopedIds) return identityScopedIds;

  // 兼容旧版 Codex：旧结构直接按公开 hostId 保存未读 ID。
  const ids = root?.[PERSISTED_ATOM_STATE_KEY]?.[UNREAD_THREAD_IDS_KEY]?.[hostId];
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.filter((value) => typeof value === "string"));
}
