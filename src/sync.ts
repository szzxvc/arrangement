import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../shared/types';
import { api } from './api';

export function useSnapshot(projectId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(''),
    [unavailable, setUnavailable] = useState(false),
    [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const active = useRef<AbortController | null>(null),
    generation = useRef(0),
    clock = useRef({ server: 0, local: 0 });
  const refresh = useCallback(
    async (force = true) => {
      if (!force && active.current) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const seq = ++generation.current;
      try {
        const result = await api<Snapshot>(`/api/projects/${projectId}/snapshot`, {
          signal: controller.signal,
        });
        if (seq !== generation.current) return;
        clock.current = { server: result.serverNow, local: Date.now() };
        setNow(result.serverNow);
        setSnapshot(result);
        setError('');
        setUnavailable(false);
        return result;
      } catch (err) {
        if (seq !== generation.current || controller.signal.aborted) return;
        if ((err as { status: number }).status === 404) setUnavailable(true);
        else setError('暂时无法同步。' + (err as Error).message);
      } finally {
        if (seq === generation.current) active.current = null;
      }
    },
    [projectId],
  );
  useEffect(() => {
    setSnapshot(null);
    setUnavailable(false);
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, 5000);
    const tick = window.setInterval(() => {
      if (clock.current.server)
        setNow(clock.current.server + Math.floor((Date.now() - clock.current.local) / 1000));
    }, 1000);
    const visibility = () => {
      if (document.hidden) {
        active.current?.abort();
        generation.current++;
        active.current = null;
      } else void refresh();
    };
    const resume = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    return () => {
      active.current?.abort();
      generation.current++;
      window.clearInterval(timer);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
    };
  }, [refresh]);
  return { snapshot, error, unavailable, now, refresh };
}
