/**
 * @file pages/Logs.jsx — Live container log viewer page.
 *
 * Allows the user to select a deployment from a dropdown and view the last
 * 200 log lines from every running container of that deployment,
 * fetched live from Docker via GET /api/logs/:deploymentId.
 *
 * Features:
 *   - Deployment selector dropdown (auto-selects first deployment on load)
 *   - Manual refresh button
 *   - Auto-refresh toggle (polls every 4 s when enabled)
 *   - Per-container log panels showing containerId and nodeId
 *
 * Polling design:
 *   The component uses two separate useEffect hooks:
 *     1. Fetch deployment list once on mount (no need to re-poll the list)
 *     2. Re-fetch logs whenever selectedId changes (via useCallback + useEffect)
 *   A third useEffect manages the auto-refresh interval independently so the
 *   interval can be stopped/started by the toggle without reloading the whole component.
 */
import { useEffect, useState, useCallback } from 'react';
import { getDeployments, getLogs } from '../api/client';

export default function Logs() {
    const [deployments, setDeployments] = useState([]);  // All available deployments (for the dropdown)
    const [selectedId, setSelectedId] = useState('');  // MongoDB _id of the currently selected deployment
    const [logs, setLogs] = useState(null); // Log response: { deployment, containers[] } or { error }
    const [loading, setLoading] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(false); // Toggle: true = poll every 4 s

    // ── Step 1: Load the deployment list once on mount ─────────────────────────
    // We don't need to re-poll this — deployments are long-lived.
    // Auto-select the first deployment so logs appear immediately.
    useEffect(() => {
        getDeployments().then((r) => {
            const data = r.data.data;
            setDeployments(data);
            if (data.length > 0 && !selectedId) setSelectedId(data[0]._id);
        }).catch((err) => {
            setLogs({ error: err.message || "Failed to load deployments" });
        });
    }, []);

    // ── Step 2: Fetch logs whenever the selected deployment changes ────────────
    // useCallback ensures fetchLogs is stable so the useEffect only fires when
    // selectedId actually changes (not on every render).
    const fetchLogs = useCallback(async () => {
        if (!selectedId) return; // Nothing selected yet — skip
        setLoading(true);
        try {
            const res = await getLogs(selectedId);
            setLogs(res.data.data); // { deployment: string, containers: [...] }
        } catch (err) {
            // Store the error in the logs state so it can be displayed inline
            setLogs({ error: err.message });
        } finally {
            setLoading(false);
        }
    }, [selectedId]);

    // Re-run fetchLogs when selectedId or the fetchLogs reference changes
    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    // ── Step 3: Auto-refresh interval (independent of the fetch-on-change above) ─
    // This effect only manages the interval timer.
    // When autoRefresh is disabled, the cleanup function clears the timer.
    useEffect(() => {
        if (!autoRefresh) return; // Interval disabled — nothing to set up
        const t = setInterval(fetchLogs, 4000); // Refresh every 4 s
        return () => clearInterval(t); // Clear on toggle-off or unmount
    }, [autoRefresh, fetchLogs]);

    return (
        <div>
            {/* ── Page Header ─────────────────────────────────────────────────── */}
            <div className="page-header">
                <div>
                    <div className="page-title">Container Logs</div>
                    <div className="page-subtitle">View stdout/stderr from all running replicas</div>
                </div>
                {/* Controls: deployment selector, manual refresh, auto-refresh toggle */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {/* Deployment selector — triggers a new log fetch when changed */}
                    <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}
                        style={{ width: 200 }}>
                        {deployments.map((d) => (
                            <option key={d._id} value={d._id}>{d.name}</option>
                        ))}
                    </select>

                    {/* Manual refresh button (shows spinner while loading) */}
                    <button className="btn btn-secondary" onClick={fetchLogs} disabled={loading}>
                        {loading ? <span className="spinner" /> : '↻ Refresh'}
                    </button>

                    {/* Toggle switch for auto-refresh every 4 s */}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', textTransform: 'none' }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Auto</span>
                        <label className="toggle">
                            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
                            <span className="toggle-slider" />
                        </label>
                    </label>
                </div>
            </div>

            {/* ── Empty States ─────────────────────────────────────────────────── */}

            {/* Prompt: no deployment selected yet (should be brief — auto-selects on load) */}
            {!logs && !loading && (
                <div className="empty-state">
                    <div className="empty-icon">📋</div>
                    <h3>Select a deployment to view logs</h3>
                </div>
            )}

            {/* No containers running for the selected deployment */}
            {logs?.containers?.length === 0 && (
                <div className="empty-state">
                    <div className="empty-icon">📭</div>
                    <h3>No running containers</h3>
                    <p>No containers are currently running for this deployment</p>
                </div>
            )}

            {/* ── Log Panels ────────────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gap: 20 }}>
                {logs?.containers?.map((container, i) => (
                    <div
                        key={i}
                        className="card log-panel"
                        style={{
                            padding: 0,
                            overflow: 'hidden',
                            borderLeft: '4px solid var(--accent-cyan)',
                            animationDelay: `${i * 0.1}s`
                        }}
                    >
                        {/* Panel Header */}
                        <div style={{
                            padding: '12px 20px',
                            background: 'rgba(255,255,255,0.02)',
                            borderBottom: '1px solid var(--glass-border)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                <span className="badge badge-green" style={{ fontSize: 10 }}>
                                    <span className="badge-dot" />
                                    Live
                                </span>
                                <code style={{ fontSize: 12, color: 'var(--accent-cyan)', fontWeight: 700 }}>
                                    {container.containerId}
                                </code>
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
                                NODE ID: <span style={{ color: 'var(--text-primary)' }}>{container.nodeId}</span>
                            </div>
                        </div>

                        {/* Terminal Surface */}
                        <div style={{ padding: 16 }}>
                            <div className="logs-container">
                                {container.logs?.trim() || <span style={{ opacity: 0.5 }}>[ No output stream received ]</span>}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Error state: shown if the API call failed (e.g. deployment deleted) */}
            {logs?.error && (
                <div className="card">
                    <div style={{ color: 'var(--accent-red)', fontSize: 13 }}>
                        Error: {logs.error}
                    </div>
                </div>
            )}
        </div>
    );
}
