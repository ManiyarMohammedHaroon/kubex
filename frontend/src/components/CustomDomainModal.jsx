import React, { useState } from 'react';
import { addCustomDomain, removeCustomDomain } from '../api/client';

const CustomDomainModal = ({ deployment, onClose, onRefresh }) => {
    const [domainInput, setDomainInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!domainInput) return;
        setLoading(true);
        setError(null);
        try {
            await addCustomDomain(deployment._id, domainInput.trim());
            setDomainInput('');
            onRefresh();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to add domain');
        } finally {
            setLoading(false);
        }
    };

    const handleRemove = async (domain) => {
        if (!window.confirm(`Remove custom domain ${domain}? Traffic will no longer route here.`)) return;
        setLoading(true);
        setError(null);
        try {
            await removeCustomDomain(deployment._id, domain);
            onRefresh();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to remove domain');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
                <div className="modal-header">
                    <h2>Manage Custom Domains</h2>
                    <button className="btn-close" onClick={onClose}>&times;</button>
                </div>
                
                <div style={{ padding: '0 24px', marginBottom: 20 }}>
                    <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
                        Map your own domains to <strong>{deployment.name}</strong>. The KUBEX Edge Router will instantly begin proxying traffic to your isolated network.
                    </p>
                    
                    {error && <div style={{ color: 'var(--accent-red)', marginBottom: 12, fontSize: 13 }}>{error}</div>}
                    
                    <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
                        <input
                            type="text"
                            className="form-control"
                            placeholder="e.g. api.expensestracker.com"
                            value={domainInput}
                            onChange={e => setDomainInput(e.target.value)}
                            disabled={loading}
                        />
                        <button type="submit" className="btn btn-primary" disabled={loading || !domainInput}>
                            {loading ? 'Adding...' : 'Add'}
                        </button>
                    </form>
                    
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Active Domains</h3>
                    {deployment.customDomains && deployment.customDomains.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {deployment.customDomains.map(d => (
                                <div key={d} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-primary)', padding: '10px 14px', borderRadius: 6, border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{ color: 'var(--accent-green)', fontWeight: 'bold' }}>WWW</span>
                                        <span style={{ fontWeight: 500 }}>{d}</span>
                                    </div>
                                    <button 
                                        onClick={() => handleRemove(d)} 
                                        className="btn btn-danger" 
                                        style={{ padding: '4px 10px', fontSize: 12 }}
                                        disabled={loading}
                                    >
                                        Remove
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-primary)', borderRadius: 6, border: '1px dashed var(--border)' }}>
                            No custom domains configured
                        </div>
                    )}
                </div>
                
                <div className="modal-actions" style={{ justifyContent: 'center' }}>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Point your domain's CNAME record to your Edge Router IP to go live.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default CustomDomainModal;
