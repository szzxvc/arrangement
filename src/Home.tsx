import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Invitation, Project } from '../shared/types';
import { api } from './api';
import { useAuth } from './auth';
import { Loading, Message, Modal } from './components';

export function Home() {
  const { user } = useAuth(),
    navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [creating, setCreating] = useState(false),
    [busyInvitation, setBusyInvitation] = useState('');
  const sequence = useRef(0);
  async function load() {
    const seq = ++sequence.current;
    try {
      const [p, i] = await Promise.all([
        api<{ projects: Project[] }>('/api/projects'),
        api<{ invitations: Invitation[] }>('/api/invitations'),
      ]);
      if (seq === sequence.current) {
        setProjects(p.projects);
        setInvitations(i.invitations);
        setError('');
      }
    } catch (err) {
      if (seq === sequence.current) setError((err as Error).message);
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const resume = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      sequence.current++;
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  async function resolve(invitation: Invitation, action: 'accept' | 'reject') {
    if (busyInvitation) return;
    setBusyInvitation(invitation.id);
    setError('');
    setMessage('');
    try {
      await api(`/api/invitations/${invitation.id}/${action}`, { method: 'POST' });
      setMessage(action === 'accept' ? `已加入「${invitation.projectName}」` : '已拒绝邀请');
      await load();
    } catch (err) {
      setError((err as Error).message);
      await load();
    } finally {
      setBusyInvitation('');
    }
  }
  return (
    <main className="container home-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">你的协作空间</span>
          <h1>
            我的项目<span className="count">{projects.length}</span>
          </h1>
          <p className="muted">从这里开始今天的协作，每一份投入都有记录。</p>
        </div>
        <button className="button" onClick={() => setCreating(true)}>
          ＋ 新建项目
        </button>
      </div>
      {error && (
        <Message>
          {error}
          <button className="text-button" onClick={() => void load()}>
            重新加载
          </button>
        </Message>
      )}
      {message && <Message kind="success">{message}</Message>}
      <section className="panel invitations-panel">
        <div className="section-heading">
          <h2>
            待处理邀请<span className="count">{invitations.length}</span>
          </h2>
          <button className="text-button" onClick={() => void load()}>
            刷新邀请
          </button>
        </div>
        {!invitations.length ? (
          <p className="muted compact">暂无待处理邀请。成员可以通过你的完整用户名邀请你。</p>
        ) : (
          <div className="invitation-list">
            {invitations.map((item) => (
              <article key={item.id} className="invitation-row">
                <div>
                  <h3>{item.projectName}</h3>
                  <p className="muted">{item.inviterUsername} 邀请你加入</p>
                </div>
                <div className="row-actions">
                  <button
                    className="button small secondary"
                    disabled={!!busyInvitation}
                    onClick={() => void resolve(item, 'reject')}
                  >
                    拒绝
                  </button>
                  <button
                    className="button small"
                    disabled={!!busyInvitation}
                    onClick={() => void resolve(item, 'accept')}
                  >
                    {busyInvitation === item.id ? '处理中…' : '接受邀请'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {loading ? (
        <Loading />
      ) : projects.length ? (
        <section className="project-grid" aria-label="项目列表">
          {projects.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`} className="project-card">
              <div className="project-card-top">
                <span className="project-symbol" aria-hidden="true">
                  ◫
                </span>
                <span className="badge">
                  {project.creatorId === user!.id ? '我创建的' : '我加入的'}
                </span>
              </div>
              <h2>{project.name}</h2>
              <p className="project-summary">{project.description}</p>
              <div className="project-card-meta">
                <span>{project.memberCount} 位成员</span>
                <span>由 {project.creatorUsername} 创建</span>
              </div>
              <span className="card-enter">
                进入项目 <span aria-hidden="true">↗</span>
              </span>
            </Link>
          ))}
        </section>
      ) : (
        <section className="empty-state panel">
          <span className="empty-icon" aria-hidden="true">
            ◫
          </span>
          <h2>第一个项目，从这里开始</h2>
          <p className="muted">创建项目并邀请社团伙伴，一起安排时间、记录工作。</p>
          <button className="button" onClick={() => setCreating(true)}>
            创建我的第一个项目
          </button>
        </section>
      )}
      {creating && (
        <CreateProject
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/projects/${id}`);
          }}
        />
      )}
    </main>
  );
}
function CreateProject({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ projectId: string }>('/api/projects', {
        method: 'POST',
        body: { name, description },
      });
      onCreated(result.projectId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="新建项目" onClose={onClose} busy={busy}>
      <p className="muted">给这次协作起个名字。项目仅对加入的成员可见。</p>
      <form onSubmit={submit}>
        <label>
          项目名称
          <input
            required
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：秋季社团展准备"
            disabled={busy}
            autoFocus
          />
        </label>
        <label>
          项目描述
          <textarea
            required
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="介绍要完成的事情，以及成员需要了解的信息…"
            disabled={busy}
            rows={5}
          />
        </label>
        <p className="field-help">名称最多 80 字，描述最多 2000 字。</p>
        {error && <Message>{error}</Message>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="button" disabled={busy}>
            {busy ? '正在创建…' : '创建项目'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
