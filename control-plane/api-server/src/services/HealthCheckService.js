/**
 * @file HealthCheckService.js — Autonomous L7 Application Health Checking.
 *
 * Runs on a configured interval (default 10s).
 * - Identifies deployments with Application Health Checks enabled.
 * - Pings the active containers on their specified health path.
 * - If a container fails consecutively beyond the threshold, it forcefully stops
 *   the container. The ReconcilerService will detect the missing container and 
 *   automatically spawn a replacement, providing self-healing for application-level crashes.
 */

const axios = require('axios');
const Node = require('../models/Node');
const Deployment = require('../models/Deployment');
const Event = require('../models/Event');
const DockerService = require('./DockerService');
const LoadBalancer = require('./LoadBalancer');

let healthTimer = null;

// Track consecutive failures per container ID: { 'containerId': number_of_failures }
const failureCounts = new Map();

async function logEvent(type, reason, message, kind, name) {
    try {
        await Event.create({ type, reason, message, involvedObject: { kind, name } });
    } catch (_) { /* swallowed */ }
}

async function performHealthChecks() {
    try {
        // Find deployments that have health checks enabled and are not terminating
        const deployments = await Deployment.find({
            status: { $nin: ['Terminating', 'Pending'] },
            'healthCheck.enabled': true
        });

        if (deployments.length === 0) return;

        // Fetch Ready nodes to build IP map
        const readyNodes = await Node.find({ status: 'Ready' }).select('nodeId address').lean();
        const nodeAddressMap = new Map(readyNodes.map(n => [n.nodeId, n.address]));

        for (const dep of deployments) {
            const path = dep.healthCheck.path || '/';
            const maxRetries = dep.healthCheck.maxRetries || 3;

            for (const container of dep.containers) {
                if (container.status !== 'running') continue;

                const nodeAddress = nodeAddressMap.get(container.nodeId);
                if (!nodeAddress || !container.hostPort) continue;

                // Extract just the hostname/IP from the node address (e.g. "http://localhost:4001" -> "localhost")
                let host = '127.0.0.1';
                try {
                    host = new URL(nodeAddress).hostname;
                } catch (e) {}

                const healthUrl = `http://${host}:${container.hostPort}${path}`;

                try {
                    // Timeout of 3 seconds to prevent hanging
                    await axios.get(healthUrl, { timeout: 3000 });
                    
                    // Success! Reset failure count.
                    if (failureCounts.has(container.containerId)) {
                        failureCounts.delete(container.containerId);
                    }
                } catch (err) {
                    const status = err.response ? err.response.status : (err.code || 'TIMEOUT');
                    const currentFailures = (failureCounts.get(container.containerId) || 0) + 1;
                    failureCounts.set(container.containerId, currentFailures);

                    console.warn(`[HealthCheck] Container ${container.containerId.substring(0, 12)} of "${dep.name}" failed health check (${status}). Attempt ${currentFailures}/${maxRetries}.`);

                    if (currentFailures >= maxRetries) {
                        console.error(`[HealthCheck] Container ${container.containerId.substring(0, 12)} reached max retries. Terminating container!`);
                        
                        await logEvent(
                            'Warning',
                            'UnhealthyContainerKilled',
                            `Container failed application health check ${maxRetries} times at ${path} (status: ${status}). Container was killed for automatic replacement.`,
                            'Deployment',
                            dep.name
                        );

                        // Kill it. The Reconciler will replace it.
                        await DockerService.stopAndRemoveContainer(container.containerId).catch(() => {});
                        LoadBalancer.removeEndpoint(dep.name, container.ip);
                        
                        failureCounts.delete(container.containerId);
                    }
                }
            }
        }

    } catch (err) {
        console.error(`[HealthCheckService] Error during checks: ${err.message}`);
    }
}

function start() {
    const interval = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '10000');
    console.log(`[HealthCheckService] Starting (interval: ${interval}ms)`);
    healthTimer = setInterval(performHealthChecks, interval);
}

function stop() {
    if (healthTimer) clearInterval(healthTimer);
    failureCounts.clear();
}

module.exports = { start, stop, performHealthChecks };
