import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { User } from '../shared/types';
import { api, ApiError, clearApiSession, setCsrf, safeReturnPath } from './api';
import { Brand, Loading, Message } from './components';

interface AuthResult {
  user: User;
  csrfToken: string;
}
interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string;
  authenticate: (result: AuthResult) => void;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue>(null!);
export const useAuth = () => useContext(AuthContext);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  function authenticate(result: AuthResult) {
    clearApiSession();
    setCsrf(result.csrfToken);
    setUser(result.user);
    setError('');
  }
  async function reload() {
    setLoading(true);
    setError('');
    try {
      authenticate(await api<AuthResult>('/api/auth/me'));
    } catch (err) {
      if ((err as { status: number }).status !== 401) setError((err as Error).message);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    const expired = () => {
      clearApiSession();
      setUser(null);
    };
    window.addEventListener('auth-expired', expired);
    return () => window.removeEventListener('auth-expired', expired);
  }, []);
  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
    clearApiSession();
    setUser(null);
  }
  return (
    <AuthContext.Provider value={{ user, loading, error, authenticate, logout, reload }}>
      {children}
    </AuthContext.Provider>
  );
}
export function Protected({ children }: { children: ReactNode }) {
  const { user, loading, error, reload } = useAuth(),
    location = useLocation();
  if (loading) return <Loading />;
  if (error)
    return (
      <div className="center-card">
        <Message>{error}</Message>
        <button className="button" onClick={() => void reload()}>
          重新连接
        </button>
      </div>
    );
  if (!user)
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  return <>{children}</>;
}
export function Header() {
  const { user, logout } = useAuth(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function exit() {
    setBusy(true);
    setError('');
    try {
      await logout();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="site-header">
        <Link to="/" aria-label="返回我的项目">
          <Brand />
        </Link>
        <div className="account">
          <span className="account-name">{user?.username}</span>
          <button className="button small ghost" onClick={() => void exit()} disabled={busy}>
            {busy ? '退出中…' : '退出登录'}
          </button>
        </div>
      </header>
      {error && (
        <div className="container">
          <Message>{error}</Message>
        </div>
      )}
    </>
  );
}
export function LoginPage() {
  const { user, authenticate, loading } = useAuth(),
    [params] = useSearchParams(),
    navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login'),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const target = safeReturnPath(params.get('next'));
  if (loading) return <Loading />;
  if (user) return <Navigate to={target} replace />;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<AuthResult>(`/api/auth/${mode}`, {
        method: 'POST',
        body: { username, password },
      });
      authenticate(result);
      navigate(target, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-intro">
        <Brand />
        <div>
          <span className="eyebrow">一起做事，把时间留给协作</span>
          <h1>
            接好这一棒，
            <br />
            一起把事做好。
          </h1>
          <p>
            一个项目，一个正在干活的人。
            <br />
            打卡、预约、交接，都在同一个空间里。
          </p>
        </div>
        <div className="intro-chips">
          <span>✓ 项目私有</span>
          <span>◷ 分钟预约</span>
          <span>↗ 成员协作</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">欢迎来到社团的协作空间</span>
          <h2>{mode === 'login' ? '登录你的账号' : '创建一个账号'}</h2>
          <p className="muted">只需用户名和密码，就能开始协作。</p>
          <div className="tabs" aria-label="账号操作">
            <button
              className={mode === 'login' ? 'selected' : ''}
              disabled={busy}
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              登录
            </button>
            <button
              className={mode === 'register' ? 'selected' : ''}
              disabled={busy}
              onClick={() => {
                setMode('register');
                setError('');
              }}
            >
              注册
            </button>
          </div>
          <form onSubmit={submit}>
            <label>
              用户名
              <input
                name="username"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如：小林同学"
                disabled={busy}
              />
            </label>
            {mode === 'register' && (
              <p className="field-help">3–32 个字符，支持中文、字母、数字、_、-、.</p>
            )}
            <label>
              密码
              <div className="password-input">
                <input
                  name="password"
                  aria-label="密码"
                  type={show ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8–128 个字符"
                  disabled={busy}
                />
                <button
                  type="button"
                  aria-label={show ? '隐藏密码' : '显示密码'}
                  aria-pressed={show}
                  onClick={() => setShow(!show)}
                >
                  {show ? '隐藏' : '显示'}
                </button>
              </div>
            </label>
            {error && <Message>{error}</Message>}
            <button className="button full" disabled={busy}>
              {busy ? '正在提交…' : mode === 'login' ? '登录，进入我的项目' : '注册并登录'}
            </button>
          </form>
          <p className="auth-note">请妥善保存密码。目前不支持自动找回密码。</p>
        </div>
      </section>
    </main>
  );
}
