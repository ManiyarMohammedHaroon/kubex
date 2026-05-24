/**
 * @file FailureDetector.js — Node health monitoring and container rescheduling.
 *
 * Runs every 5 seconds and handles two failure scenarios:
 *
 * 1. NODE FAILURE (missed heartbeat)
 *    If a node's lastHeartbeat is older than HEARTBEAT_TIMEOUT_MS (default 15 s),
 *    it means the worker agent crashed, lost network connectivity, or was shut down.
 *    Action:
 *      a. Mark the node's status as "NotReady"
 *      b. Remove all of that node's containers from every Deployment's containers[] array
 *      c. Set those deployments to "Degraded"
 *      d. The Reconciler will see the gap between desiredReplicas and actualReplicas
 *         on its next tick and recreate the containers on healthy nodes automatically
 *
 * 2. NODE RECOVERY (heartbeat resumed)
 *    If a "NotReady" node starts sending heartbeats again (lastHeartbeat within timeout),
 *    mark it "Ready" so the Scheduler can assign new containers to it again.
 *
 * Container crashes (individual container exits) are handled separately inside
 * ReconcilerService — the Reconciler inspects each container's status every cycle.
 */
const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const Event = require('../models/Event');

let detectorTimer = null;

/**
 * Write a cluster event to MongoDB (fire-and-forget, never throws).
 */
async function logEvent(type, reason, message, kind, name) {
    try {
        await Event.create({ type, reason, message, involvedObject: { kind, name } });
    } catch (_) { /* swallowed — event logging must never crash the detector */ }
}

/**
 * Run one failure detection pass:
 *   - Detect and handle stale (dead) nodes
 *   - Detect and recover nodes that have come back online
 */
async function detectFailures() {
    try {
        const timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '15000');
        // Any node whose last heartbeat is older than this Date is considered dead
        const cutoff = new Date(Date.now() - timeout);

        // ── Dead Node Detection ────────────────────────────────────────────────
        // Find nodes that are NOT already marked NotReady but whose heartbeat is stale
        const staleNodes = await Node.find({
            status: { $ne: 'NotReady' },    // Only ones we haven't flagged yet
            lastHeartbeat: { $lt: cutoff },        // Heartbeat is too old
        });

        for (const node of staleNodes) {
            console.warn(`[FailureDetector] Node "${node.nodeId}" missed heartbeat — marking NotReady`);
            node.status = 'NotReady';
            await node.save();

            await logEvent(
                'Warning',
                'NodeNotReady',
                `Node "${node.nodeId}" failed heartbeat check (last seen: ${node.lastHeartbeat})`,
                'Node',
                node.nodeId
            );

            // ── Reschedule containers from the dead node ─────────────────────
            // Find all deployments that currently have containers assigned to this node
            const deployments = await Deployment.find({
                'containers.nodeId': node.nodeId,
            });

            for (const dep of deployments) {
                try {
                    // Identify the containers on the dead node (for the event message count)
                    const deadContainers = dep.containers.filter((c) => c.nodeId === node.nodeId);
                    const survivingContainers = dep.containers.filter((c) => c.nodeId !== node.nodeId);

                    // Bug 7 fix: use atomic findByIdAndUpdate instead of dep.save().
                    // dep.save() increments __v and races with the Reconciler, causing
                    // VersionError and silently skipping the rescheduling on busy clusters.
                    await Deployment.findByIdAndUpdate(dep._id, {
                        $set: {
                            containers: survivingContainers,
                            actualReplicas: survivingContainers.length,
                            status: 'Degraded',
                        }
                    });

                    await logEvent(
                        'Warning',
                        'ContainerRescheduled',
                        `${deadContainers.length} container(s) from dead node "${node.nodeId}" removed from "${dep.name}" — reconciler will reschedule`,
                        'Deployment',
                        dep.name
                    );

                    console.log(
                        `[FailureDetector] Rescheduled ${deadContainers.length} containers from "${node.nodeId}" for deployment "${dep.name}"`
                    );
                } catch (err) {
                    console.error(`[FailureDetector] Error updating deployment "${dep.name}":`, err.message);
                }
            }
        }

        // ── Node Recovery Detection ────────────────────────────────────────────
        // Find nodes marked NotReady that have started sending heartbeats again
        const recoveredNodes = await Node.find({
            status: 'NotReady',
            lastHeartbeat: { $gte: cutoff }, // Recent heartbeat = node is back online
        });

        for (const node of recoveredNodes) {
            node.status = 'Ready';
            await node.save();
            console.log(`[FailureDetector] Node "${node.nodeId}" recovered — marking Ready`);
            await logEvent('Normal', 'NodeRecovered', `Node "${node.nodeId}" is back online`, 'Node', node.nodeId);
        }

        // ── Stale Node Cleanup (Purge) ──────────────────────────────────────────
        // Remove nodes that have been NotReady for a long time (e.g. 5 minutes)
        // This keeps the dashboard clean from old local workers that were killed.
        const purgeTimeout = parseInt(process.env.NODE_PURGE_TIMEOUT_MS || '300000'); // 5 mins
        const purgeCutoff = new Date(Date.now() - purgeTimeout);
        
        const nodesToPurge = await Node.find({
            status: 'NotReady',
            lastHeartbeat: { $lt: purgeCutoff }
        });

        for (const node of nodesToPurge) {
            console.log(`[FailureDetector] Purging stale node "${node.nodeId}" (no heartbeat for >5m)`);
            await Node.deleteOne({ _id: node._id });
            await logEvent('Normal', 'NodePurged', `Stale node "${node.nodeId}" removed from cluster`, 'Node', node.nodeId);
        }

    } catch (err) {
        console.error(`[FailureDetector] Error: ${err.message}`);
    }
}

/**
 * Start the failure detection loop.
 * Runs every 5 seconds. An initial pass fires after 3 s to let DB connect first.
 */
function start() {
    console.log('[FailureDetector] Starting');
    detectorTimer = setInterval(detectFailures, 5000);
    // Short delay before first run to avoid DB race on startup
    setTimeout(detectFailures, 3000);
}

/** Stop the failure detection loop (used for graceful shutdown / tests). */
function stop() {
    if (detectorTimer) clearInterval(detectorTimer);
}

module.exports = { start, stop };
