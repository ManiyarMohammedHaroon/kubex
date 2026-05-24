import React, { useState } from 'react';
import { signup } from '../api/client';

export default function Signup({ onSignupSuccess }) {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState('developer');
    const [developerEmail, setDeveloperEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!username || !email || !password) {
            setError('Please fill in all required fields.');
            return;
        }

        if (role === 'viewer' && !developerEmail) {
            setError('Developer email link is required for Viewer accounts.');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const signupPayload = {
                username,
                email,
                password,
                role,
                ...(role === 'viewer' && { developerEmail })
            };

            const res = await signup(signupPayload);
            if (res.data && res.data.success) {
                const { token, user } = res.data;
                localStorage.setItem('kubex_token', token);
                localStorage.setItem('kubex_user', JSON.stringify(user));
                onSignupSuccess(user);
            } else {
                setError(res.data.error || 'Registration failed.');
            }
        } catch (err) {
            console.error('[Signup] Error:', err);
            setError(err.response?.data?.error || 'Registration failed. Please check your network connection.');
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
                            <span style={{ fontSize: '16px' }}>⚠️</span>
                            <span>{error}</span>
                        </div>
                    )}

                    <div className="auth-group">
                        <label className="auth-label" htmlFor="username">Username</label>
                        <input
                            id="username"
                            className="auth-input"
                            type="text"
                            placeholder="johndoe"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                            disabled={loading}
                        />
                    </div>

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
                            placeholder="At least 6 characters"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            minLength={6}
                            disabled={loading}
                        />
                    </div>

                    <div className="auth-group">
                        <label className="auth-label" htmlFor="role">Account Role</label>
                        <select
                            id="role"
                            className="auth-select"
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            disabled={loading}
                        >
                            <option value="developer">Developer (Deploy & scale apps)</option>
                            <option value="viewer">Viewer (Read-only project monitoring)</option>
                        </select>
                    </div>

                    {role === 'viewer' && (
                        <div className="auth-group fade-in">
                            <label className="auth-label" htmlFor="developerEmail">
                                Developer Link Email <span style={{ color: 'var(--accent-red)' }}>*</span>
                            </label>
                            <input
                                id="developerEmail"
                                className="auth-input"
                                type="email"
                                placeholder="your-agency-developer@kubex.io"
                                value={developerEmail}
                                onChange={(e) => setDeveloperEmail(e.target.value)}
                                required={role === 'viewer'}
                                disabled={loading}
                            />
                            <small style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px' }}>
                                Enter the email of the registered Developer who will assign projects to you.
                            </small>
                        </div>
                    )}

                    <button className="auth-btn" type="submit" disabled={loading}>
                        {loading ? 'Creating Account...' : 'Sign Up'}
                    </button>
                </form>

                <div className="auth-link">
                    Already have an account? <a href="/login" onClick={(e) => {
                        e.preventDefault();
                        window.history.pushState({}, '', '/login');
                        window.dispatchEvent(new PopStateEvent('popstate'));
                    }}>Sign In</a>
                </div>
            </div>
        </div>
    );
}
