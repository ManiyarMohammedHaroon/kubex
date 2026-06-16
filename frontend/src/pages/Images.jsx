/**
 * @file pages/Images.jsx — Image Library page.
 * 
 * Displays all Docker images currently stored in the local KUBEX engine.
 * Users can browse their images and quickly deploy them from here.
 */
import { useState, useEffect } from 'react';
import { getImages, deleteImage, pruneImages, createDeployment } from '../api/client';

function DeployImageModal({ onClose, onSuccess }) {
    const [form, setForm] = useState({
        name: '',
        image: '',
        desiredReplicas: 1,
        containerPort: 80,
        envText: ''
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        try {
            const envVars = form.envText.split('\n')
                .filter(l => l.includes('='))
                .map(l => {
                    const idx = l.indexOf('=');
                    return { key: l.substring(0, idx).trim(), value: l.substring(idx + 1).trim() };
                });

            await createDeployment({
                name: form.name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase(),
                image: form.image,
                desiredReplicas: parseInt(form.desiredReplicas),
                containerPort: parseInt(form.containerPort),
                envVars,
                // Defaults for a pre-built image
                gitRepository: '',
                gitBranch: '',
                resourceLimits: { cpu: '0.5', memory: '128m' },
                autoscalingEnabled: false,
                minReplicas: 1,
                maxReplicas: 10
            });
            onSuccess();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal" style={{ maxWidth: 500 }}>
                <h2>Deploy External Image</h2>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Deployment Name</label>
                        <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="my-redis" className="crystal" />
                    </div>
                    <div className="form-group">
                        <label>Docker Image Tag</label>
                        <input required value={form.image} onChange={e => setForm({ ...form, image: e.target.value })} placeholder="redis:alpine" className="crystal" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                        <div className="form-group">
                            <label>Replicas</label>
                            <input type="number" required min="1" max="20" value={form.desiredReplicas} onChange={e => setForm({ ...form, desiredReplicas: e.target.value })} className="crystal" />
                        </div>
                        <div className="form-group">
                            <label>Container Port</label>
                            <input type="number" required value={form.containerPort} onChange={e => setForm({ ...form, containerPort: e.target.value })} className="crystal" />
                        </div>
                    </div>
                    <div className="form-group">
                        <label>Environment Variables (Key=Value)</label>
                        <textarea rows="4" value={form.envText} onChange={e => setForm({ ...form, envText: e.target.value })} placeholder="REDIS_PASSWORD=secret" className="crystal"></textarea>
                    </div>
                    {error && <div className="error-message" style={{ marginBottom: 15 }}>{error}</div>}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Deploying...' : 'Deploy Image'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default function Images() {
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [actionLoading, setActionLoading] = useState(false);
    const [showDeployModal, setShowDeployModal] = useState(false);

    useEffect(() => {
        fetchImages();
    }, []);

    const fetchImages = async () => {
        setLoading(true);
        try {
            const res = await getImages();
            setImages(res.data.images || []);
        } catch (err) {
            console.error('Failed to fetch images:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id, repo) => {
        setActionLoading(true);
        try {
            await deleteImage(id);
            fetchImages();
        } catch (err) {
            alert('Failed to delete: ' + (err.response?.data?.error || err.message));
        } finally {
            setActionLoading(false);
        }
    };

    const handlePrune = async () => {
        if (!window.confirm('Prune all unused images? This will free up disk space by removing images not used by any containers.')) return;
        setActionLoading(true);
        try {
            await pruneImages();
            fetchImages();
        } catch (err) {
            alert('Prune failed: ' + (err.response?.data?.error || err.message));
        } finally {
            setActionLoading(false);
        }
    };

    const filteredImages = images.filter(img => 
        img.repo.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="fade-in">
            <div className="page-header">
                <div>
                    <h1 className="page-title">Image Library</h1>
                    <p className="page-subtitle">Manage and deploy your container images from the KUBEX vault.</p>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <input 
                        type="text" 
                        placeholder="Search images..." 
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="crystal"
                        style={{ width: 250, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--glass-bg)', color: '#fff' }}
                    />
                    <button className="btn btn-primary" onClick={() => setShowDeployModal(true)}>
                        Deploy External Image
                    </button>
                    <button className="btn btn-secondary" onClick={fetchImages} disabled={actionLoading}>
                        Refresh
                    </button>
                    <button className="btn btn-secondary" onClick={handlePrune} disabled={actionLoading} style={{ color: 'var(--accent-red)', borderColor: 'rgba(239, 68, 68, 0.3)' }}>
                        Prune Unused
                    </button>
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
                    <div className="spinner" style={{ width: 40, height: 40 }} />
                </div>
            ) : (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Repository</th>
                                <th>Tag</th>
                                <th>Image ID</th>
                                <th>Created</th>
                                <th>Size</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredImages.length > 0 ? filteredImages.map((img, i) => (
                                <tr key={img.id + i}>
                                    <td>
                                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                            {img.repo}
                                        </div>
                                    </td>
                                    <td>
                                        <span className="badge badge-blue">{img.tag}</span>
                                    </td>
                                    <td style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.7 }}>
                                        {img.id}
                                    </td>
                                    <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                        {img.created}
                                    </td>
                                    <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                        {img.size}
                                    </td>
                                    <td>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button className="btn btn-primary btn-sm" onClick={() => {
                                                window.location.href = `/deployments?image=${img.repo}:${img.tag}`;
                                            }}>
                                                Deploy
                                            </button>
                                            <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(img.id, img.repo)} style={{ padding: '4px 8px', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                                                Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            )) : (
                                <tr>
                                    <td colSpan="6" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No images found in the library.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {showDeployModal && (
                <DeployImageModal 
                    onClose={() => setShowDeployModal(false)}
                    onSuccess={() => {
                        setShowDeployModal(false);
                        window.location.href = '/deployments';
                    }}
                />
            )}
        </div>
    );
}
