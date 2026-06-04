/**
 * @file pages/Nodes.jsx — Worker Node management and chaos testing page.
 *
 * Shows a card for every registered worker node with:
 *   - Node ID, address, status badge, last heartbeat time
 *   - CPU and memory resource bars (colour-coded: green → yellow → red)
 *   - Click to open a NodeDetailModal with more detail and chaos controls
 *
 * Polls GET /nodes every 3 seconds for live status updates.
 *
 * Sub-components:
 *   ResourceBar      — horizontal bar showing a metric% with colour thresholds
 *   NodeDetailModal  — modal with full node details, chaos buttons, container table
 *   NodeCard         — compact node summary card
 */
import { useEffect, useState, useCallback } from 'react';
import { getNodes, getNodeDetail, getNodeLogs, triggerStress, triggerChaosKill, deleteNode, spawnWorker } from '../api/client';

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * ResourceBar — horizontal progress bar for CPU or memory usage.
 * Colour thresholds: > 85% = danger (red), > 60% = warn (yellow), else accent colour.
 *
 * @param {number} value  Percentage value (0–100)
 * @param {string} type   'cpu' or 'mem' — determines default colour class
 */
function ResourceBar({ value, type }) {
    const barClass = value > 85 ? 'danger' : value > 60 ? 'warn' : type;
    return (
        <div style={{ marginBottom: 16 }}>
            <div className="metric-label">
                <span>{type === 'cpu' ? 'CPU' : 'Memory'}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 800 }}>{value.toFixed(1)}%</span>
            </div>
            <div className="resource-bar">
                <div className={`resource-bar-fill ${barClass}`} style={{ width: `${value}%` }} />
            </div>
        </div>
    );
}

/**
 * NodeDetailModal — full detail view for a single node, opened on card click.
 *
 * Fetches GET /nodes/:nodeId every 3 s to keep metrics live.
 * The modal includes:
 *   - Status, address, CPU and MEM bars
 *   - Chaos buttons (CPU burn / random container kill) that call the WORKER AGENT directly
 *   - Table of all running containers on this node (from detailedContainers field)
 *
 * Chaos URL mapping:
 *   The worker agent address stored in MongoDB uses Docker-internal hostnames
 *   (e.g. "http://worker-agent-1:4001"). Since the browser can't reach those,
 *   we swap the hostname to "localhost" and adjust the port for workers 2 and 3.
 *
 * @param {string}   nodeId   Unique node ID (e.g. "worker-1")
 * @param {Function} onClose  Callback to close the modal
 */
