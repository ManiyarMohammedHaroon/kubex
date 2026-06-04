import React, { useEffect, useState } from 'react';
import { getDatabases, createDatabase, deleteDatabase, shareDatabase, revokeDatabaseAccess } from '../api/client';

export default function Databases() {
    const [databases, setDatabases] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [newDb, setNewDb] = useState({ name: '', type: 'mongo' });
    const [shareModalDb, setShareModalDb] = useState(null);
    const [shareEmail, setShareEmail] = useState('');
    
    const currentUser = JSON.parse(localStorage.getItem('kubex_user') || '{}');

    useEffect(() => {
        loadDatabases();
    }, []);

    const loadDatabases = async () => {
        try {
            const res = await getDatabases();
            setDatabases(res.data.data);
        } catch (err) {
            console.error('Failed to load databases', err);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await createDatabase(newDb);
            setShowModal(false);
            setNewDb({ name: '', type: 'mongo' });
            loadDatabases();
        } catch (err) {
            alert(err.response?.data?.message || 'Failed to create database');
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm('Are you sure? This will PERMANENTLY destroy all data on this database.')) return;
        try {
            await deleteDatabase(id);
            loadDatabases();
        } catch (err) {
            alert('Failed to delete database');
        }
    };

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        alert('Copied to clipboard!');
    };

    const handleShare = async (e) => {
        e.preventDefault();
        try {
            await shareDatabase(shareModalDb._id, shareEmail);
            setShareEmail('');
            loadDatabases();
            
            // Update modal state so the new viewer shows up immediately
            const updatedDb = databases.find(d => d._id === shareModalDb._id);
            if (updatedDb) {
                // Not perfectly reactive, but good enough for a refetch
                setShareModalDb({ ...shareModalDb }); 
            }
        } catch (err) {
            alert(err.response?.data?.message || 'Failed to share database');
        }
    };

    const handleRevoke = async (userId) => {
        try {
            await revokeDatabaseAccess(shareModalDb._id, userId);
            loadDatabases();
        } catch (err) {
            alert('Failed to revoke access');
        }
    };

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <div className="page-title">Managed Databases</div>
                    <div className="page-subtitle">Provision isolated database containers for your apps</div>
                </div>
                <button className="btn btn-primary" onClick={() => setShowModal(true)} disabled={currentUser.role === 'viewer'}>
                    + New Database
                </button>
            </div>

            {loading ? (
                <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : databases.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-icon">🗄️</div>
                    <h3>No databases provisioned</h3>
                    <p>Create a Managed Database to link it to your Deployments.</p>
                </div>
            ) : (
                <div style={{ display: 'grid', gap: 20 }}>
                    {databases.map(db => (
                        <div key={db._id} className="card" style={{ padding: 20 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
                                    <div style={{
                                        width: 40, height: 40, borderRadius: 8,
                                        background: 'rgba(255,255,255,0.05)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: 20
                                    }}>
                                        {db.type === 'mongo' ? '🍃' : db.type === 'postgres' ? '🐘' : db.type === 'mysql' ? '🐬' : '⚡'}
                                    </div>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: 16 }}>
                                            {db.name} 
                                            {db.owner !== currentUser._id && (
                                                <span className="badge badge-purple" style={{ marginLeft: 10, fontSize: 10 }}>Managed for You</span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Type: {db.type.toUpperCase()}</div>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                    <span className={`badge badge-${db.status === 'Running' ? 'green' : 'yellow'}`}>
                                        {db.status}
                                    </span>
                                    <button className="btn btn-secondary" onClick={() => {
                                        const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
                                        const guiUrl = apiBase.replace('/api', '') + `/api/databases/${db._id}/gui/?token=${localStorage.getItem('kubex_token')}`;
                                        window.open(guiUrl, '_blank');
                                    }} style={{ padding: '6px 12px' }}>
                                        Open Studio
                                    </button>
                                    {db.owner === currentUser._id && (
                                        <>
                                            <button className="btn btn-secondary" onClick={() => setShareModalDb(db)} style={{ padding: '6px 12px' }}>Share</button>
                                            <button className="btn btn-danger" onClick={() => handleDelete(db._id)} style={{ padding: '6px 12px' }}>Delete</button>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div style={{
                                background: '#111827', // Very dark high-contrast background
                                padding: '16px',
                                borderRadius: 8,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '12px',
                                border: '1px solid var(--glass-border)'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ flex: 1, overflow: 'hidden' }}>
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 600, letterSpacing: '0.5px' }}>INTERNAL CONNECTION STRING</div>
                                        <code style={{ color: '#38bdf8', fontSize: 13, wordBreak: 'break-all', fontWeight: 500 }}>
                                            {db.connectionString || 'Provisioning...'}
                                        </code>
                                    </div>
                                    <button className="btn btn-secondary" onClick={() => copyToClipboard(db.connectionString)} disabled={!db.connectionString} style={{ padding: '4px 12px' }}>
                                        Copy
                                    </button>
                                </div>
                                
                                {db.credentials && (
                                    <div style={{ display: 'flex', gap: '20px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '12px', marginTop: '4px' }}>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>Studio Username</div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <code style={{ color: '#fbbf24', fontSize: 13 }}>{db.credentials.username}</code>
                                                <button className="btn btn-icon" onClick={() => copyToClipboard(db.credentials.username)} style={{ padding: 2, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>📋</button>
                                            </div>
                                        </div>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>Studio Password</div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <code style={{ color: '#fbbf24', fontSize: 13 }}>{db.credentials.password}</code>
                                                <button className="btn btn-icon" onClick={() => copyToClipboard(db.credentials.password)} style={{ padding: 2, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>📋</button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {showModal && (
                <div className="modal-backdrop">
                    <div className="modal card" style={{ width: 450, padding: 30 }}>
                        <h2 style={{ marginTop: 0, marginBottom: 20 }}>Provision Database</h2>
                        <form onSubmit={handleCreate}>
                            <div className="form-group" style={{ marginBottom: 15 }}>
                                <label>Database Name</label>
                                <input
                                    type="text"
                                    required
                                    pattern="[a-zA-Z0-9-]+"
                                    placeholder="e.g. my-ecommerce-db"
                                    value={newDb.name}
                                    onChange={e => setNewDb({ ...newDb, name: e.target.value })}
                                />
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>No spaces. alphanumeric and dashes only.</div>
                            </div>
                            <div className="form-group" style={{ marginBottom: 25 }}>
                                <label>Engine Type</label>
                                <select value={newDb.type} onChange={e => setNewDb({ ...newDb, type: e.target.value })}>
                                    <option value="mongo">MongoDB 6.0</option>
                                    <option value="postgres">PostgreSQL 15</option>
                                    <option value="mysql">MySQL 8.0</option>
                                    <option value="redis">Redis 7.0</option>
                                </select>
                            </div>
                            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">Create DB</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {shareModalDb && (
                <div className="modal-backdrop">
                    <div className="modal card" style={{ width: 450, padding: 30 }}>
                        <h2 style={{ marginTop: 0, marginBottom: 20 }}>Share Database</h2>
                        <form onSubmit={handleShare}>
                            <div className="form-group" style={{ marginBottom: 15 }}>
                                <label>Client Email Address</label>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <input
                                        type="email"
                                        required
                                        placeholder="client@example.com"
                                        value={shareEmail}
                                        onChange={e => setShareEmail(e.target.value)}
                                        style={{ flex: 1 }}
                                    />
                                    <button type="submit" className="btn btn-primary">Share</button>
                                </div>
                            </div>
                        </form>

                        <div style={{ marginTop: 25 }}>
                            <label>Current Viewers</label>
                            {shareModalDb.viewers && shareModalDb.viewers.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                                    {shareModalDb.viewers.map((viewer) => {
                                        // Handle populated vs unpopulated viewer array
                                        const email = viewer.email || 'Viewer ID: ' + viewer;
                                        const vId = viewer._id || viewer;
                                        return (
                                            <div key={vId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '8px 12px', borderRadius: 6 }}>
                                                <div style={{ fontSize: 13 }}>{email}</div>
                                                <button className="btn btn-danger" onClick={() => handleRevoke(vId)} style={{ padding: '4px 8px', fontSize: 11 }}>Revoke</button>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>No clients have access yet.</div>
                            )}
                        </div>

                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 30 }}>
                            <button type="button" className="btn btn-secondary" onClick={() => setShareModalDb(null)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
