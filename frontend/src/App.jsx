import { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Nodes from './pages/Nodes';
import Deployments from './pages/Deployments';
import Logs from './pages/Logs';
import Images from './pages/Images';
import Databases from './pages/Databases';
import Settings from './pages/Settings';
import Login from './pages/Login';
import Signup from './pages/Signup';
import './index.css';

/**
 * Navigation items rendered in the sidebar.
 * `exact: true` on the Dashboard prevents "/" from matching every sub-path.
 */
const navItems = [
  { path: '/', icon: '⬡', label: 'Dashboard', exact: true },
  { path: '/nodes', icon: '', label: 'Nodes' },
  { path: '/deployments', icon: '', label: 'Deployments' },
  { path: '/images', icon: '', label: 'Images' },
  { path: '/logs', icon: '', label: 'Logs' },
  { path: '/databases', icon: '', label: 'Databases' },
  { path: '/settings', icon: '', label: 'Settings' },
];

export default function App() {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('kubex_user') || 'null');
    } catch {
      return null;
    }
  });

  const handleLogout = () => {
    localStorage.removeItem('kubex_token');
    localStorage.removeItem('kubex_user');
    setUser(null);
  };

  // If user is not logged in, only expose the login and signup routes
  if (!user) {
    return (
      <Router>
        <Routes>
          <Route path="/signup" element={<Signup onSignupSuccess={setUser} />} />
          <Route path="/login" element={<Login onLoginSuccess={setUser} />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Router>
    );
  }

  // Filter sidebar navigation based on the user's role
  const filteredNavItems = navItems.filter((item) => {
    if (user.role === 'viewer') {
      // Viewers can access Dashboard, Deployments, Logs, and Databases
      return item.path === '/' || item.path === '/deployments' || item.path === '/logs' || item.path === '/databases';
    }
    // Developers and Admins can see the Nodes tab
    if (user.role !== 'admin' && item.path === '/images') {
      return false;
    }
    return true;
  });

  return (
    <Router>
      <div className="layout">

        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <nav className="sidebar">
          {/* Logo + branding at the top of the sidebar */}
          <div className="logo">
            <h1>⬡ KUBEX</h1>
            <span>Container Orchestrator</span>
          </div>

          {/* Navigation links — NavLink automatically adds "active" class */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {filteredNavItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.exact} // `end` prevents "/" from matching sub-paths
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </div>

          {/* Live polling indicator + User Session Widget pinned to the bottom */}
          <div style={{ marginTop: 'auto', padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="live-indicator" style={{ padding: '0 4px' }}>
              <div className="live-dot" />
              Live Polling
            </div>

            {/* User Profile + Logout Card */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.username}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: '750', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {user.role === 'viewer' ? 'Client Viewer' : user.role === 'admin' ? 'Platform Admin' : 'Developer'}
                </span>
              </div>
              <button 
                onClick={handleLogout}
                className="btn btn-sm btn-secondary"
                style={{ width: '100%', justifyContent: 'center', height: '32px' }}
              >
                Sign Out
              </button>
            </div>
          </div>
        </nav>

        {/* ── Main Content ─────────────────────────────────────────────── */}
        {/* React Router swaps the component here based on the current URL */}
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/deployments" element={<Deployments />} />
            <Route path="/logs" element={<Logs />} />
            
            <Route path="/databases" element={<Databases />} />
            <Route path="/settings" element={<Settings />} />
            
            {/* Infrastructure Routes */}
            {user.role !== 'viewer' && (
              <Route path="/nodes" element={<Nodes />} />
            )}
            
            {/* Admin-only Routes */}
            {user.role === 'admin' && (
              <Route path="/images" element={<Images />} />
            )}

            {/* Fallback route */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}
