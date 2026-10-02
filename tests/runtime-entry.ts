import app from '../worker/index';
import { scryptSync } from 'node:crypto';
import { PASSWORD_PARAMS } from '../worker/core';
import type { Env } from '../worker/core';
// 仅测试入口。生产 Wrangler 入口为 worker/index.ts，不包含该路由。
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/__test/benchmark') {
      const timings: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        scryptSync('测试密码 benchmark 2026', Buffer.alloc(16, i), 64, PASSWORD_PARAMS);
        timings.push(performance.now() - start);
      }
      return Response.json({ algorithm: 'scrypt', ...PASSWORD_PARAMS, wallMs: timings });
    }
    return app.fetch(request, env, ctx);
  },
};
