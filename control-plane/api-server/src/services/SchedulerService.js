/**
 * @file SchedulerService.js — Node selection for container placement.
 *
 * When the Reconciler needs to create a new container, it calls selectNode()
 * to find the best worker node to run it on.
 *
 * Scheduling strategy: Least-Loaded (Weighted Scoring)
 *   score = cpuUsage * 0.6 + memUsage * 0.4
 *   Lower score = lighter load = better candidate.
 *   CPU is weighted more heavily (0.6) because it tends to be the
 *   bottleneck in containerised workloads.
 *
 * Fallback rules:
 *   1. No Ready nodes at all → use "local" (control plane itself runs the container)
 *   2. All nodes have CPU > 95% or MEM > 95% → pick the least-worst node
 *      (better than refusing to schedule at all)
 */
const Node = require('../models/Node');

/**
 * Select the best available node for placing a new container.
 *
 * @returns {Promise<{nodeId: string, address: string|null}>}
 *   nodeId  — the chosen node's ID (e.g. "worker-1")
 *   address — the worker agent's HTTP address (null if using "local" fallback)
 */
async function selectNode() {
    const readyNodes = await Node.find({ status: 'Ready' });

    // Fallback: no worker nodes registered yet — throw error to keep deployment Pending
    if (readyNodes.length === 0) {
        throw new Error('No Ready nodes available for scheduling');
    }

    // ── Real-time Load Calculation ───────────────────────────────────────────
    // We don't just trust node.metrics.containerCount because it only updates 
    // every 3 seconds via heartbeat. To ensure perfect spreading during a 
    // fast scale-up, we calculate the "live" count by looking at all deployments.
    const Deployment = require('../models/Deployment');
    const allDeployments = await Deployment.find().lean();
    const liveCounts = {};
    allDeployments.forEach(dep => {
        dep.containers.forEach(c => {
            liveCounts[c.nodeId] = (liveCounts[c.nodeId] || 0) + 1;
        });
    });

    // Filter out overloaded nodes (CPU or MEM above 95%) then score the rest
    const scored = readyNodes
        .filter((n) => (n.metrics?.cpuUsage || 0) < 95 && (n.metrics?.memUsage || 0) < 95)
        .map((n) => {
            const currentContainers = liveCounts[n.nodeId] || 0;
            return {
                node: n,
                // Weighted score: 60% CPU, 40% memory, plus a heavy penalty for existing containers.
                // Penalty of 10.0 per container ensures we always fill empty workers first.
                score: ((n.metrics?.cpuUsage || 0) * 0.6) + 
                       ((n.metrics?.memUsage || 0) * 0.4) + 
                       (currentContainers * 10.0) + 
                       (Math.random() * 0.1),
            };
        })
        .sort((a, b) => a.score - b.score); // Ascending: best candidate first

    if (scored.length === 0) {
        // All nodes are maxed out — choose the "least worst" to avoid hard failure
        // Sort by total load (cpu + mem unweighted) and pick the lightest
        const fallback = readyNodes.sort(
            (a, b) =>
                ((a.metrics?.cpuUsage || 0) + (a.metrics?.memUsage || 0)) -
                ((b.metrics?.cpuUsage || 0) + (b.metrics?.memUsage || 0))
        )[0];
        return { nodeId: fallback.nodeId, address: fallback.address };
    }

    // Pick the node with the lowest score (lightest load)
    const best = scored[0].node;
    return { nodeId: best.nodeId, address: best.address };
}

/**
 * Return scheduler scores for all Ready nodes (used by GET /api/cluster/scheduler).
 * Useful for debugging placement decisions in the KUBEX dashboard.
 *
 * @returns {Promise<Array<{nodeId, cpuUsage, memUsage, containerCount, score}>>}
 *   Sorted by score ascending (best candidate first)
 */
async function getNodeScores() {
    const nodes = await Node.find({ status: 'Ready' });
    const Deployment = require('../models/Deployment');
    const allDeployments = await Deployment.find().lean();
    
    const liveCounts = {};
    allDeployments.forEach(dep => {
        dep.containers.forEach(c => {
            liveCounts[c.nodeId] = (liveCounts[c.nodeId] || 0) + 1;
        });
    });

    return nodes
        .map((n) => {
            const currentContainers = liveCounts[n.nodeId] || 0;
            return {
                nodeId: n.nodeId,
                cpuUsage: n.metrics?.cpuUsage || 0,
                memUsage: n.metrics?.memUsage || 0,
                containerCount: currentContainers,
                // Same formula used in selectNode() (minus the random jitter)
                score: ((n.metrics?.cpuUsage || 0) * 0.6) + 
                       ((n.metrics?.memUsage || 0) * 0.4) + 
                       (currentContainers * 10.0),
            };
        })
        .sort((a, b) => a.score - b.score); // Best first
}

module.exports = { selectNode, getNodeScores };
