/**
 * @file pages/Dashboard.jsx — Real-time cluster overview page.
 *
 * Polls three API endpoints every 3 seconds via a shared fetchAll() loop:
 *   - GET /cluster/status  → deployment and node aggregates + avg CPU/MEM
 *   - GET /nodes           → individual node list (for future node panel)
 *   - GET /events          → last 20 events for the activity feed
 *
 * Maintains a rolling cpuHistory array (max 20 points) to drive the area charts.
 *
 * Sub-components:
 *   StatCard      — a small metric tile with label, value, and optional sub-text
 *   ClusterHealth — SVG ring chart showing avg CPU% and healthy/degraded state
 *   EventFeed     — chronological list of recent cluster events
 */
import { useEffect, useState, useCallback } from 'react';
import { getClusterStatus, getNodes, getEvents, spawnWorker } from '../api/client';
import {
    AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * StatCard — displays a single key metric with an optional accent colour bar on top.
 *
 * @param {string}  label   Short title for the metric (e.g. "Total Nodes")
 * @param {*}       value   Main value to display prominently
 * @param {string}  [sub]   Secondary line (e.g. "3 Ready · 1 NotReady")
 * @param {string}  [accent] CSS colour for the top accent bar
 */
function StatCard({ label, value, sub, accent }) {
    return (
        <div className="stat-card" style={accent ? { '--accent': accent } : {}}>
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
            {sub && <div className="stat-sub">{sub}</div>}
        </div>
    );
}

/**
 * ClusterHealth — SVG ring chart summarising cluster health at a glance.
 * The ring fill percentage corresponds to avgCpuUsage (0–100%).
 * Ring colour is green when healthy, red when degraded.
 *
 * @param {boolean} healthy   True if all nodes are Ready AND all desired pods are running
 * @param {number}  cpuUsage  Average CPU% across all nodes
 * @param {number}  memUsage  Average memory% across all nodes (shown in sub-text)
 */
function ClusterHealth({ healthy, cpuUsage, memUsage }) {
    const ring = 2 * Math.PI * 48;
    const cpuDash = ring * (cpuUsage / 100);
    const innerRing = 2 * Math.PI * 38;
    const memDash = innerRing * (memUsage / 100);

    return (
        <div className="card cluster-hud crystal" style={{ 
            display: 'flex', alignItems: 'center', gap: 28, gridColumn: 'span 2',
            background: 'rgba(255, 255, 255, 0.7)',
            backdropFilter: 'blur(10px)',
            border: healthy ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)',
            position: 'relative', overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.05)'
        }}>
            {/* Pulsing Aura Background */}
            <div className={`hud-aura ${healthy ? 'aura-green' : 'aura-red'}`} style={{ opacity: 0.1 }} />

            <div style={{ position: 'relative', flexShrink: 0, width: 120, height: 120 }}>
                <svg width={120} height={120} style={{ transform: 'rotate(-90deg)', position: 'absolute', zIndex: 2 }}>
                    {/* CPU Outer Ring */}
                    <circle cx={60} cy={60} r={48} fill="none" stroke="rgba(0,0,0,0.03)" strokeWidth={6} />
                    <circle cx={60} cy={60} r={48} fill="none"
                        stroke={healthy ? 'var(--accent-green)' : 'var(--accent-red)'}
                        strokeWidth={6} strokeDasharray={`${cpuDash} ${ring}`}
                        strokeLinecap="round" style={{ transition: 'all 1s ease' }}
                    />
                    
                    {/* MEM Inner Ring */}
                    <circle cx={60} cy={60} r={38} fill="none" stroke="rgba(0,0,0,0.03)" strokeWidth={4} />
                    <circle cx={60} cy={60} r={38} fill="none"
                        stroke="var(--accent-blue)"
                        strokeWidth={4} strokeDasharray={`${memDash} ${innerRing}`}
                        strokeLinecap="round" style={{ transition: 'all 1.2s ease', opacity: 0.6 }}
                    />
                </svg>
                
                <div className="hud-center-text" style={{ color: 'var(--text-primary)' }}>
                    <span style={{ fontSize: 22, fontWeight: 800 }}>{cpuUsage.toFixed(0)}</span>
                    <span style={{ fontSize: 10, opacity: 0.6, marginTop: -4 }}>CPU %</span>
                </div>
            </div>

            <div style={{ zIndex: 2 }}>
                <div className="hud-status-badge" style={{ 
                    background: healthy ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)', 
                    color: healthy ? 'var(--accent-green)' : 'var(--accent-red)',
                    border: `1px solid ${healthy ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}`
                }}>
                    <div className={`status-dot ${healthy ? 'dot-green' : 'dot-red'}`} />
                    {healthy ? 'SYSTEM OPERATIONAL' : 'CLUSTER DEGRADED'}
                </div>
                
                <h3 style={{ margin: '8px 0 4px 0', fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>
                    {healthy ? 'Cluster Stable' : 'Action Required'}
                </h3>

                <div style={{ display: 'flex', gap: 16 }}>
                    <div className="hud-mini-stat light">
                        <label>AVG CPU</label>
                        <span style={{ color: 'var(--text-primary)' }}>{cpuUsage.toFixed(1)}%</span>
                    </div>
                    <div className="hud-mini-stat light" style={{ borderLeft: '1px solid rgba(0,0,0,0.05)', paddingLeft: 16 }}>
                        <label>AVG RAM</label>
                        <span style={{ color: 'var(--text-primary)' }}>{memUsage.toFixed(1)}%</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * EventFeed — shows the most recent cluster events from GET /nodes/events/list.
 * Events are colour-coded: green (Normal), yellow (Warning), red (Error).
 *
 * @param {Array} events  Array of event objects from the API
 */
function EventFeed({ events }) {
    // Map event type to badge dot colour
    const typeColor = { Normal: '#10b981', Warning: '#f59e0b', Error: '#ef4444' };
    return (
        <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-header">
                <span className="card-title">Recent Events</span>
                <span className="badge badge-blue">{events.length}</span>
            </div>
            <div className="events-list">
                {events.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                        No events yet
                    </div>
                )}
                {events.map((ev, i) => (
                    <div key={i} className="event-item">
                        {/* Coloured dot indicates event severity */}
                        <div
                            className="event-dot"
                            style={{ background: typeColor[ev.type] || '#94a3b8' }}
                        />
                        <div style={{ flex: 1 }}>
                            <div className="event-reason">{ev.reason}</div>
                            <div className="event-message">{ev.message}</div>
                        </div>
                        <div className="event-time">
                            {new Date(ev.createdAt).toLocaleTimeString()}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Main Page Component ──────────────────────────────────────────────────────

export default function Dashboard() {
    const [status, setStatus] = useState(null);         // Cluster status snapshot
    const [nodes, setNodes] = useState([]);           // Full node list (unused in UI but fetched for future use)
    const [events, setEvents] = useState([]);           // Last 20 cluster events
    const [cpuHistory, setCpuHistory] = useState([]);           // Rolling 20-point history for area charts
    const [loading, setLoading] = useState(true);         // Show spinner until first fetch completes
    const [error, setError] = useState(null);
    const [spawnLoading, setSpawnLoading] = useState(false);
    const [spawnMessage, setSpawnMessage] = useState('');

    /**
     * Fetch all three endpoints in parallel.
     * Promise.allSettled ensures one failing endpoint doesn't block the others.
     * cpuHistory is capped at 20 data points to keep the chart readable.
     */
    const fetchAll = useCallback(async () => {
        try {
            const [sRes, nRes, eRes] = await Promise.allSettled([
                getClusterStatus(),
                getNodes(),
                getEvents(),
            ]);
            
            // Check if all failed, which usually means the backend is completely offline
            if (sRes.status === 'rejected' && nRes.status === 'rejected' && eRes.status === 'rejected') {
                throw new Error("Failed to connect to API Server.");
            }

            if (sRes.status === 'fulfilled') {
                const d = sRes.value.data.data;
                setStatus(d);
                // Append current metrics to rolling history; keep only last 20 points
                setCpuHistory((prev) => {
                    const next = [...prev, {
                        t: new Date().toLocaleTimeString(),
                        cpu: parseFloat(d.cluster.avgCpuUsage),
                        mem: parseFloat(d.cluster.avgMemUsage),
                    }].slice(-20);
                    return next;
                });
            }
            if (nRes.status === 'fulfilled') setNodes(nRes.value.data.data);
            // Only show the most recent 20 events in the feed
            if (eRes.status === 'fulfilled') setEvents(eRes.value.data.data.slice(0, 20));
            
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false); // Remove spinner after first fetch (even on error)
        }
    }, []);

    // Start polling on mount; cancel the interval on unmount to avoid memory leaks
    useEffect(() => {
        fetchAll();
        const timer = setInterval(fetchAll, 3000); // Refresh every 3 seconds
        return () => clearInterval(timer);
    }, [fetchAll]);

    const handleSpawnWorker = async () => {
        setSpawnLoading(true);
        setSpawnMessage('');
        try {
            const res = await spawnWorker();
            const { data } = res;
            if (data.success) {
                setSpawnMessage(`✅ Worker "${data.workerId}" spawned on port ${data.port}!`);
                setTimeout(fetchAll, 3000);
            } else {
                setSpawnMessage(`❌ Failed to spawn: ${data.error}`);
            }
        } catch (err) {
            setSpawnMessage(`❌ Error: ${err.response?.data?.error || err.message}`);
        } finally {
            setSpawnLoading(false);
            setTimeout(() => setSpawnMessage(''), 8000);
        }
    };

    // Show a loading spinner until the first data arrives
    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12 }}>
                <div className="spinner" />
                <span style={{ color: 'var(--text-secondary)' }}>Connecting to cluster…</span>
            </div>
        );
    }

    // Safely destructure with defaults so the UI doesn't crash if any field is missing
    const deployData = status?.deployments || {};
    const nodeData = status?.nodes || {};
    const clusterData = status?.cluster || { avgCpuUsage: 0, avgMemUsage: 0 };

    return (
        <div>
            {/* ── Page Header ─────────────────────────────────────────────────── */}
            <div className="page-header">
                <div>
                    <div className="page-title">Cluster Dashboard</div>
                    <div className="page-subtitle">Real-time overview of all nodes, pods, and deployments</div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleSpawnWorker}
                        disabled={spawnLoading}
                        style={{ minWidth: 140 }}
                    >
                        {spawnLoading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Add Worker'}
                    </button>
                    <div className="live-indicator" style={{ color: error ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                        <div className="live-dot" style={{ backgroundColor: error ? 'var(--accent-red)' : 'var(--accent-green)' }} />
                        {error ? 'Disconnected' : 'Live · updates every 3s'}
                    </div>
                </div>
            </div>

            {/* Status message from worker spawn */}
            {spawnMessage && (
                <div style={{
                    marginBottom: 24,
                    padding: '10px 16px',
                    borderRadius: 8,
                    backgroundColor: spawnMessage.includes('✅') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                    border: `1px solid ${spawnMessage.includes('✅') ? 'var(--accent-green)' : 'var(--accent-red)'}`,
                    color: '#fff',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    animation: 'fade-in 0.3s ease-out'
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

            {/* ── Stat Cards Row ───────────────────────────────────────────────── */}
            {/* ClusterHealth spans 2 columns to give it more space */}
            <div className="stats-grid">
                <ClusterHealth
                    healthy={clusterData.healthy}
                    cpuUsage={clusterData.avgCpuUsage}
                    memUsage={clusterData.avgMemUsage}
                />
                <StatCard label="Total Nodes" value={nodeData.total ?? 0} sub={`${nodeData.ready ?? 0} Ready · ${nodeData.notReady ?? 0} NotReady`} />
                <StatCard label="Deployments" value={deployData.total ?? 0} sub={Object.entries(deployData.byStatus || {}).map(([k, v]) => `${v} ${k}`).join(' · ')} />
                <StatCard label="Desired Pods" value={deployData.totalDesiredPods ?? 0} sub="Total replicas requested" />
                <StatCard label="Running Pods" value={deployData.totalRunningPods ?? 0} sub="Actual running containers" />
            </div>

            {/* ── Area Charts (CPU and Memory History) ─────────────────────────── */}
            <div className="chart-grid">
                {/* CPU History Chart */}
                <div className="card">
                    <div className="card-header">
                        <span className="card-title">Avg CPU Usage</span>
                        <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent-blue)' }}>
                            {clusterData.avgCpuUsage.toFixed(1)}%
                        </span>
                    </div>
                    <ResponsiveContainer width="100%" height={100}>
                        <AreaChart data={cpuHistory} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                            <defs>
                                {/* Gradient fill that fades to transparent at the bottom */}
                                <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                            <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#475569' }} interval="preserveStartEnd" />
                            <YAxis tick={{ fontSize: 10, fill: '#475569' }} domain={[0, 100]} />
                            <Tooltip
                                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}
                                labelStyle={{ color: 'var(--text-secondary)' }}
                            />
                            <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fill="url(#cpuGrad)" strokeWidth={2} dot={false} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>

                {/* Memory History Chart — same structure as CPU, different dataKey and colour */}
                <div className="card">
                    <div className="card-header">
                        <span className="card-title">Avg Memory Usage</span>
                        <span style={{ fontSize: 20, fontWeight: 700, color: '#8b5cf6' }}>
                            {clusterData.avgMemUsage.toFixed(1)}%
                        </span>
                    </div>
                    <ResponsiveContainer width="100%" height={100}>
                        <AreaChart data={cpuHistory} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                            <defs>
                                <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                            <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#475569' }} interval="preserveStartEnd" />
                            <YAxis tick={{ fontSize: 10, fill: '#475569' }} domain={[0, 100]} />
                            <Tooltip
                                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8 }}
                                labelStyle={{ color: 'var(--text-secondary)' }}
                            />
                            <Area type="monotone" dataKey="mem" stroke="#8b5cf6" fill="url(#memGrad)" strokeWidth={2} dot={false} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* ── Event Feed ───────────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24, marginTop: 24 }}>
                <EventFeed events={events} />
                
                {/* ── Load Balancer Pools ────────────────────────────────────────── */}
                <div className="card" style={{ gridColumn: 'span 2' }}>
                    <div className="card-header">
                        <span className="card-title">Load Balancer Pools</span>
                        <span className="badge badge-green">{Object.keys(status?.loadBalancer || {}).length} Active</span>
                    </div>
                    <div className="lb-pools">
                        {Object.entries(status?.loadBalancer || {}).length === 0 && (
                            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                                No active pools
                            </div>
                        )}
                        {Object.entries(status?.loadBalancer || {}).map(([name, pool]) => (
                            <div key={name} style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--glass-border)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
                                    <strong style={{ fontSize: 14 }}>{name}</strong>
                                    <span className="badge badge-blue" style={{ fontSize: 10 }}>{pool.count} endpoints</span>
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {pool.endpoints.map((ip, i) => (
                                        <div key={i} style={{ 
                                            fontSize: 10, 
                                            padding: '4px 8px', 
                                            background: 'rgba(255,255,255,0.05)', 
                                            borderRadius: 4, 
                                            fontFamily: 'monospace' 
                                        }}>
                                            {ip}:{pool.hostPorts[i]}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
