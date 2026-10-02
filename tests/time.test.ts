import { describe, expect, it } from 'vitest';
import {
  beijingDate,
  beijingInput,
  formatRange,
  overlaps,
  parseBeijingInput,
} from '../shared/time';
describe('固定北京时间及分钟精度', () => {
  it('不依赖浏览器时区，明确按 UTC+8 解析', () => {
    expect(parseBeijingInput('2026-10-03T14:30')).toBe(Date.parse('2026-10-03T06:30:00Z') / 1000);
    expect(beijingInput(Date.parse('2026-10-02T16:00:00Z') / 1000)).toBe('2026-10-03T00:00');
  });
  it.each([
    '2026-02-29T14:30',
    '2026-04-31T14:30',
    '2026-13-01T00:00',
    '2026-10-03T24:00',
    '2026-10-03T00:60',
    '2026-10-03T14:30:01',
    '2026-10-03T14:30Z',
    '2026-10-03',
    '0000-01-01T00:00',
  ])('拒绝无效日期或精度：%s', (value) => expect(parseBeijingInput(value)).toBeNull());
  it('闰年、跨月、跨年、北京时间午夜', () => {
    expect(beijingInput(parseBeijingInput('2028-02-29T23:59')! + 60)).toBe('2028-03-01T00:00');
    expect(beijingInput(parseBeijingInput('2026-12-31T23:59')! + 60)).toBe('2027-01-01T00:00');
    expect(beijingDate(Date.parse('2026-10-02T15:59:59Z') / 1000)).toBe('2026-10-02');
    expect(beijingDate(Date.parse('2026-10-02T16:00:00Z') / 1000)).toBe('2026-10-03');
  });
  it('今天简写，其他日期及跨午夜显示双日期', () => {
    const now = parseBeijingInput('2026-10-02T12:00')!;
    expect(
      formatRange(
        parseBeijingInput('2026-10-02T14:30')!,
        parseBeijingInput('2026-10-02T16:00')!,
        now,
      ),
    ).toBe('14:30–16:00');
    expect(
      formatRange(
        parseBeijingInput('2026-10-02T23:59')!,
        parseBeijingInput('2026-10-03T00:01')!,
        now,
      ),
    ).toBe('2026-10-02 23:59–2026-10-03 00:01');
    expect(
      formatRange(
        parseBeijingInput('2026-12-31T23:59')!,
        parseBeijingInput('2027-01-01T00:01')!,
        now,
      ),
    ).toContain('2027-01-01');
  });
  it('左闭右开；首尾相接不重叠', () => {
    expect(overlaps(10, 20, 20, 30)).toBe(false);
    expect(overlaps(10, 21, 20, 30)).toBe(true);
  });
});
