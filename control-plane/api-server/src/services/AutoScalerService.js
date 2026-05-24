/**
 * @file AutoScalerService.js — Horizontal autoscaler for KUBEX deployments.
 *
 * Equivalent to a simplified Kubernetes Horizontal Pod Autoscaler (HPA).
 *
 * Every AUTOSCALER_INTERVAL_MS (default 10 s) this service:
 *   1. Finds all deployments that have autoscaling turned on (autoscalingEnabled: true)
 *   2. Looks up the live CPU usage of the nodes running those deployment's containers
 *   3. Averages the CPU across all involved nodes
 *   4. If avg CPU > cpuThresholdUp  AND desiredReplicas < maxReplicas → scale UP by 1
 *   5. If avg CPU < cpuThresholdDown AND desiredReplicas > minReplicas → scale DOWN by 1
 *   6. The Reconciler picks up the changed desiredReplicas on its next tick
 *
 * The AutoScaler only adjusts desiredReplicas by ±1 per cycle.
 * This conservative approach avoids thrashing (oscillating up and down rapidly).
 */
const Deployment = require('../models/Deployment');
const Node = require('../models/Node');
const Event = require('../models/Event');

let autoscalerTimer = null;
const lastScaleEvents = new Map(); // deploymentName -> timestamp
const COOLDOWN_MS = 60000;         // 1 minute stabilization window

/**
 * Write a cluster event to MongoDB (fire-and-forget, never throws).
 */
async function logEvent(type, reason, message, name) {
    try {
        await Event.create({ type, reason, message, involvedObject: { kind: 'Deployment', name } });
    } catch (_) { /* swallowed — event logging must never crash the autoscaler */ }
}

/**
 * Run one autoscaling pass across all autoscaling-enabled deployments.
 */
async function autoscaleAll() {
    try {
        // Only consider deployments that have autoscaling on AND are actually running
        // (skip Terminating and Pending — no containers to measure yet)
        const deployments = await Deployment.find({
            autoscalingEnabled: true,
            status: { $nin: ['Terminating', 'Pending'] },
        });

        for (const dep of deployments) {
            try {
                // Gather the unique node IDs that are running containers for this deployment
                const nodeIds = [...new Set(dep.containers.map((c) => c.nodeId).filter(Boolean))];
                if (nodeIds.length === 0) continue; // No containers placed yet — nothing to measure

                // Fetch the latest metrics for those nodes from MongoDB
                // (MetricsCollector on each worker keeps these up to date via heartbeats)
                const nodes = await Node.find({ nodeId: { $in: nodeIds } });
                if (nodes.length === 0) continue; // Nodes disappeared — skip this cycle

                // Average CPU across all nodes hosting this deployment's containers
                const avgCPU =
                    nodes.reduce((sum, n) => sum + n.metrics.cpuUsage, 0) / nodes.length;

                // Read thresholds from the deployment config, falling back to env vars
                const upThreshold = dep.cpuThresholdUp || parseInt(process.env.CPU_SCALE_UP_THRESHOLD || '80');
                const downThreshold = dep.cpuThresholdDown || parseInt(process.env.CPU_SCALE_DOWN_THRESHOLD || '20');

                // Check cooldown window to prevent thrashing
                const now = Date.now();
                const lastScale = lastScaleEvents.get(dep.name) || 0;
                if (now - lastScale < COOLDOWN_MS) {
                    continue; // Skip scaling for this deployment until cooldown expires
                }

                if (avgCPU > upThreshold && dep.desiredReplicas < dep.maxReplicas) {
                    // ── Scale UP ─────────────────────────────────────────────────
                    // Bug 8 fix: use atomic $inc instead of dep.save() to avoid VersionError
                    // races with the Reconciler. dep.save() would silently drop scaling decisions
                    // on busy clusters where the Reconciler modifies the same document concurrently.
                    const newReplicas = dep.desiredReplicas + 1;
                    await Deployment.findByIdAndUpdate(dep._id, {
                        $inc: { desiredReplicas: 1 },
                        $set: { status: 'Scaling' }
                    });
                    lastScaleEvents.set(dep.name, now);
                    
                    console.log(`[AutoScaler] Scaling UP "${dep.name}" to ${newReplicas} (CPU ${avgCPU.toFixed(1)}%)`);
                    await logEvent(
                        'Normal',
                        'ScaleUp',
                        `AutoScaler increased replicas to ${newReplicas} (avg CPU: ${avgCPU.toFixed(1)}%)`,
                        dep.name
                    );
                } else if (avgCPU < downThreshold && dep.desiredReplicas > dep.minReplicas) {
                    // ── Scale DOWN ────────────────────────────────────────────────
                    const newReplicas = dep.desiredReplicas - 1;
                    await Deployment.findByIdAndUpdate(dep._id, {
                        $inc: { desiredReplicas: -1 },
                        $set: { status: 'Scaling' }
                    });
                    lastScaleEvents.set(dep.name, now);

                    console.log(`[AutoScaler] Scaling DOWN "${dep.name}" to ${newReplicas} (CPU ${avgCPU.toFixed(1)}%)`);
                    await logEvent(
                        'Normal',
                        'ScaleDown',
                        `AutoScaler decreased replicas to ${newReplicas} (avg CPU: ${avgCPU.toFixed(1)}%)`,
                        dep.name
                    );
                }
                // If CPU is between thresholds, no action is taken (stable zone)
            } catch (err) {
                if (err.name === 'VersionError') {
                    // Ignore and retry next cycle
                } else {
                    console.error(`[AutoScaler] Error processing deployment "${dep.name}": ${err.message}`);
                }
            }
        }
    } catch (err) {
        console.error(`[AutoScaler] Error: ${err.message}`);
    }
}

/**
 * Start the autoscaling loop.
 * Interval is read from AUTOSCALER_INTERVAL_MS env var (default 10 000 ms).
 */
function start() {
    const interval = parseInt(process.env.AUTOSCALER_INTERVAL_MS || '10000');
    console.log(`[AutoScaler] Starting with ${interval}ms interval`);
    autoscalerTimer = setInterval(autoscaleAll, interval);
}

/** Stop the autoscaling loop (used for graceful shutdown / tests). */
function stop() {
    if (autoscalerTimer) clearInterval(autoscalerTimer);
}

module.exports = { start, stop };
