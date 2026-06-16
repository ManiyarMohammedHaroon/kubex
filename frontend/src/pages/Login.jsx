import React, { useState } from 'react';
import { login } from '../api/client';

export default function Login({ onLoginSuccess }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!email || !password) {
            setError('Please fill in all fields.');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const res = await login({ email, password });
            if (res.data && res.data.success) {
                const { token, user } = res.data;
                localStorage.setItem('kubex_token', token);
                localStorage.setItem('kubex_user', JSON.stringify(user));
                onLoginSuccess(user);
            } else {
                setError(res.data.error || 'Invalid credentials.');
            }
        } catch (err) {
            console.error('[Login] Error:', err);
            setError(err.response?.data?.error || 'Connection error. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-wrapper fade-in">
            <div className="auth-card">
                <div className="auth-logo">
                    <h2>KUBEX</h2>
                    <span>Cloud Hosting Platform</span>
                </div>

                <form className="auth-form" onSubmit={handleSubmit}>
                    {error && (
                        <div className="auth-error">
                            <span style={{ fontSize: '16px' }}>Error:</span>
                            <span>{error}</span>
                        </div>
                    )}

                    <div className="auth-group">
                        <label className="auth-label" htmlFor="email">Email Address</label>
                        <input
                            id="email"
                            className="auth-input"
                            type="email"
                            placeholder="you@domain.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            disabled={loading}
                        />
                    </div>

                    <div className="auth-group">
                        <label className="auth-label" htmlFor="password">Password</label>
                        <input
                            id="password"
                            className="auth-input"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            disabled={loading}
                        />
                    </div>

                    <button className="auth-btn" type="submit" disabled={loading}>
                        {loading ? 'Signing In...' : 'Sign In'}
                    </button>
                </form>

                <div className="auth-link">
                    Don't have an account? <a href="/signup" onClick={(e) => {
                        e.preventDefault();
                        window.history.pushState({}, '', '/signup');
                        window.dispatchEvent(new PopStateEvent('popstate'));
                    }}>Sign Up</a>
                </div>
            </div>
        </div>
    );
}
