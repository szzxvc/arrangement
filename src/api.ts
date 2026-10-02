import type { ApiErrorBody } from '../shared/types';
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
let csrf = '';
const uncertain = new Map<string, string>();
export function setCsrf(value: string) {
  csrf = value;
}
export function clearApiSession() {
  csrf = '';
  uncertain.clear();
}
export async function api<T>(
  path: string,
  options: { method?: 'POST'; body?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET',
    body = options.body ?? {};
  const fingerprint = path + JSON.stringify(body);
  if (method === 'POST')
    for (const key of uncertain.keys()) if (key !== fingerprint) uncertain.delete(key);
  const requestId = method === 'POST' ? (uncertain.get(fingerprint) ?? crypto.randomUUID()) : '';
  if (method === 'POST') uncertain.set(fingerprint, requestId);
  const authRoute = ['/api/auth/login', '/api/auth/register', '/api/auth/logout'].includes(path);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        signal: options.signal,
        headers:
          method === 'POST'
            ? {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf,
                'X-Request-ID': requestId,
              }
            : {},
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (!authRoute && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
      throw new ApiError(
        'NETWORK_ERROR',
        '网络连接中断，结果暂未确认。恢复连接后可重试本次操作。',
        0,
      );
    }
    let result: T | ApiErrorBody;
    try {
      result = (await response.json()) as T | ApiErrorBody;
    } catch {
      if (!authRoute && attempt === 0) continue;
      throw new ApiError('NETWORK_ERROR', '暂时无法确认提交结果，请刷新或重试本次操作', 0);
    }
    if (!response.ok) {
      // 5xx 可能在提交后发生；保留同一操作标识供手动重试。
      if (response.status < 500) uncertain.delete(fingerprint);
      const error = (result as ApiErrorBody).error;
      if (response.status === 401 && !authRoute) window.dispatchEvent(new Event('auth-expired'));
      throw new ApiError(
        error?.code ?? 'SERVER_ERROR',
        error?.message ?? '服务暂时不可用',
        response.status,
        error?.details,
      );
    }
    uncertain.delete(fingerprint);
    return result as T;
  }
}
export function safeReturnPath(value: string | null, origin = window.location.origin): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
    return '/';
  const url = new URL(value, origin);
  return url.origin === origin && url.pathname !== '/login' ? value : '/';
}
export function acknowledgeMutation(path: string, body: Record<string, unknown>) {
  uncertain.delete(path + JSON.stringify(body));
}
