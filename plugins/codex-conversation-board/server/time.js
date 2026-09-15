/** 将 Codex 可能返回的秒、毫秒或 ISO 时间统一为毫秒时间戳。 */
export function timestampMs(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 返回运行看板这台 Mac 的本地自然日零点。 */
export function startOfLocalDayMs(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 返回 YYYY-MM-DD，仅用于比较本机自然日，不做 UTC 转换。 */
export function localDateKey(value) {
  if (arguments.length === 0) value = Date.now();
  const timestamp = timestampMs(value);
  if (timestamp == null) return null;
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isSameLocalDay(value, now = Date.now()) {
  const valueKey = localDateKey(value);
  return valueKey != null && valueKey === localDateKey(now);
}
