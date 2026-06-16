/**
 * @file pages/Deployments.jsx — Deployment management page.
 *
 * Displays all KUBEX deployments as cards, each showing:
 *   - Name, Docker image, and current status badge
 *   - Actual vs. desired replica count (colour-coded)
 *   - CPU and memory resource limits
 *   - Clickable endpoint links for each running container (via host port)
 *   - Scale and delete action buttons
 *   - HPA badge (if autoscaling is enabled)
 *
 * Polls GET /deployments every 3 seconds for live status updates.
 *
 * Sub-components:
 *   CreateModal — form modal for creating a new deployment
 *   ScaleModal  — simple numeric input modal for changing replica count
 *
 * Status badge colour mapping:
 *   Running     → green
 *   Degraded    → red
 *   Pending     → yellow
 *   Scaling     → blue
 *   Terminating → purple
 *   Failed      → red
 */
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    getDeployments, createDeployment, scaleDeployment,
    deleteDeployment, patchDeployment, rebalanceDeployment,
    redeployDeployment, getBuildLogs, shareDeployment, revokeDeploymentAccess, updateEnvVars
} from '../api/client';
import CustomDomainModal from '../components/CustomDomainModal';

/**
 * Map deployment status strings to CSS badge colour modifier classes.
 * Used to colour-code status badges in every deployment card.
 */
