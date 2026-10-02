import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Activity, Member, Page, Reservation, Snapshot } from '../shared/types';
import {
  beijingInput,
  durationLabel,
  formatDateTime,
  formatRange,
  overlaps,
  parseBeijingInput,
} from '../shared/time';
import { acknowledgeMutation, api, ApiError } from './api';
import { useAuth } from './auth';
import { Loading, Message, Modal, Pager } from './components';
import { useSnapshot } from './sync';

type Dialog =
  | { type: 'invite' }
  | { type: 'reserve' }
  | { type: 'force'; member: Member }
  | { type: 'cancel'; reservation: Reservation }
  | null;
export function ProjectPage() {
  const { projectId = '' } = useParams(),
    { user } = useAuth(),
    { snapshot, error: syncError, unavailable, now, refresh } = useSnapshot(projectId);
  const [dialog, setDialog] = useState<Dialog>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [revision, setRevision] = useState(0);
  const current = snapshot?.members.find((member) => member.id === user!.id),
    active = snapshot?.members.find((member) => member.workSessionId);
  async function finish(message: string) {
    setSuccess(message);
    setError('');
    setRevision((x) => x + 1);
    await refresh();
  }
  async function work() {
    if (busy || !current) return;
    setBusy(true);
    setError('');
    setSuccess('');
    const path = `/api/projects/${projectId}/work/${current.workSessionId ? 'stop' : 'start'}`;
    const body = current.workSessionId ? { workSessionId: current.workSessionId } : {};
    try {
      await api(path, { method: 'POST', body });
      await finish(current.workSessionId ? '已结束干活，辛苦了。' : '已开始干活，祝你进展顺利。');
    } catch (err) {
      setError((err as Error).message);
      const latest = await refresh();
      if (latest && latest.members.find((m) => m.id === current.id)!.version > current.version)
        acknowledgeMutation(path, body);
    } finally {
      setBusy(false);
    }
  }
  if (unavailable)
    return (
      <main className="container">
        <section className="empty-state panel">
          <h1>暂时无法访问这个项目</h1>
          <p className="muted">项目不存在，或你还没有接受加入邀请。</p>
          <Link className="button" to="/">
            返回我的项目
          </Link>
        </section>
      </main>
    );
  if (!snapshot)
    return (
      <main className="container">
        {syncError ? (
          <>
            <Message>{syncError}</Message>
            <button className="button" onClick={() => void refresh()}>
              重新同步
            </button>
          </>
        ) : (
          <Loading />
        )}
      </main>
    );
  const currentReservation = snapshot.reservations.find((r) => r.startAt <= now && r.endAt > now);
  return (
    <main className="container project-page">
      <Link className="back-link" to="/">
        ← 我的项目
      </Link>
      <div className="page-heading project-heading">
        <div>
          <span className="eyebrow">项目协作空间</span>
          <h1>{snapshot.project.name}</h1>
          <p className="muted">
            由 {snapshot.project.creatorUsername} 创建 · {snapshot.members.length} 位成员
          </p>
        </div>
        <button className="button secondary" onClick={() => setDialog({ type: 'invite' })}>
          ＋ 邀请成员
        </button>
      </div>
      <details className="description">
        <summary>项目描述</summary>
        <p>{snapshot.project.description}</p>
      </details>
      {syncError && (
        <Message>
          {syncError}
          <button className="text-button" onClick={() => void refresh()}>
            立即同步
          </button>
        </Message>
      )}
      {error && <Message>{error}</Message>}
      {success && <Message kind="success">{success}</Message>}
      <section className={`work-banner ${current?.workSessionId ? 'working' : ''}`}>
        <div className="work-banner-status">
          <span className="work-orb" aria-hidden="true">
            {active ? '◉' : '◷'}
          </span>
          <div>
            <span className="eyebrow">项目当前状态</span>
            <h2>{active ? `${active.username} 正在干活` : '当前无人干活'}</h2>
            <p>
              {active?.startedAt
                ? `开始于 ${formatDateTime(active.startedAt)} · 已持续 ${durationLabel(now - active.startedAt)}`
                : '准备好了，就接过这一棒。'}
            </p>
          </div>
        </div>
        <div className="work-actions">
          <button className="button" disabled={busy || !current} onClick={() => void work()}>
            {busy ? '正在提交…' : current?.workSessionId ? '■ 结束干活' : '▶ 开始干活'}
          </button>
          <button className="button secondary" onClick={() => setDialog({ type: 'reserve' })}>
            ◷ 预约干活
          </button>
        </div>
        <p className="work-note">
          预约只安排时间，开始和结束需要手动操作。
          {currentReservation
            ? ` 当前预约：${currentReservation.username}，${formatRange(currentReservation.startAt, currentReservation.endAt, now)}。`
            : ''}
        </p>
      </section>
      <div className="project-columns">
        <section className="panel members-panel">
          <div className="section-heading">
            <h2>
              项目成员<span className="count">{snapshot.members.length}</span>
            </h2>
            <span className="live-label">每 5 秒同步</span>
          </div>
          <p className="field-help">点击其他成员的状态，可经确认后修改。每个项目最多一人干活。</p>
          <ul className="member-list">
            {snapshot.members.map((member) => (
              <li key={member.id} className={`member-row ${member.workSessionId ? 'active' : ''}`}>
                <span className="avatar" aria-hidden="true">
                  {Array.from(member.username)[0]}
                </span>
                <div className="member-info">
                  <strong>
                    {member.username}
                    {member.id === user!.id && <span className="mine-label">我</span>}
                  </strong>
                  <p>
                    {member.startedAt !== null
                      ? `已干活 ${durationLabel(now - member.startedAt)}`
                      : '等待下一次协作'}
                  </p>
                </div>
                {member.id === user!.id ? (
                  <span className={`status-pill ${member.workSessionId ? 'on' : ''}`}>
                    <span aria-hidden="true">{member.workSessionId ? '●' : '○'}</span>
                    {member.workSessionId ? '干活中' : '休息中'}
                  </span>
                ) : (
                  <button
                    className={`status-pill status-button ${member.workSessionId ? 'on' : ''}`}
                    aria-label={`修改${member.username}的工作状态`}
                    onClick={() => setDialog({ type: 'force', member: { ...member } })}
                  >
                    <span aria-hidden="true">{member.workSessionId ? '●' : '○'}</span>
                    {member.workSessionId ? '干活中' : '休息中'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <ReservationsPanel
          projectId={projectId}
          snapshot={snapshot}
          revision={revision}
          now={now}
          onCancel={(reservation) => setDialog({ type: 'cancel', reservation })}
        />
      </div>
      <ActivityPanel projectId={projectId} revision={revision} snapshot={snapshot} />
      {dialog?.type === 'invite' && (
        <InviteModal
          projectId={projectId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void finish('邀请已发送，对方接受后即可加入。');
          }}
        />
      )}
      {dialog?.type === 'reserve' && (
        <ReservationModal
          projectId={projectId}
          snapshot={snapshot}
          now={now}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void finish('预约已创建。');
          }}
        />
      )}
      {(dialog?.type === 'force' || dialog?.type === 'cancel') && (
        <ConfirmModal
          dialog={dialog}
          projectId={projectId}
          now={now}
          onClose={() => setDialog(null)}
          onRefresh={refresh}
          onDone={() => {
            const text =
              dialog.type === 'force' ? '成员工作状态已更新。' : '预约已取消，时段已释放。';
            setDialog(null);
            void finish(text);
          }}
        />
      )}
    </main>
  );
}

function ReservationsPanel({
  projectId,
  snapshot,
  revision,
  now,
  onCancel,
}: {
  projectId: string;
  snapshot: Snapshot;
  revision: number;
  now: number;
  onCancel: (reservation: Reservation) => void;
}) {
  const { user } = useAuth(),
    [view, setView] = useState<'upcoming' | 'history'>('upcoming'),
    [page, setPage] = useState(1),
    [data, setData] = useState<Page<Reservation>>({
      items: snapshot.reservations,
      page: 1,
      hasMore: snapshot.reservationsHasMore,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (view === 'upcoming' && page === 1) {
      setData({ items: snapshot.reservations, page: 1, hasMore: snapshot.reservationsHasMore });
      setError('');
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError('');
    api<Page<Reservation>>(`/api/projects/${projectId}/reservations?view=${view}&page=${page}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [projectId, view, page, snapshot, revision]);
  return (
    <section className="panel reservations-panel">
      <div className="section-heading">
        <h2>预约安排</h2>
        <span className="muted small-text">北京时间</span>
      </div>
      <div className="tabs small-tabs">
        <button
          className={view === 'upcoming' ? 'selected' : ''}
          onClick={() => {
            setView('upcoming');
            setPage(1);
          }}
        >
          当前与未来
        </button>
        <button
          className={view === 'history' ? 'selected' : ''}
          onClick={() => {
            setView('history');
            setPage(1);
          }}
        >
          历史与已取消
        </button>
      </div>
      {error && <Message>{error}</Message>}
      {busy && <Loading text="正在读取预约…" />}
      {!busy && !data.items.length && (
        <div className="small-empty">
          <span aria-hidden="true">◷</span>
          <p className="muted">
            {view === 'history' ? '还没有历史预约' : '时间留给下一次投入，点击「预约干活」安排。'}
          </p>
        </div>
      )}
      <ul className="reservation-list">
        {!busy &&
          data.items.map((reservation) => (
            <li key={reservation.id} className="reservation-row">
              <div>
                <div className="reservation-time">
                  {formatRange(reservation.startAt, reservation.endAt, now)}
                </div>
                <div className="reservation-meta">
                  <strong>{reservation.username}</strong>
                  {reservation.userId === user!.id && <span className="mine-label">我的预约</span>}
                  <span className={`badge ${reservation.status === 'cancelled' ? 'neutral' : ''}`}>
                    {reservation.status === 'cancelled'
                      ? '已取消'
                      : reservation.endAt <= now
                        ? '已结束'
                        : reservation.startAt <= now
                          ? '当前时段'
                          : '待开始'}
                  </span>
                </div>
              </div>
              {reservation.status === 'active' &&
                reservation.endAt > now &&
                reservation.userId === user!.id && (
                  <button
                    className="text-button cancel-reservation"
                    aria-label={`取消预约 ${formatRange(reservation.startAt, reservation.endAt, now)}`}
                    onClick={() => onCancel(reservation)}
                  >
                    取消
                  </button>
                )}
            </li>
          ))}
      </ul>
      <Pager data={data} onPage={setPage} busy={busy} />
    </section>
  );
}
function ActivityPanel({
  projectId,
  snapshot,
  revision,
}: {
  projectId: string;
  snapshot: Snapshot;
  revision: number;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [data, setData] = useState<Page<Activity>>({
      items: snapshot.activity,
      page: 1,
      hasMore: snapshot.activity.length === 20,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    api<Page<Activity>>(`/api/projects/${projectId}/activity?page=${page}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, page, snapshot, revision, projectId]);
  return (
    <section className="panel activity-panel">
      <button
        className="section-heading disclosure-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <h2>操作记录</h2>
        <span>{open ? '收起 −' : '展开 ＋'}</span>
      </button>
      {open && (
        <>
          {error && <Message>{error}</Message>}
          {busy ? (
            <Loading />
          ) : !data.items.length ? (
            <p className="muted">暂无操作记录。</p>
          ) : (
            <ol className="activity-list">
              {data.items.map((item) => (
                <li key={item.id}>
                  <span
                    className={`activity-dot ${item.reason === 'forced' ? 'forced' : ''}`}
                    aria-hidden="true"
                  >
                    {item.toState === 'working' ? '▶' : '■'}
                  </span>
                  <div>
                    <p>
                      <strong>{item.actorUsername}</strong>
                      {item.reason === 'forced' ? (
                        <>
                          {' '}
                          将 <strong>{item.targetUsername}</strong> 设为
                          {item.toState === 'working' ? '干活中' : '休息中'}{' '}
                          <span className="badge neutral">强制操作</span>
                        </>
                      ) : item.toState === 'working' ? (
                        ' 开始干活'
                      ) : (
                        ' 结束干活'
                      )}
                    </p>
                    <time>{formatDateTime(item.occurredAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <Pager data={data} onPage={setPage} busy={busy} />
        </>
      )}
    </section>
  );
}
function InviteModal({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [username, setUsername] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/projects/${projectId}/invitations`, { method: 'POST', body: { username } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="邀请成员" onClose={onClose} busy={busy}>
      <p className="muted">输入对方注册时使用的完整用户名，对方会在首页收到邀请。</p>
      <form onSubmit={submit}>
        <label>
          对方的用户名
          <input
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="完整用户名"
            disabled={busy}
          />
        </label>
        {error && <Message>{error}</Message>}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button" disabled={busy}>
            {busy ? '正在发送…' : '发送邀请'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ConfirmModal({
  dialog,
  projectId,
  now,
  onClose,
  onDone,
  onRefresh,
}: {
  dialog: Exclude<Dialog, null | { type: 'invite' } | { type: 'reserve' }>;
  projectId: string;
  now: number;
  onClose: () => void;
  onDone: () => void;
  onRefresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const forcing = dialog.type === 'force';
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      if (dialog.type === 'force') {
        const member = dialog.member;
        await api(`/api/projects/${projectId}/members/${member.id}/work-state`, {
          method: 'POST',
          body: {
            state: member.workSessionId ? 'resting' : 'working',
            expectedState: member.workSessionId ? 'working' : 'resting',
            expectedWorkSessionId: member.workSessionId,
            expectedVersion: member.version,
          },
        });
      } else
        await api(`/api/projects/${projectId}/reservations/${dialog.reservation.id}/cancel`, {
          method: 'POST',
        });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.code === 'STATE_CHANGED') setExpired(true);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={forcing ? '确认修改工作状态' : '确认取消预约'} onClose={onClose} busy={busy}>
      <div className="confirm-symbol" aria-hidden="true">
        {forcing ? '↔' : '◷'}
      </div>
      {dialog.type === 'force' ? (
        <>
          <p className="confirm-text">
            将 <strong>{dialog.member.username}</strong> 从
            {dialog.member.workSessionId ? '干活中' : '休息中'}改为
            {dialog.member.workSessionId ? '休息中' : '干活中'}？
          </p>
          <p className="muted">
            这次操作会记录你的用户名，供项目成员查看。
            {!dialog.member.workSessionId && '如果已有其他人干活，本次操作会被拒绝。'}
          </p>
        </>
      ) : (
        <>
          <p className="confirm-text">取消这次预约？</p>
          <p className="time-callout">
            {formatRange(dialog.reservation.startAt, dialog.reservation.endAt, now)}
          </p>
          <p className="muted">取消后释放该时段，并保留历史记录。实际工作状态由手动打卡决定。</p>
        </>
      )}
      {error && (
        <Message>
          {error}
          {expired && ' 请关闭弹窗，重新选择成员状态。'}
        </Message>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose} disabled={busy}>
          {expired ? '关闭' : '取消'}
        </button>
        <button className="button" disabled={busy || expired} onClick={() => void confirm()}>
          {busy ? '正在提交…' : forcing ? '确认修改' : '确认取消预约'}
        </button>
      </div>
    </Modal>
  );
}
function DateTimeFields({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [date = '', time = '00:00'] = value.split('T'),
    [hour = '00', minute = '00'] = time.split(':');
  return (
    <fieldset className="time-fields" disabled={disabled}>
      <legend>
        {label} <span>北京时间 · 24 小时制</span>
      </legend>
      <div className="time-grid">
        <label>
          日期
          <input
            type="date"
            required
            value={date}
            min="1970-01-01"
            max="9999-12-31"
            onChange={(e) => onChange(`${e.target.value}T${hour}:${minute}`)}
          />
        </label>
        <label>
          小时
          <select
            aria-label={`${label}小时`}
            value={hour}
            onChange={(e) => onChange(`${date}T${e.target.value}:${minute}`)}
          >
            {Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0')).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          分钟
          <select
            aria-label={`${label}分钟`}
            value={minute}
            onChange={(e) => onChange(`${date}T${hour}:${e.target.value}`)}
          >
            {Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0')).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}
function nextSlot(reservations: Reservation[], now: number) {
  let start = Math.ceil((now + 1) / 60) * 60;
  for (const reservation of reservations)
    if (overlaps(start, start + 3600, reservation.startAt, reservation.endAt))
      start = reservation.endAt;
  return start;
}
function ReservationModal({
  projectId,
  snapshot,
  now,
  onClose,
  onDone,
}: {
  projectId: string;
  snapshot: Snapshot;
  now: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const initial = useRef(nextSlot(snapshot.reservations, now));
  const [startValue, setStart] = useState(beijingInput(initial.current)),
    [endValue, setEnd] = useState(beijingInput(initial.current + 3600)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState<Reservation | null>(null),
    [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState('');
  const start = parseBeijingInput(startValue),
    end = parseBeijingInput(endValue);
  const validation =
    start === null || end === null
      ? '请选择有效的日期、小时和分钟。'
      : start < now
        ? '开始时间已过去，请选择下一个整分钟。'
        : end - start < 60
          ? '结束时间必须至少晚于开始一分钟。'
          : '';
  useEffect(() => {
    setConflict(null);
    setCheckError('');
    if (start === null || end === null || end <= start) {
      setChecking(false);
      return;
    }
    const controller = new AbortController();
    setChecking(true);
    const timer = window.setTimeout(() => {
      api<Page<Reservation>>(`/api/projects/${projectId}/reservations?from=${start}&to=${end}`, {
        signal: controller.signal,
      })
        .then((data) => {
          setConflict(data.items.find((r) => overlaps(start, end, r.startAt, r.endAt)) ?? null);
        })
        .catch((err) => {
          if (!controller.signal.aborted)
            setCheckError('暂时无法核对时段，请恢复连接后重试。' + (err as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [start, end, projectId, snapshot]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validation || conflict || checking || checkError) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/projects/${projectId}/reservations`, {
        method: 'POST',
        body: { startAt: start, endAt: end },
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="预约干活" onClose={onClose} busy={busy} wide>
      <p className="muted">以一分钟为单位安排时间，支持跨日。相邻时段可以首尾相接。</p>
      <form onSubmit={submit}>
        <DateTimeFields
          label="开始时间"
          value={startValue}
          onChange={(v) => {
            setStart(v);
            setError('');
          }}
          disabled={busy}
        />
        <DateTimeFields
          label="结束时间"
          value={endValue}
          onChange={(v) => {
            setEnd(v);
            setError('');
          }}
          disabled={busy}
        />
        {validation && <Message>{validation}</Message>}
        {conflict && (
          <Message>
            该时段已被 {conflict.username} 预约：
            {formatRange(conflict.startAt, conflict.endAt, now)}
          </Message>
        )}
        {checkError && <Message>{checkError}</Message>}
        {checking && (
          <p className="field-help" role="status">
            正在核对时段…
          </p>
        )}
        {error && <Message>{error}</Message>}
        <div className="scheduled-preview">
          <h3>已预约时段</h3>
          {!snapshot.reservations.length ? (
            <p className="muted">目前没有预约。</p>
          ) : (
            <ul>
              {snapshot.reservations.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <span>{formatRange(r.startAt, r.endAt, now)}</span>
                  <strong>{r.username}</strong>
                </li>
              ))}
            </ul>
          )}
          {snapshot.reservations.length > 6 && (
            <p className="field-help">更多安排可在项目预约列表查看。所选时间会核对全部有效预约。</p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="button"
            disabled={busy || !!validation || !!conflict || checking || !!checkError}
          >
            {busy ? '正在预约…' : '确认预约'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
