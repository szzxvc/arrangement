// 全项目时间戳为 UTC 整数秒；输入和业务日期固定北京时间。
const OFFSET_MS = 8 * 60 * 60 * 1000;
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export function beijingInput(seconds: number): string {
  return new Date(seconds * 1000 + OFFSET_MS).toISOString().slice(0, 16);
}
export function parseBeijingInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const [year, month, day, hour, minute] = value.match(/\d+/g)!.map(Number);
  if (
    year < 1970 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  )
    return null;
  const seconds = Date.UTC(year, month - 1, day, hour, minute) / 1000 - OFFSET_MS / 1000;
  return beijingInput(seconds) === value ? seconds : null;
}
export const beijingDate = (seconds: number) => beijingInput(seconds).slice(0, 10);
export const formatDateTime = (seconds: number) => beijingInput(seconds).replace('T', ' ');
export function formatRange(start: number, end: number, serverNow: number): string {
  if (
    beijingDate(start) === beijingDate(serverNow) &&
    beijingDate(end) === beijingDate(serverNow)
  ) {
    return `${beijingInput(start).slice(11)}–${beijingInput(end).slice(11)}`;
  }
  return `${formatDateTime(start)}–${formatDateTime(end)}`;
}
export const overlaps = (s: number, e: number, a: number, b: number) => s < b && e > a;
export function durationLabel(seconds: number): string {
  const minutes = Math.floor(Math.max(seconds, 0) / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
