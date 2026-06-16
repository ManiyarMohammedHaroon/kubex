/**
 * @file routes/cluster.js — Cluster-wide status and scheduler visibility.
 *
 * Mounted at /api/cluster (see index.js).
 *
 * Endpoints:
 *   GET /status    → aggregated snapshot of the whole cluster health
 *   GET /scheduler → live node scores used by the Scheduler to place containers
 *
 * These endpoints are read-only — they do not modify state.
 * The Dashboard page polls /status every few seconds to drive its charts.
 */
const router = require('express').Router();
const Deployment = require('../models/Deployment');
const Node = require('../models/Node');

const { getNodeScores } = require('../services/SchedulerService');
const auth = require('../middleware/auth');

// ─── GET /api/cluster/status ──────────────────────────────────────────────────
// Aggregates data from Deployments, Nodes, and the LoadBalancer into a single
// response object. The frontend Dashboard calls this endpoint on a polling loop
// to keep all panels up to date.
//
// Response object shape:
// {
//   deployments: { total, byStatus, totalDesiredPods, totalRunningPods },
//   nodes:       { total, ready, notReady },
//   cluster:     { avgCpuUsage, avgMemUsage, healthy },
//   loadBalancer: { [deploymentName]: { endpoints[], count } },
//   timestamp:   Date
// }
router.get('/status', auth, async (req, res) => {
    try {
        const query = req.user.role === 'viewer'
            ? { viewers: req.user._id }
            : (req.user.role === 'admin' ? {} : { owner: req.user._id });

        const nodeQuery = req.user.role === 'admin' ? {} : { owner: req.user._id };

        // Fetch scoped deployments and scoped nodes in parallel to minimize latency
        const [deployments, nodes] = await Promise.all([
            Deployment.find(query),
            Node.find(nodeQuery),
        ]);

        // ── Deployment aggregates ──────────────────────────────────────────
        const totalDesired = deployments.reduce((s, d) => s + d.desiredReplicas, 0);
        const totalActual = deployments.reduce((s, d) => s + d.actualReplicas, 0);

        // Group deployments by their current status (e.g. { Running: 3, Degraded: 1 })
        const depsByStatus = deployments.reduce((acc, d) => {
            acc[d.status] = (acc[d.status] || 0) + 1;
            return acc;
        }, {});

        // ── Node aggregates ────────────────────────────────────────────────
        const totalNodes = nodes.length;
        const readyNodes = nodes.filter((n) => n.status === 'Ready').length;
        const notReadyNodes = nodes.filter((n) => n.status === 'NotReady').length;

        // Average CPU and memory usage across all registered nodes
        const avgCPU = nodes.length > 0
            ? nodes.reduce((s, n) => s + n.metrics.cpuUsage, 0) / nodes.length
            : 0;
        const avgMem = nodes.length > 0
            ? nodes.reduce((s, n) => s + n.metrics.memUsage, 0) / nodes.length
            : 0;



        res.json({
            success: true,
            data: {
                deployments: {
                    total: deployments.length,
                    byStatus: depsByStatus,
                    totalDesiredPods: totalDesired,
                    totalRunningPods: totalActual,
                },
                nodes: {
                    total: totalNodes,
                    ready: readyNodes,
                    notReady: notReadyNodes,
                },
                cluster: {
                    avgCpuUsage: parseFloat(avgCPU.toFixed(2)),
                    avgMemUsage: parseFloat(avgMem.toFixed(2)),
                    healthy: readyNodes === totalNodes && totalActual === totalDesired,
                },

                timestamp: new Date(),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/cluster/scheduler ──────────────────────────────────────────────
// Returns each Ready node with its current scheduler score.
// Score formula: cpuUsage * 0.6 + memUsage * 0.4  (lower = better candidate)
// Useful for debugging why a container was placed on a particular node.
router.get('/scheduler', auth, async (req, res) => {
    try {
        const scores = await getNodeScores();
        res.json({ success: true, data: scores });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