const STATUS_BADGE = {
    Running: 'green',
    Degraded: 'red',
    Pending: 'yellow',
    Scaling: 'blue',
    Terminating: 'purple',
    Failed: 'red',
    Building: 'yellow',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * CreateModal — form for creating a new deployment.
 *
 * Fields:
 *   - name (required)        — unique deployment identifier
 *   - image (required)       — Docker image (e.g. "nginx:latest")
 *   - desiredReplicas        — how many containers to run (0–20)
 *   - cpu / memory           — per-container resource limits
 *   - autoscalingEnabled     — toggle HPA on/off
 *   - minReplicas/maxReplicas — HPA bounds (only shown when autoscaling on)
 *
 * On submit, calls onCreate() (which calls the API and refreshes the list),
 * then closes the modal. API validation errors are displayed inline.
 *
 * @param {Function} onClose   Callback to close the modal without creating
 * @param {Function} onCreate  Async callback that receives the form data object
 */
function CreateModal({ onClose, onCreate, prefilledImage = '', onRefresh }) {
    // Form state — initialised with sensible defaults
    const [form, setForm] = useState({
        name: '', desiredReplicas: 2,
        cpu: '0.5', memory: '128m', autoscalingEnabled: false,
        minReplicas: 1, maxReplicas: 10, containerPort: 80, 
        staticHostPort: '', envText: '',
        gitRepository: '',
        gitBranch: 'main',
        gitToken: '',
        autoDeploy: true,
        dockerHubUsername: localStorage.getItem('kubex_dockerhub_username') || '',
        healthCheckEnabled: false,
        healthCheckPath: '/health',
        environment: 'cloud'
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    /**
     * Submit the deployment creation request.
     * Note: desiredReplicas, minReplicas, maxReplicas are parsed as integers
     * because HTML number inputs return strings.
     */
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

            await onCreate({
                name: form.name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase(),
                desiredReplicas: parseInt(form.desiredReplicas),
                resourceLimits: { cpu: form.cpu, memory: form.memory },
                autoscalingEnabled: form.autoscalingEnabled,
                minReplicas: parseInt(form.minReplicas),
                maxReplicas: parseInt(form.maxReplicas),
                containerPort: parseInt(form.containerPort),
                staticHostPort: form.staticHostPort,
                envVars,
                gitRepository: form.gitRepository,
                gitBranch: form.gitBranch,
                gitToken: form.gitToken,
                autoDeploy: form.autoDeploy,
                dockerHubUsername: form.dockerHubUsername,
                healthCheck: {
                    enabled: form.healthCheckEnabled,
                    path: form.healthCheckPath
                },
                environment: form.environment
            });
            
            localStorage.setItem('kubex_dockerhub_username', form.dockerHubUsername);
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        // Clicking the overlay (not the modal card) closes the modal
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal" style={{ maxWidth: 650 }}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>Create Git Deployment</h2>
                <div style={{ color: 'var(--text-muted)', fontSize: '11.5px', marginBottom: 20, background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--glass-border)', lineHeight: 1.5 }}>
                    <strong>Note:</strong> KUBEX Git Engine automatically scans your repo for <code>frontend/</code> and <code>backend/</code> subdirectories. If detected, they are split into separate dedicated containers automatically!
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>GitHub Repository HTTPS URL</label>
                        <input 
                            value={form.gitRepository} 
                            onChange={e => {
                                const repo = e.target.value;
                                setForm(p => {
                                    const updates = { gitRepository: repo };
                                    if (!p.name && repo.includes('/')) {
                                        const parts = repo.split('/');
                                        const lastPart = parts[parts.length - 1].replace(/\.git$/, '');
                                        updates.name = lastPart.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                                    }
                                    return { ...p, ...updates };
                                });
                            }}
                            placeholder="https://github.com/username/repo-name" 
                            required 
                        />
                    </div>



                    <div className="form-row">
                        <div className="form-group">
                            <label>Deployment Base Name</label>
                            <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                                placeholder="my-app" required />
                        </div>
                        <div className="form-group">
                            <label>Docker Hub Username</label>
                            <input 
                                value={form.dockerHubUsername} 
                                onChange={e => setForm(p => ({ ...p, dockerHubUsername: e.target.value }))}
                                placeholder="username" 
                                required 
                            />
                        </div>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label>Git Branch</label>
                            <input 
                                value={form.gitBranch} 
                                onChange={e => setForm(p => ({ ...p, gitBranch: e.target.value }))}
                                placeholder="main" 
                                required 
                            />
                        </div>
                        <div className="form-group">
                            <label>Personal Access Token (PAT) <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>(Optional for private)</span></label>
                            <input 
                                type="password"
                                value={form.gitToken} 
                                onChange={e => setForm(p => ({ ...p, gitToken: e.target.value }))}
                                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" 
                            />
                        </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 15, padding: '10px 12px', background: 'rgba(16, 185, 129, 0.05)', borderRadius: 6, border: '1px solid rgba(16, 185, 129, 0.1)' }}>
                        <label className="toggle" style={{ width: 28, height: 16 }}>
                            <input type="checkbox" checked={form.autoDeploy} onChange={e => setForm(p => ({ ...p, autoDeploy: e.target.checked }))} />
                            <span className="toggle-slider" style={{ borderRadius: 16 }} />
                        </label>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-green)' }}>GitHub Webhook Auto Deploy on Push</span>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label>Replicas</label>
                            <input type="number" min={0} max={20} value={form.desiredReplicas}
                                onChange={e => setForm(p => ({ ...p, desiredReplicas: e.target.value }))} />
                        </div>
                        <div className="form-group">
                            <label>CPU Limit</label>
                            <input value={form.cpu} onChange={e => setForm(p => ({ ...p, cpu: e.target.value }))} placeholder="0.5" />
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Container Port (Internal)</label>
                            <input type="number" value={form.containerPort} onChange={e => setForm(p => ({ ...p, containerPort: e.target.value }))} placeholder="80" />
                        </div>
                        <div className="form-group">
                            <label>Static Host Port (External)</label>
                            <input type="number" value={form.staticHostPort} onChange={e => setForm(p => ({ ...p, staticHostPort: e.target.value }))} placeholder="e.g. 8001" />
                        </div>
                    </div>
                    <div className="form-group">
                        <label>Environment Variables (KEY=VALUE, one per line)</label>
                        <textarea 
                            style={{ width: '100%', height: 60, padding: 8, borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                            placeholder="DB_HOST=mongodb&#10;API_KEY=secret123"
                            value={form.envText}
                            onChange={e => setForm(p => ({ ...p, envText: e.target.value }))}
                        />
                    </div>
                    <div className="form-row" style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '10px 12px', borderRadius: 6, border: '1px solid rgba(239, 68, 68, 0.1)', marginBottom: 15 }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent-red)' }}>
                                <span>L7 App Health Check</span>
                                <label className="toggle" style={{ width: 28, height: 16 }}>
                                    <input type="checkbox" checked={form.healthCheckEnabled}
                                        onChange={e => setForm(p => ({ ...p, healthCheckEnabled: e.target.checked }))} />
                                    <span className="toggle-slider" style={{ borderRadius: 16 }} />
                                </label>
                            </label>
                            {form.healthCheckEnabled && (
                                <div style={{ marginTop: 6 }}>
                                    <input 
                                        type="text" 
                                        value={form.healthCheckPath} 
                                        onChange={e => setForm(p => ({ ...p, healthCheckPath: e.target.value }))} 
                                        placeholder="/health" 
                                        style={{ borderColor: 'var(--accent-red)' }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span>Autoscaling</span>
                                <label className="toggle">
                                    <input type="checkbox" checked={form.autoscalingEnabled}
                                        onChange={e => setForm(p => ({ ...p, autoscalingEnabled: e.target.checked }))} />
                                    <span className="toggle-slider" />
                                </label>
                            </label>
                            {form.autoscalingEnabled && (
                                <div style={{ marginTop: 6 }}>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <input type="number" placeholder="Min" value={form.minReplicas}
                                            onChange={e => setForm(p => ({ ...p, minReplicas: e.target.value }))} />
                                        <input type="number" placeholder="Max" value={form.maxReplicas}
                                            onChange={e => setForm(p => ({ ...p, maxReplicas: e.target.value }))} />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    {error && <div style={{ color: 'var(--accent-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
                    <div className="form-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={loading}>
                            {loading ? <span className="spinner" /> : 'Deploy'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

/**
 * ScaleModal — simple modal to change the replica count of an existing deployment.
 * Pre-filled with the current desiredReplicas; user adjusts and confirms.
 * The max is capped by dep.maxReplicas (or 20) to match the API server limit.
 *
 * @param {object}   dep      The deployment document to scale
 * @param {Function} onClose  Callback to close the modal
 * @param {Function} onScale  Async callback that receives (deploymentId, replicas)
 */
function ScaleModal({ dep, onClose, onScale }) {
    const [replicas, setReplicas] = useState(dep.desiredReplicas); // pre-populate
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleScale = async () => {
        setLoading(true);
        setError('');
        try {
            await onScale(dep._id, parseInt(replicas)); // Parse to int (input returns string)
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal" style={{ maxWidth: 380 }}>
                <h2>Scale "{dep.name}"</h2>
                {/* Show current state so user has context before changing */}
                <div style={{ color: 'var(--text-secondary)', fontSize: 13.5, marginBottom: 20 }}>
                    Current: <strong style={{ color: 'var(--text-primary)' }}>{dep.actualReplicas}</strong> running /
                    <strong style={{ color: 'var(--text-primary)' }}> {dep.desiredReplicas}</strong> desired
                </div>
                <div className="form-group">
                    <label>New Replica Count</label>
                    <input type="number" min={0} max={dep.maxReplicas || 20} value={replicas}
                        onChange={e => setReplicas(e.target.value)} />
                </div>
                {error && <div style={{ color: 'var(--accent-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
                <div className="form-actions">
                    <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" onClick={handleScale} disabled={loading}>
                        {loading ? <span className="spinner" /> : 'Apply Scale'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function EnvVarModal({ dep, onClose, onSave }) {
    const [envVars, setEnvVars] = useState(dep.envVars || []);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const addEnvVar = () => setEnvVars([...envVars, { key: '', value: '' }]);
    const updateEnvVar = (index, field, value) => {
        const newVars = [...envVars];
        newVars[index][field] = value;
        setEnvVars(newVars);
    };
    const removeEnvVar = (index) => setEnvVars(envVars.filter((_, i) => i !== index));

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        try {
            await onSave(dep._id, envVars);
            onClose();
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal card" style={{ width: 500, padding: 30 }}>
                <h2 style={{ marginTop: 0, marginBottom: 20 }}>Edit Environment Variables</h2>
                {error && <div className="error-message" style={{ marginBottom: 15, color: 'var(--accent-red)' }}>{error}</div>}
                <form onSubmit={handleSubmit}>
                    <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 15 }}>
                        {envVars.length === 0 && <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No variables set.</p>}
                        {envVars.map((ev, index) => (
                            <div key={index} style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                                <input
                                    type="text"
                                    placeholder="KEY"
                                    value={ev.key}
                                    onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                                    style={{ flex: 1 }}
                                    required
                                />
                                <input
                                    type="text"
                                    placeholder="VALUE"
                                    value={ev.value}
                                    onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                                    style={{ flex: 2 }}
                                    required
                                />
                                <button type="button" className="btn btn-danger btn-sm" onClick={() => removeEnvVar(index)} style={{ padding: '0 10px' }}>✕</button>
                            </div>
                        ))}
                    </div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={addEnvVar} style={{ marginBottom: 20 }}>+ Add Variable</button>
                    
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
                        Saving will completely rebuild the Docker container. Expect 30-60 seconds of downtime.
                    </p>

                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={loading}>
                            {loading ? 'Saving...' : 'Save & Redeploy'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

/**
 * BuildLogsModal — highly premium frosted dark terminal console with glowing green
 * text for real-time build streaming and analysis logs.
 */
function BuildLogsModal({ dep, onClose }) {
    const [logs, setLogs] = useState('Initializing console connection...');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;
        const fetchLogs = async () => {
            try {
                const res = await getBuildLogs(dep._id);
                if (isMounted) {
                    setLogs(res.data.logs || 'No build logs found yet.');
                    setLoading(false);
                }
            } catch (err) {
                if (isMounted) {
                    setLogs(prev => prev + `\nError streaming logs: ${err.message}`);
                    setLoading(false);
                }
            }
        };

        fetchLogs();
        const interval = setInterval(fetchLogs, 2000);

        return () => {
            isMounted = false;
            clearInterval(interval);
        };
    }, [dep._id]);

    const logEndRef = useCallback((node) => {
        if (node) {
            node.scrollIntoView({ behavior: 'smooth' });
        }
    }, []);

    const copyToClipboard = () => {
        navigator.clipboard.writeText(logs);
        alert('Console logs successfully copied to clipboard!');
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <style>{`
                @keyframes pulse {
                    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
                    70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
                    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
                }
                .pulse-glow {
                    animation: pulse 2s infinite;
                }
            `}</style>
            <div className="modal" style={{ maxWidth: 800, width: '90%', padding: 24, background: 'rgba(15, 23, 42, 0.95)', border: '1px solid rgba(255, 255, 255, 0.1)', backdropFilter: 'blur(20px)', borderRadius: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                    <div>
                        <h2 style={{ margin: 0, fontSize: 20, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>Build Console</span>
                            <span style={{ fontSize: 11, background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '2px 8px', borderRadius: 12, border: '1px solid rgba(16, 185, 129, 0.2)', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 'bold' }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} className="pulse-glow" />
                                {dep.status.toUpperCase()}
                            </span>
                        </h2>
                        <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#94a3b8' }}>
                            Tracking deployment build for <strong>{dep.name}</strong>
                        </p>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
                </div>

                <pre style={{
                        background: 'rgba(255,255,255,0.5)', color: 'var(--text-primary)', border: '1px solid var(--border)', padding: 16, borderRadius: 8,
                        overflowX: 'auto', fontSize: 13, maxHeight: '60vh', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace'
                    }}>
                    {logs}
                    <div ref={logEndRef} />
                </pre>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 15 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Console streams logs in real-time. Logs persist on success/fail.
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button className="btn btn-secondary btn-sm" onClick={copyToClipboard} style={{ fontSize: 11 }}>
                            Copy Logs
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={onClose} style={{ fontSize: 11 }}>
                            Close Console
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Main Page Component ──────────────────────────────────────────────────────

export default function Deployments() {
    const [deps, setDeps] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showCreate, setShowCreate] = useState(false); // Controls CreateModal visibility
    const [scaleTarget, setScaleTarget] = useState(null);  // The deployment being scaled (or null)
    const [envVarTarget, setEnvVarTarget] = useState(null); // The deployment being edited for env vars
    const [domainModalDep, setDomainModalDep] = useState(null); // The deployment being managed (or null)
    const [buildLogsTarget, setBuildLogsTarget] = useState(null); // The deployment whose build logs are being viewed
    const [shareModalDep, setShareModalDep] = useState(null);
    const [shareEmail, setShareEmail] = useState('');
    const [searchParams, setSearchParams] = useSearchParams();
    const [prefilledImage, setPrefilledImage] = useState('');
    const [user] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem('kubex_user') || 'null');
        } catch {
            return null;
        }
    });

    // Fetch deployment list and refresh every 3 s
    const fetchDeps = useCallback(async () => {
        try {
            const res = await getDeployments();
            setDeps(res.data.data);
            setError(null);
        } catch (err) {
            setError(err.message || "Failed to connect to API Server.");
        } finally {
            setLoading(false);
        }
    }, []);

    // Start polling on mount; cleanup on unmount
    useEffect(() => {
        fetchDeps();
        const t = setInterval(fetchDeps, 3000);
        return () => clearInterval(t);
    }, [fetchDeps]);

    // Handle pre-filled image from query params
    useEffect(() => {
        const img = searchParams.get('image');
        if (img) {
            setPrefilledImage(img);
            setShowCreate(true);
            // Clear the param after using it
            setSearchParams({}, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    // ── Event Handlers ──────────────────────────────────────────────────────

    /** Create a new deployment and immediately refresh the list */
    const handleCreate = async (data) => {
        await createDeployment(data);
        fetchDeps();
    };

    /** Scale an existing deployment to the given replica count */
    const handleScale = async (id, replicas) => {
        await scaleDeployment(id, replicas);
        fetchDeps();
    };

    const handleSaveEnv = async (depId, envVars) => {
        try {
            await updateEnvVars(depId, envVars);
            fetchDeps();
        } catch (err) {
            throw new Error(err.response?.data?.error || err.message || 'Server error');
        }
    };

    /** Confirm + delete a deployment (with a browser confirm dialog) */
    const handleDelete = async (id, name) => {
        if (!window.confirm(`Delete deployment "${name}"? All containers will be removed.`)) return;
        try {
            await deleteDeployment(id);
            fetchDeps();
        } catch (err) {
            alert('Failed to delete deployment: ' + (err.response?.data?.error || err.message));
        }
    };

    /** Rebalance a deployment (stops all and recreates across available nodes) */
    const handleRebalance = async (id, name) => {
        if (!window.confirm(`Rebalance "${name}"? This will temporarily stop all containers and redistribute them across all workers. Proceed?`)) return;
        try {
            await rebalanceDeployment(id);
            fetchDeps();
        } catch (err) {
            alert('Failed to rebalance deployment: ' + (err.response?.data?.error || err.message));
        }
    };

    /** Trigger background rebuild and rolling update for a Git-tracked deployment */
    const handleRedeploy = async (id, name, repoUrl) => {
        if (!window.confirm(`Update and redeploy "${name}"?\nThis will pull the latest code from "${repoUrl}", rebuild the Docker image, and roll out the new version in the background.`)) return;
        try {
            setDeps(prev => prev.map(d => d._id === id ? { ...d, status: 'Building' } : d));
            await redeployDeployment(id);
            fetchDeps();
        } catch (err) {
            alert('Failed to trigger redeployment: ' + (err.response?.data?.error || err.message));
            fetchDeps();
        }
    };

    const handleShare = async (e) => {
        e.preventDefault();
        try {
            await shareDeployment(shareModalDep._id, shareEmail);
            setShareEmail('');
            fetchDeps();
            
            const updatedDep = deps.find(d => d._id === shareModalDep._id);
            if (updatedDep) {
                setShareModalDep({ ...shareModalDep });
            }
        } catch (err) {
            alert(err.response?.data?.message || 'Failed to share deployment');
        }
    };

    const handleRevoke = async (userId) => {
        try {
            await revokeDeploymentAccess(shareModalDep._id, userId);
            fetchDeps();
        } catch (err) {
            alert('Failed to revoke access');
        }
    };

    return (
        <div>
            {/* ── Page Header ─────────────────────────────────────────────────── */}
            <div className="page-header">
                <div>
                    <div className="page-title">Deployments</div>
                    <div className="page-subtitle">Manage desired state and replica counts</div>
                </div>
                {/* Button opens the CreateModal overlay */}
                <button className="btn btn-primary" onClick={() => setShowCreate(true)} disabled={user?.role === 'viewer'}>
                    New Deployment
                </button>
            </div>

            {/* Loading spinner (shown until first fetch completes) */}
            {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></div>}

            {/* API Connection Error */}
            {error && !loading && (
                <div style={{ backgroundColor: 'var(--bg-card)', padding: 20, borderRadius: 8, color: 'var(--accent-red)', border: '1px solid var(--accent-red)' }}>
                    <strong>Error:</strong> {error} <br/>
                    Is the API Server running? Try running <code>npm start</code> in the <code>control-plane/api-server</code> directory.
                </div>
            )}

            {/* ── Deployment Cards Grid ────────────────────────────────────────── */}
            {deps.length > 0 && (
                <div className="deployments-grid">
                    {deps.map((dep) => (
                        <div key={dep._id} className="card deployment-card">
                            {/* Card header: name, image, and status badge */}
                            <div className="deployment-header">
                                <div className="deployment-meta">
                                    <span className="deployment-name">
                                        {dep.name}
                                        {dep.owner !== user?._id && (
                                            <span className="badge badge-purple" style={{ marginLeft: 10, fontSize: 10 }}>Managed for You</span>
                                        )}
                                        <span className="badge badge-green" style={{ marginLeft: dep.owner !== user?._id ? 6 : 10, fontSize: 9, background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent-green)', border: '1px solid rgba(16, 185, 129, 0.2)' }} title="This deployment runs in an isolated Virtual Private Cloud Docker network">
                                            Namespace: {String(dep.owner).slice(0, 8)}
                                        </span>
                                    </span>
                                    <span className="deployment-image">{dep.image}</span>
                                    {dep.lastError && (
                                        <div style={{ 
                                            padding: '8px 12px', 
                                            background: 'rgba(239, 68, 68, 0.1)', 
                                            border: '1px solid rgba(239, 68, 68, 0.2)', 
                                            borderRadius: 6, 
                                            color: 'var(--accent-red)', 
                                            fontSize: '11.5px', 
                                            fontFamily: 'monospace',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                            marginTop: 4
                                        }}>
                                            Error: {dep.lastError}
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                                        {Object.keys(dep.nodeAssignments || {}).length > 0 && (
                                            <span style={{ width: 'fit-content', fontSize: '9px', background: 'rgba(245, 158, 11, 0.12)', padding: '2px 6px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4, color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.25)', fontWeight: 'bold' }}>
                                                Worker: {Object.keys(dep.nodeAssignments).join(', ')}
                                            </span>
                                        )}
                                        {dep.gitRepository && (
                                            <>
                                                <span style={{ width: 'fit-content', fontSize: '9px', background: dep.environment === 'cloud' ? 'rgba(96, 165, 250, 0.12)' : 'rgba(255, 255, 255, 0.08)', padding: '2px 6px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4, color: dep.environment === 'cloud' ? '#60a5fa' : 'var(--text-secondary)', border: `1px solid ${dep.environment === 'cloud' ? 'rgba(96, 165, 250, 0.25)' : 'var(--glass-border)'}`, fontWeight: 'bold', textTransform: 'capitalize' }}>
                                                    {dep.environment || 'Local'}
                                                </span>
                                                <span style={{ width: 'fit-content', fontSize: '9px', background: 'rgba(255, 255, 255, 0.08)', padding: '2px 6px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', border: '1px solid var(--glass-border)', fontWeight: 'bold' }}>
                                                    Branch: {dep.gitBranch}
                                                </span>
                                                {dep.gitSubfolder && (
                                                    <span style={{ width: 'fit-content', fontSize: '9px', background: 'rgba(59, 130, 246, 0.12)', padding: '2px 6px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4, color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.25)', fontWeight: 'bold' }}>
                                                        Subfolder: {dep.gitSubfolder}
                                                    </span>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                                <span className={`badge badge-${STATUS_BADGE[dep.status] || 'gray'}`}>
                                    <span className="badge-dot" />
                                    {dep.status}
                                </span>
                            </div>

                            {/* Replica count and resource limits grid */}
                            <div className="stats-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 0, gap: 12 }}>
                                <div className="detail-item">
                                    <div className="detail-item-label">Replicas</div>
                                    <div className="detail-item-value">
                                        {/* Green if actual == desired; yellow if mismatched */}
                                        <span style={{ color: dep.actualReplicas === dep.desiredReplicas ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                                            {dep.actualReplicas}
                                        </span>
                                        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 4 }}>/ {dep.desiredReplicas}</span>
                                    </div>
                                </div>
                                <div className="detail-item">
                                    <div className="detail-item-label">Resources</div>
                                    <div className="detail-item-value" style={{ fontSize: 11 }}>
                                        {dep.resourceLimits?.cpu} CPU · {dep.resourceLimits?.memory}
                                    </div>
                                </div>
                            </div>

                            {/* Service Endpoints: clickable host port links for each running container */}
                            {/* Each link opens the container's web service in a new browser tab */}
                            <div className="detail-section">
                                <div className="endpoint-grid">
                                    <div className="gateway-urls" style={{ width: '100%', marginBottom: 12 }}>
                                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>Live Public URL (Auto-Tunnel):</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            {dep.tunnelUrl ? (
                                                <a
                                                    href={dep.tunnelUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="endpoint-link gateway-link"
                                                    style={{ width: '100%', justifyContent: 'flex-start', background: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.2)' }}
                                                >
                                                    <span style={{ fontSize: 11 }}>{dep.tunnelUrl.replace('https://', '')}</span>
                                                </a>
                                            ) : (
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Tunnel generating...</div>
                                            )}
                                        </div>
                                    </div>

                                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, width: '100%' }}>Direct Container Pods:</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                        {dep.containers?.filter(c => c.status === 'running' && c.hostPort).map((c, i) => (
                                            <a
                                                key={i}
                                                href={`http://localhost:${c.hostPort}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="endpoint-link"
                                                title={`Node: ${c.nodeId} | IP: ${c.ip}`}
                                            >
                                                <span>Port: {c.hostPort}</span>
                                                <span className="endpoint-node">{c.nodeId.split('-')[1]}</span>
                                            </a>
                                        ))}
                                    </div>
                                    {(!dep.containers || dep.containers.filter(c => c.status === 'running').length === 0) && (
                                        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>
                                            Waiting for containers to provision...
                                        </div>
                                    )}
                                </div>
                                
                                {dep.gitRepository && user?.role !== 'viewer' && (
                                    <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--glass-border)', borderRadius: 8, width: '100%' }}>
                                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span>GitHub Push Webhook URL:</span>
                                            <button 
                                                onClick={() => {
                                                    const url = `${window.location.protocol}//${window.location.hostname}:3001/api/webhooks/github/${dep._id}?token=${dep.webhookSecret}`;
                                                    navigator.clipboard.writeText(url);
                                                    alert('Webhook URL successfully copied to clipboard!');
                                                }}
                                                style={{ border: 'none', background: 'none', color: 'var(--accent-blue)', fontSize: 9, cursor: 'pointer', padding: 0, fontWeight: 'bold' }}
                                            >
                                                Copy URL
                                            </button>
                                        </div>
                                        <div style={{ fontFamily: 'monospace', fontSize: 9, color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: 4 }}>
                                            {`${window.location.protocol}//${window.location.hostname}:3001/api/webhooks/github/${dep._id}?token=${dep.webhookSecret}`}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Card Footer: Scale + Delete buttons, HPA badge */}
                            <div style={{ marginTop: 'auto', paddingTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--glass-border)' }}>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    {user?.role !== 'viewer' && (
                                        <>
                                            <button className="btn btn-secondary btn-sm" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={() => setScaleTarget(dep)}>
                                                Scale
                                            </button>
                                            <button className="btn btn-secondary btn-sm" style={{ padding: '6px 12px', fontSize: '12px' }} title="Edit Environment Variables" onClick={() => setEnvVarTarget(dep)}>
                                                Variables
                                            </button>
                                            <button className="btn btn-secondary btn-sm" style={{ padding: '6px 12px', fontSize: '12px' }} title="Redistribute containers across nodes" onClick={() => handleRebalance(dep._id, dep.name)}>
                                                Rebalance
                                            </button>
                                            <button className="btn btn-secondary btn-sm" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={() => setShareModalDep(dep)}>
                                                Share
                                            </button>
                                            <button className="btn btn-secondary btn-sm" style={{ padding: '6px 12px', fontSize: '12px', background: 'var(--bg-primary)' }} onClick={() => setDomainModalDep(dep)}>
                                                Manage Domains
                                            </button>
                                        </>
                                    )}
                                    {dep.gitRepository && (
                                        <button 
                                            className="btn btn-secondary btn-sm" 
                                            style={{ padding: '6px 12px', fontSize: '12px' }}
                                            title="View Git & Docker Build Logs"
                                            onClick={() => setBuildLogsTarget(dep)}
                                        >
                                            Logs
                                        </button>
                                    )}
                                    {dep.gitRepository && user?.role !== 'viewer' && (
                                        <button 
                                            className="btn btn-primary btn-sm" 
                                            style={{ padding: '6px 12px', fontSize: '12px', background: 'var(--accent-blue)', borderColor: 'var(--accent-blue)' }}
                                            title={`Re-deploy from Git branch: ${dep.gitBranch}`}
                                            onClick={() => handleRedeploy(dep._id, dep.name, dep.gitRepository)}
                                            disabled={dep.status === 'Building'}
                                        >
                                            Re-deploy
                                        </button>
                                    )}
                                    {user?.role !== 'viewer' && (
                                        <button className="btn btn-danger btn-sm" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={() => handleDelete(dep._id, dep.name)}>
                                            Delete
                                        </button>
                                    )}
                                </div>
                                {/* HPA badge shows the min-max replica range when autoscaling is on */}
                                {dep.autoscalingEnabled && (
                                    <span className="badge badge-blue" style={{ fontSize: 9 }}>
                                        HPA: {dep.minReplicas}-{dep.maxReplicas}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Modals (only one can be open at a time) ─────────────────────── */}
            {/* CreateModal triggered by the "+ New Deployment" button or query param */}
            {showCreate && (
                <CreateModal 
                    onClose={() => setShowCreate(false)} 
                    onCreate={handleCreate} 
                    onRefresh={fetchDeps}
                    prefilledImage={prefilledImage} 
                />
            )}
            {scaleTarget && (
                <ScaleModal dep={scaleTarget} onClose={() => setScaleTarget(null)} onScale={handleScale} />
            )}
            {envVarTarget && (
                <EnvVarModal dep={envVarTarget} onClose={() => setEnvVarTarget(null)} onSave={handleSaveEnv} />
            )}
            {buildLogsTarget && (
                <BuildLogsModal dep={buildLogsTarget} onClose={() => setBuildLogsTarget(null)} />
            )}
            {shareModalDep && (
                <div className="modal-backdrop">
                    <div className="modal card" style={{ width: 450, padding: 30 }}>
                        <h2 style={{ marginTop: 0, marginBottom: 20 }}>Share Deployment</h2>
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
                            {shareModalDep.viewers && shareModalDep.viewers.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                                    {shareModalDep.viewers.map((viewer) => {
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
                            <button type="button" className="btn btn-secondary" onClick={() => setShareModalDep(null)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
            {domainModalDep && (
                <CustomDomainModal 
                    deployment={domainModalDep} 
                    onClose={() => setDomainModalDep(null)} 
                    onRefresh={fetchDeps} 
                />
            )}
        </div>
    );
}
