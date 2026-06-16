/**
 * @file routes/nodes.js — REST API routes for Worker Nodes and Events.
 *
 * All routes are mounted at /api/nodes (see index.js).
 * The /api/heartbeat shortcut in index.js also points here.
 *
 * Endpoints:
 *   GET  /                → list all registered worker nodes  [auth required]
 *   GET  /:nodeId         → get a single node + its container details  [auth required, scoped]
 *   GET  /:nodeId/logs    → get worker agent logs  [auth required]
 *   POST /heartbeat       → worker agent registration / heartbeat  [NO auth — daemon process]
 *   GET  /events/list     → fetch the last 100 cluster events scoped to user  [auth required]
 *   DELETE /:nodeId       → remove a node from the database  [auth required, developer+ only]
 */
const router = require('express').Router();
const Node = require('../models/Node');
const Event = require('../models/Event');
const Deployment = require('../models/Deployment');
const auth = require('../middleware/auth');

// ─── Helper: Build tenant-scoped deployment query ─────────────────────────────
// Developer sees their own deployments, Viewer sees deployments they're assigned to.
const buildDeploymentQuery = (user) => {
    return user.role === 'viewer'
        ? { viewers: user._id }
        : { owner: user._id };
};

// ─── GET /api/nodes ───────────────────────────────────────────────────────────
// Returns all registered worker nodes sorted alphabetically by nodeId.
// Used by the frontend Nodes page and Dashboard node-health panel.
// Nodes themselves are cluster infrastructure and visible to all authenticated users.
router.get('/', auth, async (req, res) => {
    try {
        const query = req.user.role === 'admin' ? {} : { owner: req.user._id };
        const nodes = await Node.find(query).sort({ nodeId: 1 });
        res.json({ success: true, data: nodes });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/nodes/events/list ──────────────────────────────────────────────
// Returns the 100 most recent cluster events scoped to the authenticated user:
//   - System, Node, and non-Deployment events are always shown (cluster-wide infra events)
//   - Deployment/Container events are filtered to only include those belonging
//     to the current user's authorized deployments
//
// Bug 9 fix: this route MUST be declared BEFORE GET /:nodeId.
// Express matches routes in declaration order; if /:nodeId came first,
// "events" would be captured as a nodeId parameter and return 404 "Node not found".
router.get('/events/list', auth, async (req, res) => {
    try {
        // Get the names of all deployments this user is authorized to see
        const userDeployments = await Deployment.find(buildDeploymentQuery(req.user)).select('name');
        const userDeploymentNames = userDeployments.map(d => d.name);

        // Query events: always include Node/System/null-kind events,
        // and only include Deployment/Container events for the user's own deployments
        const events = await Event.find({
            $or: [
                { 'involvedObject.kind': { $in: ['Node', 'System'] } },
                { 'involvedObject.kind': { $exists: false } },
                { 'involvedObject.kind': null },
                {
                    'involvedObject.kind': { $in: ['Deployment', 'Container'] },
                    'involvedObject.name': { $in: userDeploymentNames }
                }
            ]
        }).sort({ createdAt: -1 }).limit(100);

        res.json({ success: true, data: events });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/nodes/:nodeId ───────────────────────────────────────────────────
// Returns a single node document PLUS an enriched list of containers currently
// running on that node — SCOPED to only containers the authenticated user owns.
//
// The enriched list is built by cross-referencing all Deployment documents
// owned by the current user that have containers on this node.
router.get('/:nodeId', auth, async (req, res) => {
    try {
        const query = req.user.role === 'admin' ? { nodeId: req.params.nodeId } : { nodeId: req.params.nodeId, owner: req.user._id };
        const node = await Node.findOne(query);
        if (!node) return res.status(404).json({ success: false, error: 'Node not found' });

        // Look up only the current user's deployments that have containers on this node
        const deployments = await Deployment.find({
            ...buildDeploymentQuery(req.user),
            'containers.nodeId': req.params.nodeId
        });

        // Flatten deployment containers down to just those on this node,
        // attaching useful metadata (name, image) from the parent deployment
        const nodeContainers = [];
        deployments.forEach(dep => {
            dep.containers.forEach(c => {
                if (c.nodeId === req.params.nodeId) {
                    nodeContainers.push({
                        deploymentName: dep.name,
                        image: dep.image,
                        containerId: c.containerId,
                        status: c.status,
                        ip: c.ip,
                        hostPort: c.hostPort,
                        startedAt: c.startedAt
                    });
                }
            });
        });

        res.json({
            success: true,
            data: {
                ...node.toObject(),
                detailedContainers: nodeContainers // Extra field: only user-owned containers
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/nodes/:nodeId/tasks ─────────────────────────────────────────────
// Called by the worker agent every few seconds to pull its desired state.
// This implements the "Pull" architecture for KUBEX.
router.get('/:nodeId/tasks', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();
        const existingNode = await Node.findOne({ nodeId: req.params.nodeId });
        
        if (!existingNode || existingNode.token !== token) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        // Return all deployments that need to be run, built, or stopped.
        // For local auto-tunneling, we assume 1 worker node, so we just return ALL deployments.
        // The worker will reconcile them locally.
        const deployments = await Deployment.find({ status: { $ne: 'Terminating' } }).populate('owner', 'dockerHubUsername dockerHubToken');
        
        // Filter the tasks by overriding desiredReplicas with this node's specific quota.
        // If there's no quota yet (Scheduler hasn't run), default to 0 to prevent over-scaling.
        const tasks = deployments.map(dep => {
            const assignedCount = dep.nodeAssignments?.get(req.params.nodeId) || 0;
            const obj = dep.toObject();
            return {
                ...obj,
                desiredReplicas: assignedCount,
                dockerHubUsername: dep.owner?.dockerHubUsername || dep.dockerHubUsername || '',
                dockerHubToken: dep.owner?.dockerHubToken || ''
            };
        });

        res.json({ success: true, data: tasks });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ─── POST /api/heartbeat (/api/nodes/heartbeat) ───────────────────────────────
// Called by every worker agent every HEARTBEAT_INTERVAL_MS (default 3 seconds).
//
// ⚠️  NO AUTH on this route — worker agents are background daemon processes
//    that do not carry user JWT credentials. Security is handled at the
//    network/cluster level.
//
// This endpoint does three things at once:
//   1. Auto-registers the node if it doesn't exist yet (upsert)
//   2. Updates the node's status to "Ready" (proving it's alive)
//   3. Updates live metrics (CPU%, MEM%, container count) for the Scheduler and AutoScaler
//
// Required body: { nodeId, address }
// Optional body: { metrics, containers, capacity }
router.post('/heartbeat', async (req, res) => {
    try {
        const { nodeId, address, metrics, containers, capacity, environment } = req.body;
        if (!nodeId || !address) {
            return res.status(400).json({ success: false, error: 'nodeId and address required' });
        }

        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();

        if (!token) {
            return res.status(401).json({ success: false, error: 'Unauthorized: KUBEX_TOKEN required' });
        }

        // Upsert the node: if it doesn't exist, create it with this token.
        // If it exists, the token MUST match or we reject it.
        const existingNode = await Node.findOne({ nodeId });
        
        if (existingNode && existingNode.token !== token) {
            return res.status(403).json({ success: false, error: 'Forbidden: Invalid KUBEX_TOKEN for this node' });
        }

        // Inject the container count into the metrics object so the frontend UI can display it
        if (metrics && containers) {
            metrics.containerCount = containers.length;
        }

        // Update the node's status to Ready, record live metrics, and set the token
        const node = await Node.findOneAndUpdate(
            { nodeId },
            {
                $set: {
                    address,
                    status: 'Ready',
                    lastHeartbeat: new Date(),
                    metrics: metrics || {},
                    containers: containers || [],
                    capacity: capacity || { cpu: 2, memory: 2048 },
                    token: token,
                    environment: environment || 'local'
                }
            },
            { new: true, upsert: true }
        );

        res.json({ success: true, data: node });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/nodes/:nodeId/logs ─────────────────────────────────────────────
// Fetches the worker agent's OWN internal logs (not container logs).
// This proxies the request to the worker's /logs endpoint.
router.get('/:nodeId/logs', auth, async (req, res) => {
    try {
        const node = await Node.findOne({ nodeId: req.params.nodeId });
        if (!node || !node.address) {
            return res.status(404).json({ success: false, error: 'Node not found or unreachable' });
        }

        const response = await fetch(`${node.address}/logs`, { 
            signal: AbortSignal.timeout(2000) 
        });
        const data = await response.json();
        
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch agent logs: ' + err.message });
    }
});

// ─── DELETE /api/nodes/:nodeId ────────────────────────────────────────────────
// Manually remove a node from the database.
//
// NOTE: This does not "kill" the worker agent process. If the agent is still
// alive and sending heartbeats, it will automatically reappear in the dashboard
// within 3 seconds. This is primarily used to clean up "NotReady" nodes that
// are gone for good.
//
// Only developers (not viewers) may delete nodes.
router.delete('/:nodeId', auth, async (req, res) => {
    try {
        // Viewers are read-only — block all delete operations
        if (req.user.role === 'viewer') {
            return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot delete nodes.' });
        }

        const query = req.user.role === 'admin' ? { nodeId: req.params.nodeId } : { nodeId: req.params.nodeId, owner: req.user._id };
        const result = await Node.findOneAndDelete(query);
        if (!result) {
            return res.status(404).json({ success: false, error: 'Node not found' });
        }
        
        // Try to shut down the worker process
        if (result.address || result.pid) {
            try {
                console.log(`[Nodes] Attempting to shut down worker ${req.params.nodeId}...`);
                
                // 1. Try graceful HTTP shutdown
                if (result.address) {
                    await fetch(`${result.address}/commands/shutdown`, { 
                        method: 'POST',
                        signal: AbortSignal.timeout(1000) 
                    }).catch(() => {}); // Ignore fetch errors
                }

                // 2. Forceful fallback: If we have a PID, kill the process directly
                // (Crucial for local dev where workers are spawned by this same server)
                if (result.pid) {
                    try {
                        process.kill(result.pid, 'SIGKILL');
                        console.log(`[Nodes] Killed process ${result.pid} for node ${req.params.nodeId}`);
                    } catch (e) {
                        // PID might already be gone (graceful exit worked)
                    }
                }
            } catch (err) {
                console.error(`[Nodes] Shutdown failed for ${req.params.nodeId}:`, err.message);
            }
        }
        
        res.json({ success: true, message: `Node ${req.params.nodeId} deleted and agent shut down` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
