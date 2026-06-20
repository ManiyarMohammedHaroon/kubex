import { useState, useEffect } from 'react';
import API from '../api/client';

export default function Settings() {
    const [form, setForm] = useState({
        username: '',
        token: ''
    });
    const [hasToken, setHasToken] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const res = await API.get(`/settings/dockerhub`);
            setForm(prev => ({ ...prev, username: res.data.username || '' }));
            setHasToken(res.data.hasToken);
        } catch (err) {
            console.error('Failed to load settings:', err);
            setError('Failed to load settings from server.');
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        setError('');
        setSuccessMsg('');

        try {
            await API.put(`/settings/dockerhub`, {
                username: form.username,
                token: form.token
            });
            
            setSuccessMsg('Docker Hub credentials securely saved.');
            setForm(prev => ({ ...prev, token: '' })); // clear the input field
            setHasToken(true); // they must have one now if it succeeded
            
            // Also save username to localstorage for backwards compat with other modals
            localStorage.setItem('kubex_dockerhub_username', form.username);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fade-in">
            <div className="page-header">
                <div>
                    <h1 className="page-title">Settings</h1>
                    <p className="page-subtitle">Configure your platform credentials and integrations.</p>
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
                    <div className="spinner" style={{ width: 40, height: 40 }} />
                </div>
            ) : (
                <div className="card" style={{ maxWidth: 600 }}>
                    <h2 style={{ marginBottom: 15, fontSize: '18px' }}>Docker Hub Registry</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: 25, fontSize: '14px', lineHeight: 1.5 }}>
                        Connect your Docker Hub account to enable KUBEX's Native Builder Pipeline. 
                        When you deploy from GitHub, KUBEX will automatically build your image exactly once, push it to your private registry, and distribute it to all worker nodes seamlessly.
                    </p>

                    <form onSubmit={handleSave}>
                        <div className="form-group">
                            <label>Docker Hub Username</label>
                            <input 
                                type="text" 
                                value={form.username} 
                                onChange={e => setForm({...form, username: e.target.value})} 
                                className="crystal"
                                placeholder="e.g. johnsmith"
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>Personal Access Token (PAT)</label>
                            <input 
                                type="password" 
                                value={form.token} 
                                onChange={e => setForm({...form, token: e.target.value})} 
                                className="crystal"
                                placeholder={hasToken ? "•••••••••••• (Saved. Type here to overwrite)" : "dckr_pat_..."}
                                required={!hasToken} // Only required if they don't already have one saved
                            />
                            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: 8 }}>
                                Generate this token in your Docker Hub Account Settings &gt; Security. Do not use your actual password.
                            </p>
                        </div>

                        {error && (
                            <div className="error-message" style={{ marginBottom: 15 }}>
                                {error}
                            </div>
                        )}
                        
                        {successMsg && (
                            <div className="success-message" style={{ marginBottom: 15, padding: '10px 14px', background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent-green)', borderRadius: '6px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                                ✓ {successMsg}
                            </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                            <button type="submit" className="btn btn-primary" disabled={saving}>
                                {saving ? 'Saving...' : 'Save Credentials'}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
