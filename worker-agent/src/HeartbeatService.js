/**
 * @file HeartbeatService.js — Periodic heartbeat reporter for the worker agent.
 *
 * Every HEARTBEAT_INTERVAL_MS (default 3 s), this service sends a POST request
 * to the API server's /api/heartbeat endpoint with:
 *
 *   nodeId    — this worker's unique identifier (from NODE_ID env var)
 *   address   — this agent's HTTP address so the frontend can reach it directly
 *   metrics   — current CPU%, memory%, and whether they are simulated (chaos mode)
 *   containers — list of running KUBEX container IDs on this node
 *   capacity  — static CPU core count and total RAM reported to the Scheduler
 *
 * The API server uses these heartbeats to:
 *   - Keep the Node document up to date (upsert — creates node on first heartbeat)
 *   - Feed metrics to the AutoScaler and Scheduler
 *   - Detect node failures (FailureDetector marks nodes NotReady if heartbeats stop)
 *
 * A 3-second timeout is set on each request so that a slow/unresponsive API server
 * doesn't cause the heartbeat goroutine to pile up.
 */
const axios = require('axios');
const MetricsCollector = require('./MetricsCollector');
const ContainerRunner = require('./ContainerRunner');

// Read configuration from environment variables
const API_URL = process.env.API_SERVER_URL || 'http://localhost:3001';
const NODE_ID = process.env.NODE_ID || 'worker-1';
const AGENT_ADDRESS = process.env.AGENT_ADDRESS || 'http://localhost:4001'; // Reported to API server
const INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '3000');
const KUBEX_TOKEN = process.env.KUBEX_TOKEN || ''; // Secure token for registration

let heartbeatTimer = null;

/**
 * Collect current metrics and container list, then POST them to the API server.
 * Errors are caught and logged so a transient API outage doesn't crash the agent.
 */
async function sendHeartbeat() {
    try {
        // Gather fresh metrics from MetricsCollector (already updated every 2 s in background)
        const metrics = MetricsCollector.getMetrics();
        // List all running KUBEX containers on this node right now
        const containers = await ContainerRunner.listRunningContainerIds();

        const response = await axios.post(`${API_URL}/api/heartbeat`, {
            nodeId: NODE_ID,
            token: KUBEX_TOKEN,
            address: AGENT_ADDRESS,  // API server stores this so frontend Chaos buttons work
            metrics,
            containers,
            capacity: { cpu: 4, memory: 4096 }, // Static — reported once but stored in DB
            environment: process.env.NODE_ENV || 'local',
        }, { 
            timeout: 3000,
            headers: {
                Authorization: `Bearer ${KUBEX_TOKEN}`
            }
        }); // 3 s timeout prevents heartbeat queue pile-up

        // ─── Self-Healing Logic ──────────────────────────────────────────────
        // If the API server says "shutdown", it means this node is no longer 
        // in the control plane's database (likely deleted by the user).
        // We shut ourselves down to stop being a "zombie" process.
        if (response.data && response.data.command === 'shutdown') {
            console.log(`\n[Heartbeat] 🛑 Control plane instructed shutdown. Exiting...`);
            process.exit(0);
        }

        // Compact inline status line replaces itself on each tick (no newline spam in logs)
        process.stdout.write(
            `\r[Heartbeat] node=${NODE_ID} cpu=${metrics.cpuUsage}% mem=${metrics.memUsage}% containers=${containers.length}     `
        );
    } catch (err) {
        // A failed heartbeat is non-fatal — the agent keeps running
        // The FailureDetector will eventually notice and mark this node NotReady
        console.error(`\n[Heartbeat] Failed to reach API server: ${err.message}`);
    }
}

/**
 * Start the heartbeat loop.
 * Sends the first heartbeat immediately (synchronously registers the node),
 * then continues on the configured interval.
 */
function start() {
    console.log(`[HeartbeatService] Starting — reporting as "${NODE_ID}" every ${INTERVAL}ms`);
    sendHeartbeat(); // Send immediately so the node appears in the dashboard right away
    heartbeatTimer = setInterval(sendHeartbeat, INTERVAL);
}

/** Stop the heartbeat loop (cleanup for tests / graceful shutdown). */
function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
}

module.exports = { start, stop };
