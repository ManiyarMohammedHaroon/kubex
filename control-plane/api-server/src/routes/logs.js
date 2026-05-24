/**
 * @file routes/logs.js — Container log streaming routes.
 *
 * Mounted at /api/logs (see index.js).
 *
 * Endpoints:
 *   GET /:deploymentId              → logs for all containers of a deployment
 *   GET /:deploymentId/:containerId → logs for a single specific container
 *
 * Logs are fetched live from Docker via dockerode (not stored in MongoDB).
 * Each response returns the last 200 log lines (configurable via the `tail` param).
 *
 * Note on Docker log format:
 *   Docker multiplexes stdout and stderr into a single stream. Each log line
 *   is prefixed with an 8-byte binary header that identifies the stream type
 *   and frame length. DockerService.getContainerLogs() strips these headers
 *   before returning the plain text lines.
 */
const router = require('express').Router();
const Deployment = require('../models/Deployment');
const DockerService = require('../services/DockerService');

// ─── GET /api/logs/:deploymentId ─────────────────────────────────────────────
// Fetches the last 200 log lines from EVERY running container of the given
// deployment. Useful for the Logs page to show a unified log feed.
//
// Uses Promise.allSettled so that one failing container does not block
// the others from returning their logs.
//
// Response: { deployment: string, containers: [{ containerId, nodeId, logs }] }
router.get('/:deploymentId', async (req, res) => {
    try {
        // First, look up the deployment to get its name (needed for Docker label query)
        const dep = await Deployment.findById(req.params.deploymentId);
        if (!dep) return res.status(404).json({ success: false, error: 'Deployment not found' });

        // Find all Docker containers tagged with this deployment's name label
        const containers = await DockerService.listContainersByLabel({
            'kubex.deployment': dep.name,
        });
        
        // Fetch node addresses for all involved nodes
        const Node = require('../models/Node');
        const nodes = await Node.find({ nodeId: { $in: containers.map(c => c.nodeId) } });
        const nodeMap = new Map(nodes.map(n => [n.nodeId, n.address]));

        // Fetch logs from all containers in parallel; allSettled prevents partial failure
        const logResults = await Promise.allSettled(
            containers.map(async (c) => {
                const nodeAddress = nodeMap.get(c.nodeId);
                let logs = '';
                
                if (nodeAddress) {
                    try {
                        const response = await fetch(`${nodeAddress}/logs/${c.containerId}?tail=200`);
                        const result = await response.json();
                        logs = result.data || result.error || 'No logs found';
                    } catch (err) {
                        logs = `[Error reaching worker ${c.nodeId}: ${err.message}]`;
                    }
                } else {
                    // Fallback to local Docker if node address is unknown (e.g. local-mode)
                    logs = await DockerService.getContainerLogs(c.containerId, 200);
                }

                return {
                    containerId: c.containerId.slice(0, 12),
                    nodeId: c.nodeId,
                    logs,
                };
            })
        );

        // Filter out any rejected promises
        const logs = logResults
            .filter((r) => r.status === 'fulfilled')
            .map((r) => r.value);

        res.json({ success: true, data: { deployment: dep.name, containers: logs } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/logs/:deploymentId/:containerId ─────────────────────────────────
// Fetches the last 500 log lines from a single, specific container.
// The deploymentId segment is unused here (kept for URL hierarchy consistency)
// but the containerId is passed directly to Docker.
// Returns: { containerId: string, logs: string }
router.get('/:deploymentId/:containerId', async (req, res) => {
    try {
        const { containerId } = req.params;
        
        // Find which node this container is on by checking all deployments 
        // (This is faster than querying Docker for one ID)
        const dep = await Deployment.findOne({ 'containers.containerId': containerId });
        const containerInfo = dep?.containers.find(c => c.containerId === containerId);
        
        let logs = '';
        if (containerInfo) {
            const Node = require('../models/Node');
            const node = await Node.findOne({ nodeId: containerInfo.nodeId });
            if (node?.address) {
                try {
                    const response = await fetch(`${node.address}/logs/${containerId}?tail=500`);
                    const result = await response.json();
                    logs = result.data || result.error || 'No logs found';
                } catch (err) {
                    logs = `[Error reaching worker ${containerInfo.nodeId}: ${err.message}]`;
                }
            } else {
                logs = await DockerService.getContainerLogs(containerId, 500);
            }
        } else {
            // Fallback for untracked containers
            logs = await DockerService.getContainerLogs(containerId, 500);
        }

        res.json({ success: true, data: { containerId, logs } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
