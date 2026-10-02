import { expect, it } from 'vitest';
import { safeReturnPath } from '../src/api';
it.each([
  null,
  'https://evil.test',
  '//evil.test',
  '/\\evil.test',
  '/\nevil.test',
  '/login?next=/login',
  'javascript:alert(1)',
])('登录回跳拒绝外部或无效路径 %s', (path) => {
  expect(safeReturnPath(path, 'https://club.test')).toBe('/');
});
it('登录回跳保留有效站内深链', () => {
  expect(safeReturnPath('/projects/abc?view=history', 'https://club.test')).toBe(
    '/projects/abc?view=history',
  );
});
