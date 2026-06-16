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
const auth = require('../middleware/auth');

router.use(auth);

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
        const query = req.user.role === 'admin' ? {} : { owner: req.user._id };
        const nodes = await Node.find(query).sort({ nodeId: 1 });
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

// ─── POST /api/workers/provision ──────────────────────────────────────────────
// POST /api/workers/provision
// Provision a new remote worker node
router.post('/provision', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot provision workers.' });
    }
    try {
        const { type } = req.body; // 'local' or 'remote'
        const WorkerService = require('../services/WorkerService');
        const ownerId = req.user ? req.user._id : null;
        const { workerId, token } = await WorkerService.provisionWorker(ownerId, type || 'local');

        if (type === 'remote') {
            // Provide the installation script for AWS / remote servers
            // We use standard bash for remote linux servers
            const apiHost = req.headers.host.includes('localhost') 
                ? 'http://<YOUR_API_IP>:3001' // Placeholder for production
                : `http://${req.headers.host}`;
            
            const installCommand = `docker run -d --name kubex-${workerId} --restart unless-stopped -e NODE_ID=${workerId} -e NODE_ENV=cloud -e KUBEX_TOKEN=${token} -e API_SERVER_URL=${apiHost} -v /var/run/docker.sock:/var/run/docker.sock kubex-worker-agent:latest`;

            res.json({
                success: true,
                message: `Remote worker provisioned: ${workerId}`,
                workerId,
                token,
                installCommand,
                note: 'Run this command on your remote server to connect it.',
            });
        } else {
            res.json({
                success: true,
                message: `Worker automatically provisioned: ${workerId}`,
                workerId,
                token,
                note: 'The worker has been automatically started in the background.',
            });
        }
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
