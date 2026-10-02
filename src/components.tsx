import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Page } from '../shared/types';

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        ✓
      </span>
      <span>社团干活打卡</span>
    </span>
  );
}
export function Loading({ text = '正在加载…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
export function Message({
  children,
  kind = 'error',
}: {
  children: ReactNode;
  kind?: 'error' | 'success' | 'info';
}) {
  return (
    <div className={`message ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    headingId = useId(),
    closeRef = useRef(onClose),
    busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (!busyRef.current) closeRef.current();
    };
    element.addEventListener('cancel', onCancel);
    return () => {
      element.removeEventListener('cancel', onCancel);
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={headingId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <h2 id={headingId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function Pager({
  data,
  onPage,
  busy = false,
}: {
  data: Pick<Page<unknown>, 'page' | 'hasMore'>;
  onPage: (page: number) => void;
  busy?: boolean;
}) {
  if (data.page === 1 && !data.hasMore) return null;
  return (
    <nav className="pager" aria-label="分页">
      <button
        className="button small secondary"
        disabled={busy || data.page === 1}
        onClick={() => onPage(data.page - 1)}
      >
        上一页
      </button>
      <span>第 {data.page} 页</span>
      <button
        className="button small secondary"
        disabled={busy || !data.hasMore}
        onClick={() => onPage(data.page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}
