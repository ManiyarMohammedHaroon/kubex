/**
 * @file pages/Images.jsx — Image Library page.
 * 
 * Displays all Docker images currently stored in the local KUBEX engine.
 * Users can browse their images and quickly deploy them from here.
 */
import { useState, useEffect } from 'react';
import { getImages, deleteImage, pruneImages } from '../api/client';

export default function Images() {
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [actionLoading, setActionLoading] = useState(false);

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
                    <h1 className="page-title">📚 Image Library</h1>
                    <p className="page-subtitle">Manage and deploy your container images from the KUBEX vault.</p>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <input 
                        type="text" 
                        placeholder="🔍 Search images..." 
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="crystal"
                        style={{ width: 250, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--glass-bg)', color: '#fff' }}
                    />
                    <button className="btn btn-secondary" onClick={fetchImages} disabled={actionLoading}>
                        🔄 Refresh
                    </button>
                    <button className="btn btn-secondary" onClick={handlePrune} disabled={actionLoading} style={{ color: 'var(--accent-red)', borderColor: 'rgba(239, 68, 68, 0.3)' }}>
                        🗑️ Prune Unused
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
                                                🚀 Deploy
                                            </button>
                                            <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(img.id, img.repo)} style={{ padding: '4px 8px', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
                                                🗑️
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
        </div>
    );
}