function NodeDetailModal({ nodeId, onClose }) {
    const [details, setDetails] = useState(null);
    const [agentLogs, setAgentLogs] = useState([]);
    const [loading, setLoading] = useState(true);

    // Fetch node detail and logs on mount and refresh every 3 s
    useEffect(() => {
        const fetchAll = async () => {
            try {
                const [detailRes, logsRes] = await Promise.all([
                    getNodeDetail(nodeId),
                    getNodeLogs(nodeId).catch(() => ({ data: { data: [] } })) // Fallback if logs fail
                ]);
                setDetails(detailRes.data.data);
                setAgentLogs(logsRes.data.data || []);
            } finally {
                setLoading(false);
            }
        };
        fetchAll();
        const t = setInterval(fetchAll, 3000);
        return () => clearInterval(t); // Cleanup on modal close
    }, [nodeId]);

    if (!details && loading) return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></div>
            </div>
        </div>
    );

    if (!details) return null;

    /**
     * Translate a Docker-internal worker address to a localhost URL reachable
     * from the user's browser.
     * worker-agent-1 → localhost:4001 (default port)
     * worker-agent-2 → localhost:4002 (port adjusted for 2nd worker)
     * worker-agent-3 → localhost:4003 (port adjusted for 3rd worker)
     */
    function resolveAgentUrl(address, nodeId) {
        // The worker already reports its full address (e.g., http://localhost:4001).
        // We only need to ensure 'localhost' is used if it reported a Docker-internal name.
        return address.replace(/worker-agent-\d+/, 'localhost');
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            {/* Stop clicks inside the modal from closing it */}
            <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                    <h2 style={{ margin: 0 }}>🖥 Node Details: {details.nodeId}</h2>
                    <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
                </div>

                {/* ── Status + Metrics Grid ──────────────────────────────────── */}
                <div className="detail-grid">
                    <div className="detail-item">
                        <div className="detail-item-label">Status</div>
                        <div className="detail-item-value">
                            <span className={`badge badge-${details.status === 'Ready' ? 'green' : 'red'}`}>{details.status}</span>
                        </div>
                    </div>
                    <div className="detail-item">
                        <div className="detail-item-label">Address</div>
                        <div className="detail-item-value">{details.address}</div>
                    </div>
                    <div className="detail-item">
                        <div className="detail-item-label">CPU Load</div>
                        <div className="detail-item-value">{details.metrics?.cpuUsage.toFixed(1)}%</div>
                        <ResourceBar value={details.metrics?.cpuUsage ?? 0} type="cpu" />
                    </div>
                    <div className="detail-item">
                        <div className="detail-item-label">Memory Load</div>
                        <div className="detail-item-value">{details.metrics?.memUsage.toFixed(1)}%</div>
                        <ResourceBar value={details.metrics?.memUsage ?? 0} type="mem" />
                    </div>
                </div>

                {/* ── Chaos Buttons ─────────────────────────────────────────── */}
                {/* These call the worker agent DIRECTLY so they bypass the API server */}
                <div className="detail-section">
                    <label>Chaos Control (Testing)</label>
                    <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                        {/* CPU Burn: spike reported CPU to 95% for 30 s → triggers AutoScaler scale-up */}
                        <button
                            className="btn btn-danger btn-sm"
                            style={{ flex: 1 }}
                            onClick={async () => {
                                try {
                                    const finalUrl = resolveAgentUrl(details.address, details.nodeId);
                                    await triggerStress(finalUrl, 95);
                                    alert(`CPU Stress triggered on ${details.nodeId}! Watch the AutoScaler scale up.`);
                                } catch (e) {
                                    alert('Failed to trigger chaos: ' + e.message);
                                }
                            }}
                        >
                            🔥 Burn CPU (AutoScaling)
                        </button>
                        {/* Chaos Kill: stop a random container → tests Reconciler self-healing */}
                        <button
                            className="btn btn-danger btn-sm"
                            style={{ flex: 1 }}
                            onClick={async () => {
                                try {
                                    const finalUrl = resolveAgentUrl(details.address, details.nodeId);
                                    await triggerChaosKill(finalUrl);
                                    alert(`Chaos monkey killed a container on ${details.nodeId}! Watch it self-heal.`);
                                } catch (e) {
                                    alert('Failed to trigger chaos: ' + e.message);
                                }
                            }}
                        >
                            🐒 Kill Random (Self-Healing)
                        </button>
                    </div>
                </div>

                {/* ── Container Table ────────────────────────────────────────── */}
                <div className="detail-section">
                    <label>Running Containers ({details.detailedContainers?.length || 0})</label>
                    <div className="table-wrap">
                        <table className="detail-table">
                            <thead>
                                <tr>
                                    <th>Deployment</th>
                                    <th>Image</th>
                                    <th>ID</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {details.detailedContainers?.map((c, i) => (
                                    <tr key={i}>
                                        <td style={{ fontWeight: 600 }}>{c.deploymentName}</td>
                                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.image}</td>
                                        <td><code>{c.containerId.slice(0, 12)}</code></td>
                                        <td><span className="badge badge-green">running</span></td>
                                    </tr>
                                ))}
                                {(!details.detailedContainers || details.detailedContainers.length === 0) && (
                                    <tr>
                                        <td colSpan="4" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px' }}>
                                            No containers running on this node
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* ── Agent Logs ─────────────────────────────────────────────── */}
                <div className="detail-section">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <label>Agent Operational Logs</label>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Last 200 lines</span>
                    </div>
                    <div className="log-viewer" style={{ 
                        height: 180, 
                        background: '#000', 
                        color: '#0f0', 
                        fontFamily: 'monospace', 
                        fontSize: 11, 
                        padding: 12, 
                        borderRadius: 8, 
                        overflowY: 'auto',
                        border: '1px solid var(--glass-border)',
                        whiteSpace: 'pre-wrap'
                    }}>
                        {agentLogs.length > 0 ? (
                            agentLogs.map((log, i) => (
                                <div key={i} style={{ marginBottom: 4, borderLeft: '2px solid #333', paddingLeft: 8 }}>
                                    {log}
                                </div>
                            ))
                        ) : (
                            <div style={{ color: '#666' }}>No agent logs available yet...</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * NodeCard — compact summary tile for a single worker node.
 * Clicking the card opens the NodeDetailModal for that node.
 *
 * @param {object}   node     Node document from the API
 * @param {Function} onClick  Callback with nodeId when card is clicked
 * @param {Function} onDelete Callback to delete this node
 */
function NodeCard({ node, onClick, onDelete }) {
    const isReady = node.status === 'Ready';

    return (
        <div
            className={`card node-card ${isReady ? 'ready' : 'not-ready'}`}
            onClick={() => onClick(node.nodeId)}
            style={{ position: 'relative' }}
        >
            {/* Pulsing indicator for live status */}
            <div className={`status-pulsar ${isReady ? 'ready' : 'not-ready'}`}
                style={{
                    position: 'absolute', top: 20, right: 20,
                    width: 10, height: 10, borderRadius: '50%',
                    background: isReady ? 'var(--accent-green)' : 'var(--accent-red)',
                    animation: isReady ? 'pulsar-green 2s infinite' : 'pulsar-red 2s infinite'
                }}
            />

            <div className="node-card-bg-icon">🖥</div>

            <div className="node-header" style={{ marginBottom: 16 }}>
                <div>
                    <div className="node-id" style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>
                        {node.nodeId}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', zIndex: 10 }}>
                    <button
                        className="btn btn-danger btn-sm"
                        title="Delete Node"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete(node.nodeId);
                        }}
                    >
                        🗑
                    </button>
                </div>
            </div>

            <div className="detail-item" style={{ marginBottom: 20, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="detail-item-label">Network Address</div>
                <div className="detail-item-value" style={{ fontFamily: 'JetBrains Mono', fontSize: 13, color: 'var(--accent-cyan)' }}>
                    {node.address}
                </div>
            </div>

            <div className="metrics-row">
                <ResourceBar value={node.metrics?.cpuUsage ?? 0} type="cpu" />
                <ResourceBar value={node.metrics?.memUsage ?? 0} type="mem" />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <span className="badge badge-gray" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    📦 {node.metrics?.containerCount ?? 0} Containers
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {node.lastHeartbeat ? `Updated ${Math.floor((Date.now() - new Date(node.lastHeartbeat)) / 1000)}s ago` : 'N/A'}
                </span>
            </div>
        </div>
    );
}

// ─── Main Page Component ──────────────────────────────────────────────────────

export default function Nodes() {
    const [nodes, setNodes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedNodeId, setSelectedNodeId] = useState(null); // null = no modal open
    const [spawnLoading, setSpawnLoading] = useState(false);
    const [spawnMessage, setSpawnMessage] = useState('');

    // Fetch the node list and refresh every 3 s
    const fetchNodes = useCallback(async () => {
        try {
            const res = await getNodes();
            setNodes(res.data.data);
            setError(null);
        } catch (err) {
            setError(err.message || "Failed to connect to API Server.");
        } finally {
            setLoading(false);
        }
    }, []);

    // Start polling on mount; cleanup on unmount to avoid memory leaks
    useEffect(() => {
        fetchNodes();
        const t = setInterval(fetchNodes, 3000);
        return () => clearInterval(t);
    }, [fetchNodes]);

    // Clear all nodes from the database
    const handleClearAllNodes = async () => {
        if (window.confirm("This will remove all node records and attempt to shut down their processes. Proceed?")) {
            try {
                // Delete nodes one by one
                for (const node of nodes) {
                    await deleteNode(node.nodeId);
                }
                setSpawnMessage("✅ Cluster cleared. All node records removed.");
                fetchNodes();
            } catch (err) {
                setSpawnMessage(`❌ Error clearing nodes: ${err.message}`);
            }
        }
    };

    const [provisionData, setProvisionData] = useState(null);

    // Handle spawning a new worker
    const handleSpawnWorker = async () => {
        setSpawnLoading(true);
        setSpawnMessage('');
        try {
            // Note: client.js must be updated to call /provision instead of /spawn
            const res = await spawnWorker();
            const { data } = res;
            if (data.success) {
                setProvisionData(data);
                // Fetch nodes again to show the pending node
                setTimeout(fetchNodes, 1000);
            } else {
                setSpawnMessage(`❌ Failed to provision: ${data.error}`);
            }
        } catch (err) {
            setSpawnMessage(`❌ Error: ${err.response?.data?.error || err.message}`);
        } finally {
            setSpawnLoading(false);
            // Clear message after 8 seconds
            setTimeout(() => setSpawnMessage(''), 8000);
        }
    };

    if (loading && nodes.length === 0) {
        return (
            <div style={{ textAlign: 'center', padding: 100 }}>
                <div className="spinner" style={{ width: 40, height: 40, margin: '0 auto 20px' }} />
                <p style={{ color: 'var(--text-secondary)' }}>Initializing cluster topology...</p>
            </div>
        );
    }

    return (
        <div style={{ animation: 'slide-up 0.5s ease-out' }}>
            {/* ── Page Header ─────────────────────────────────────────────────── */}
            <div className="page-header">
                <div>
                    <h1 className="page-title">Worker Nodes</h1>
                    <p className="page-subtitle">Real-time cluster topology and resource utilization</p>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button
                        className="btn btn-secondary"
                        onClick={handleClearAllNodes}
                        disabled={nodes.length === 0}
                        title="Remove all node records"
                    >
                        🗑 Clear All
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={handleSpawnWorker}
                        disabled={spawnLoading}
                        style={{ minWidth: 140 }}
                    >
                        {spawnLoading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : '+ Add Worker'}
                    </button>
                    <div className="live-indicator" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--accent-green)', fontWeight: 600, background: 'rgba(16, 185, 129, 0.1)', padding: '6px 12px', borderRadius: 100 }}>
                        <span className="badge-dot" style={{ animation: 'pulsar-green 2s infinite' }} />
                        LIVE CLUSTER
                    </div>
                </div>
            </div>

            {/* Provisioning Modal */}
            {provisionData && (
                <div className="modal-overlay" onClick={() => setProvisionData(null)}>
                    <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                            <h2 style={{ margin: 0 }}>🚀 Connect Remote Worker</h2>
                            <button className="btn btn-secondary btn-sm" onClick={() => setProvisionData(null)}>✕</button>
                        </div>
                        <p style={{ color: 'var(--text-secondary)' }}>
                            Run the following command on your remote server (AWS, DigitalOcean, etc.) to connect it to KUBEX:
                        </p>
                        <div style={{ background: '#111', padding: 16, borderRadius: 8, position: 'relative', marginTop: 16 }}>
                            <code style={{ color: 'var(--accent-cyan)', wordBreak: 'break-all', display: 'block', fontSize: 13, lineHeight: '1.5' }}>
                                {provisionData.installCommand}
                            </code>
                            <button 
                                className="btn btn-sm btn-primary" 
                                style={{ position: 'absolute', top: 12, right: 12 }}
                                onClick={() => {
                                    navigator.clipboard.writeText(provisionData.installCommand);
                                    alert('Copied to clipboard!');
                                }}
                            >
                                Copy
                            </button>
                        </div>
                        <div style={{ marginTop: 24, padding: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 8, fontSize: 13 }}>
                            <strong>API Token:</strong> <code style={{ color: 'var(--text-muted)' }}>{provisionData.token}</code><br/><br/>
                            This node will show as "Unknown" or "Pending" until the agent boots up and sends its first heartbeat.
                        </div>
                    </div>
                </div>
            )}

            {/* Status message from worker spawn */}
            {spawnMessage && (
                <div style={{
                    marginBottom: 24,
                    padding: 12,
                    borderRadius: 6,
                    backgroundColor: spawnMessage.includes('✅') ? '#1a4d2e' : '#8b0000',
                    color: '#fff',
                    fontSize: 13
                }}>
                    {spawnMessage}
                </div>
            )}

            {/* API Connection Error */}
            {error && !loading && (
                <div style={{ backgroundColor: 'var(--bg-card)', padding: 20, borderRadius: 8, color: 'var(--accent-red)', border: '1px solid var(--accent-red)', marginBottom: 24 }}>
                    <strong>Error:</strong> {error} <br/>
                    Is the API Server running? Try running <code>npm start</code> in the <code>control-plane/api-server</code> directory.
                </div>
            )}

            {/* Node Health Summary Row */}
            <div className="stats-grid" style={{ marginBottom: 40 }}>
                <div className="stat-card">
                    <div className="stat-label">Total Nodes</div>
                    <div className="stat-value">{nodes.length}</div>
                </div>
                <div className="stat-card" style={{ '--accent': 'var(--accent-green)' }}>
                    <div className="stat-label">Active (Ready)</div>
                    <div className="stat-value" style={{ color: 'var(--accent-green)' }}>
                        {nodes.filter(n => n.status === 'Ready').length}
                    </div>
                </div>
                <div className="stat-card" style={{ '--accent': 'var(--accent-red)' }}>
                    <div className="stat-label">Warning (NotReady)</div>
                    <div className="stat-value" style={{ color: 'var(--accent-red)' }}>
                        {nodes.filter(n => n.status !== 'Ready').length}
                    </div>
                </div>
            </div>

            {/* Empty state: shown when no workers have registered yet */}
            {nodes.length === 0 ? (
                <div className="empty-state" style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--glass-border)' }}>
                    <div className="empty-icon">🖥</div>
                    <h3>No nodes registered</h3>
                    <p>Start the worker-agent to register nodes with the cluster</p>
                </div>
            ) : (
                <div className="nodes-grid">
                    {nodes.map((node) => (
                        <NodeCard
                            key={node.nodeId}
                            node={node}
                            onClick={setSelectedNodeId}
                            onDelete={async (id) => {
                                if (window.confirm(`Are you sure you want to delete worker "${id}"?`)) {
                                    try {
                                        await deleteNode(id);
                                        fetchNodes();
                                    } catch (e) {
                                        alert('Failed to delete node: ' + e.message);
                                    }
                                }
                            }}
                        />
                    ))}
                </div>
            )}

            {/* Node Detail Modal */}
            {selectedNodeId && (
                <NodeDetailModal
                    nodeId={selectedNodeId}
                    onClose={() => setSelectedNodeId(null)}
                />
            )}
        </div>
    );
}
