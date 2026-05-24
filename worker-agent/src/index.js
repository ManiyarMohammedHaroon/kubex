/**
 * @file index.js — KUBEX Worker Agent entry point.
 *
 * Each worker agent is a lightweight Node.js process that:
 *   1. Sends periodic heartbeats to the API server to prove it's alive
 *      (HeartbeatService) along with real CPU/memory metrics
 *   2. Exposes a small REST API for the control plane and frontend to interact with:
 *      - Stop a specific container
 *      - List running containers on this node
 *      - Trigger chaos scenarios (CPU spike, random container kill)
 *
 * Multiple instances of this process run simultaneously (one per "node").
 * Each instance is identified by its NODE_ID environment variable.
 *
 * Environment variables:
 *   NODE_ID          — unique name for this worker (e.g. "worker-1")
 *   AGENT_PORT       — port this agent listens on (default 4001)
 *   API_SERVER_URL   — URL of the KUBEX API server (default http://localhost:3001)
 *   AGENT_ADDRESS    — this agent's publicly reachable URL (sent in heartbeats)
 *   DOCKER_HOST      — (optional) TCP address of Docker daemon; defaults to named pipe / socket
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const HeartbeatService = require('./HeartbeatService');
const ContainerRunner = require('./ContainerRunner');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.AGENT_PORT || 4001;

// ─── Internal Log Buffer ──────────────────────────────────────────────────
// Capture console.log/error to a small in-memory buffer so the control plane
// can fetch and display agent logs in the UI.
const agentLogs = [];
const originalLog = console.log;
const originalError = console.error;

const capture = (type, args) => {
    const msg = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
    agentLogs.push(msg);
    if (agentLogs.length > 200) agentLogs.shift(); // Keep last 200 lines
};

console.log = (...args) => { originalLog(...args); capture('INFO', args); };
console.error = (...args) => { originalError(...args); capture('ERROR', args); };

// ─── Health Check ─────────────────────────────────────────────────────────────
// Simple liveness probe for Docker healthcheck or external monitoring.
// Returns the node ID and current timestamp.
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', nodeId: process.env.NODE_ID, ts: new Date() });
});

// ─── Agent Logs ──────────────────────────────────────────────────────────────
app.get('/logs', (_req, res) => {
    res.json({ success: true, data: agentLogs });
});

// ─── Container Commands ───────────────────────────────────────────────────────

// POST /commands/stop — stop and remove a specific container on this node.
// Used by the control plane when it wants to forcibly remove a container
// (e.g. during scale-down or deployment deletion).
// Body: { containerId: string }
app.post('/commands/stop', async (req, res) => {
    const { containerId } = req.body;
    if (!containerId) return res.status(400).json({ error: 'containerId required' });
    try {
        await ContainerRunner.stopContainer(containerId);
        res.json({ success: true, message: `Container ${containerId} stopped` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /containers — list IDs of all KUBEX-managed containers currently running on this node.
// Used by the heartbeat to report live container count to the API server.
app.get('/containers', async (_req, res) => {
    try {
        const ids = await ContainerRunner.listRunningContainerIds();
        res.json({ success: true, data: ids });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /logs/:containerId — fetch the last N log lines for a specific container.
// Used by the control plane API server to aggregate logs from across the cluster.
app.get('/logs/:containerId', async (req, res) => {
    const { containerId } = req.params;
    const tail = parseInt(req.query.tail || '100');
    try {
        const logs = await ContainerRunner.getContainerLogs(containerId, tail);
        res.json({ success: true, data: logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Chaos Engineering Endpoints ─────────────────────────────────────────────
// These endpoints simulate failure scenarios so you can test that the
// AutoScaler, FailureDetector, and Reconciler respond correctly.

// POST /chaos/stress — temporarily push reported CPU/memory metrics to high values.
// The MetricsCollector's override mechanism replaces real metrics for `duration` ms.
// This triggers the AutoScaler to scale up the deployment running on this node.
// Body: { cpu?: number (%), mem?: number (%), duration?: number (ms) }
app.post('/chaos/stress', (req, res) => {
    const { cpu, mem, duration } = req.body;
    const MetricsCollector = require('./MetricsCollector');
    // Default: spike CPU to 90%, memory to 80% for 30 seconds
    MetricsCollector.setOverride(cpu || 90, mem || 80, duration || 30000);
    res.json({ success: true, message: `CPU spike to ${cpu || 90}% triggered for ${duration || 30000}ms` });
});

// POST /chaos/kill — randomly stop one running KUBEX container on this node.
// Simulates a container crash to test the Reconciler's self-healing behaviour.
// The Reconciler should detect the crash within RECONCILER_INTERVAL_MS and recreate it.
app.post('/chaos/kill', async (_req, res) => {
    try {
        const ids = await ContainerRunner.listRunningContainerIds();
        if (ids.length === 0) return res.status(404).json({ error: 'No running containers to kill' });

        // Pick a random container from the list
        const randomId = ids[Math.floor(Math.random() * ids.length)];
        await ContainerRunner.stopContainer(randomId);
        res.json({ success: true, message: `Chaos monkey killed container ${randomId.slice(0, 12)}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /commands/shutdown — forcefully kill the worker agent process.
// Called by the control plane when the user deletes a node from the UI.
app.post('/commands/shutdown', (_req, res) => {
    console.log(`[Worker] Received shutdown command. Exiting...`);
    res.json({ success: true, message: 'Shutting down' });
    setTimeout(() => process.exit(0), 100);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🔧 KUBEX Worker Agent "${process.env.NODE_ID}" running on port ${PORT}`);
    console.log(`   API Server: ${process.env.API_SERVER_URL}`);
    console.log('──────────────────────────────────────────────');
});

// Start sending heartbeats to the API server immediately after the HTTP server is up
HeartbeatService.start();
