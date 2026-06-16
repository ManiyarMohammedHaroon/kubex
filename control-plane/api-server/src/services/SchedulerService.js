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

let schedulerTimer = null;

/**
 * Periodically distributes desiredReplicas evenly across all Ready nodes.
 * Saves the quotas into Deployment.nodeAssignments for the worker agents to pull.
 */
async function scheduleAll() {
    try {
        const readyNodes = await Node.find({ status: 'Ready' }).sort({ createdAt: 1 });
        if (readyNodes.length === 0) return; // No workers to assign to

        const Deployment = require('../models/Deployment');
        const deployments = await Deployment.find({ status: { $ne: 'Terminating' } });
        
        for (const dep of deployments) {
            const assignments = {};
            
            // Filter nodes by the deployment's requested environment
            const eligibleNodes = readyNodes.filter(n => n.environment === dep.environment);
            
            eligibleNodes.forEach(n => assignments[n.nodeId] = 0);
            
            let assignedCount = 0;
            let nodeIdx = 0;
            
            // Distribute replicas evenly (round-robin) across eligible nodes
            if (eligibleNodes.length > 0) {
                while (assignedCount < dep.desiredReplicas) {
                    const n = eligibleNodes[nodeIdx % eligibleNodes.length];
                    assignments[n.nodeId]++;
                    assignedCount++;
                    nodeIdx++;
                }
            }
            
            // Check if assignments changed to avoid unnecessary DB writes
            let changed = false;
            for (const [nodeId, count] of Object.entries(assignments)) {
                if (dep.nodeAssignments.get(nodeId) !== count) {
                    changed = true;
                    break;
                }
            }
            for (const key of dep.nodeAssignments.keys()) {
                if (assignments[key] === undefined) {
                    changed = true; // A node was removed from assignments
                    break;
                }
            }
            
            if (changed) {
                // Use Mongoose Map methods to ensure changes are tracked and saved
                for (const key of dep.nodeAssignments.keys()) {
                    if (assignments[key] === undefined) {
                        dep.nodeAssignments.delete(key);
                    }
                }
                for (const [nodeId, count] of Object.entries(assignments)) {
                    dep.nodeAssignments.set(nodeId, count);
                }
                
                await dep.save();
                console.log(`[Scheduler] Updated assignments for ${dep.name}:`, assignments);
            }
        }
    } catch (e) {
        console.error('[Scheduler] Error in scheduleAll loop:', e.message);
    }
}

/**
 * Start the scheduler loop.
 */
function start() {
    console.log('[Scheduler] Starting background loop');
    schedulerTimer = setInterval(scheduleAll, 5000);
}

/**
 * Stop the scheduler loop.
 */
function stop() {
    if (schedulerTimer) clearInterval(schedulerTimer);
}

/**


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

module.exports = { start, stop, getNodeScores };
