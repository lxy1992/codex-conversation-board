export const BOARD_COLUMNS = Object.freeze([
  { id: "inbox", label: "收件箱", description: "刚出现、尚未分类", color: "#8590A2", required: true },
  { id: "todo", label: "待处理", description: "已经明确，等待开始", color: "#0C66E4", required: false },
  { id: "doing", label: "进行中", description: "当前正在推进", color: "#6E5DC6", required: false },
  { id: "blocked", label: "阻塞", description: "等待输入、审批或外部条件", color: "#C9372C", required: false },
  { id: "review", label: "待验收", description: "工作完成，等待确认", color: "#E56910", required: false },
  { id: "done", label: "完成", description: "已经结束", color: "#1F845A", required: true },
].map(Object.freeze));

export const BOARD_STATUS_IDS = new Set(BOARD_COLUMNS.map((column) => column.id));
export const REQUIRED_BOARD_STATUS_IDS = new Set(["inbox", "done"]);
export const BOARD_COLUMN_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_BOARD_COLUMNS = 12;

const DEFAULT_COLUMN_BY_ID = new Map(BOARD_COLUMNS.map((column) => [column.id, column]));

/**
 * 校验并规范化用户定义的泳道。状态 ID 是持久化主键，显示名称、说明、颜色和
 * 排序都可以修改；inbox 与 done 保留固定 ID，以继续承载新对话和完成回流语义。
 */
export function normalizeBoardColumns(value) {
  if (!Array.isArray(value)) throw new Error("状态设置必须是数组");
  if (value.length < REQUIRED_BOARD_STATUS_IDS.size) throw new Error("看板至少需要收件箱和完成两个状态");
  if (value.length > MAX_BOARD_COLUMNS) throw new Error(`看板最多支持 ${MAX_BOARD_COLUMNS} 个状态`);

  const ids = new Set();
  const labels = new Set();
  const columns = value.map((item, index) => {
    const id = String(item?.id ?? "").trim().toLowerCase();
    const label = String(item?.label ?? "").trim();
    const description = String(item?.description ?? "").trim();
    const fallbackColor = DEFAULT_COLUMN_BY_ID.get(id)?.color ?? "#8590A2";
    const color = String(item?.color ?? fallbackColor).trim().toUpperCase();

    if (!BOARD_COLUMN_ID_PATTERN.test(id)) throw new Error(`第 ${index + 1} 个状态的 ID 无效`);
    if (ids.has(id)) throw new Error(`状态 ID 重复：${id}`);
    if (!label || label.length > 24) throw new Error(`第 ${index + 1} 个状态名称必须为 1-24 个字符`);
    const normalizedLabel = label.toLocaleLowerCase("zh-CN");
    if (labels.has(normalizedLabel)) throw new Error(`状态名称重复：${label}`);
    if (description.length > 80) throw new Error(`状态“${label}”的说明不能超过 80 个字符`);
    if (!/^#[0-9A-F]{6}$/.test(color)) throw new Error(`状态“${label}”的颜色无效`);

    ids.add(id);
    labels.add(normalizedLabel);
    return {
      id,
      label,
      description,
      color,
      required: REQUIRED_BOARD_STATUS_IDS.has(id),
    };
  });

  if (!ids.has("inbox")) throw new Error("收件箱是系统状态，不能删除");
  if (!ids.has("done")) throw new Error("完成是系统状态，不能删除");
  return columns;
}

export const DEFAULT_PORT = 4765;
export const DEFAULT_THREAD_LIMIT = 1_200;
export const MAX_THREAD_LIMIT = 2_000;

export const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_DESKTOP_SESSION_ID_PATTERN =
  /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BOARD_SOURCES = Object.freeze([
  { id: "codex", label: "Codex" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
]);

export const BOARD_SOURCE_IDS = new Set(BOARD_SOURCES.map(({ id }) => id));

export function isConversationId(source, value) {
  const id = String(value ?? "");
  if (source === "claude") {
    return CODEX_THREAD_ID_PATTERN.test(id) || CLAUDE_DESKTOP_SESSION_ID_PATTERN.test(id);
  }
  return CODEX_THREAD_ID_PATTERN.test(id);
}
