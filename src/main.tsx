import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AuthProvider, Header, LoginPage, Protected } from './auth';
import { Home } from './Home';
import { ProjectPage } from './Project';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Protected>
              <Header />
              <Home />
            </Protected>
          }
        />
        <Route
          path="/projects/:projectId"
          element={
            <Protected>
              <Header />
              <ProjectPage />
            </Protected>
          }
        />
        <Route
          path="*"
          element={
            <main className="center-card">
              <h1>这个页面走丢了</h1>
              <Link className="button" to="/">
                返回我的项目
              </Link>
            </main>
          }
        />
      </Routes>
    </AuthProvider>
  </BrowserRouter>,
);
