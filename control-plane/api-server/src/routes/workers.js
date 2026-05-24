/**
 * @file routes/workers.js — REST API routes for managing Worker Agents.
 *
 * Endpoints:
 *   GET  /list       → list all running workers with their ports
 *   POST /spawn      → spawn a new worker process locally
 */
const router = require('express').Router();
const Node = require('../models/Node');
const { spawn } = require('child_process');
const path = require('path');

// Helper to get next available worker port starting from 4001
async function getNextWorkerPort() {
    const nodes = await Node.find();
    const usedPorts = nodes.map(n => {
        const match = n.address.match(/:(\d+)$/);
        return match ? parseInt(match[1]) : null;
    }).filter(p => p !== null && p >= 4001 && p <= 4999);

    let port = 4001;
    while (usedPorts.includes(port)) {
        port++;
    }
    return port;
}

// Helper to get next worker ID
async function getNextWorkerId() {
    const nodes = await Node.find();
    const workerIds = nodes
        .map(n => {
            const match = n.nodeId.match(/worker-(\d+)/);
            return match ? parseInt(match[1]) : 0;
        })
        .sort((a, b) => b - a);

    const nextId = (workerIds[0] || 0) + 1;
    const suffix = Math.random().toString(36).substring(2, 6);
    return `worker-${nextId}-${suffix}`;
}

// ─── GET /api/workers/list ────────────────────────────────────────────────────
router.get('/list', async (req, res) => {
    try {
        const nodes = await Node.find().sort({ nodeId: 1 });
        const workers = nodes.map(n => {
            const match = n.address.match(/:(\d+)$/);
            const port = match ? match[1] : 'unknown';
            return {
                nodeId: n.nodeId,
                address: n.address,
                port: port,
                status: n.status,
                cpuUsage: n.metrics?.cpuUsage || 0,
                memUsage: n.metrics?.memUsage || 0,
                containerCount: n.containers?.length || 0,
            };
        });
        res.json({ success: true, data: workers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/workers/spawn ──────────────────────────────────────────────────
// Spawn a new worker process locally
router.post('/spawn', async (req, res) => {
    try {
        const WorkerService = require('../services/WorkerService');
        const { workerId, port } = await WorkerService.spawnWorker();

        // Return immediately (worker will register with heartbeat)
        res.json({
            success: true,
            message: `Worker spawned: ${workerId}`,
            workerId,
            port,
            note: 'Worker will register with API server within 3 seconds',
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/workers/next-port – just return next available port ─────────────
router.get('/next-port', async (req, res) => {
    try {
        const port = await getNextWorkerPort();
        res.json({ success: true, nextPort: port });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
