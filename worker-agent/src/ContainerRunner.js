/**
 * @file ContainerRunner.js — Local Docker operations for the worker agent.
 *
 * This module is the worker agent's interface to the local Docker daemon.
 * It talks to Docker directly (just like DockerService.js does on the control plane),
 * but is scoped to containers on THIS node only.
 *
 * The connection setup mirrors DockerService.js:
 *   • TCP (DOCKER_HOST env)    → useful when running in a container pointing at the host
 *   • Windows named pipe       → Docker Desktop on Windows
 *   • Unix socket (default)    → Linux / Docker inside a container
 *
 * Filtering by both "kubex.managed=true" AND "kubex.node=<NODE_ID>" ensures
 * this worker only sees and acts on its own containers, even if multiple workers
 * share the same Docker daemon (e.g. in a local dev setup).
 */
const Docker = require('dockerode');

// ── Docker client setup (mirrors DockerService.js on the control plane) ───────
let docker;
try {
    if (process.env.DOCKER_HOST && process.env.DOCKER_HOST.startsWith('tcp://')) {
        const parts = process.env.DOCKER_HOST.replace('tcp://', '').split(':');
        docker = new Docker({ host: parts[0], port: parseInt(parts[1]) });
    } else if (process.platform === 'win32') {
        docker = new Docker({ socketPath: '//./pipe/docker_engine' }); // Windows named pipe
    } else {
        docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
    }
} catch (err) {
    console.error(`[Worker] Docker client initialization error: ${err.message}`);
}

/**
 * Return the short IDs (first 12 chars) of all KUBEX-managed containers
 * currently RUNNING on this specific worker node.
 *
 * The dual label filter (kubex.managed + kubex.node) prevents this agent
 * from listing containers that belong to other workers.
 *
 * @returns {Promise<string[]>}  Array of 12-character container IDs
 */
async function listRunningContainerIds() {
    try {
        const containers = await docker.listContainers({
            filters: {
                label: [
                    'kubex.managed=true',                                     // Only KUBEX containers
                    `kubex.node=${process.env.NODE_ID || 'worker-1'}`,        // Only THIS worker's containers
                ],
                status: ['running'], // Only running ones — exited containers are handled by the Reconciler
            },
        });
        // Return shortened IDs — these are what the heartbeat payload sends to the API server
        return containers.map((c) => c.Id.slice(0, 12));
    } catch {
        return []; // If Docker is unreachable, return empty list rather than crashing
    }
}

/**
 * Start a container by its ID.
 * Used for resuming a stopped container (rarely called in the current architecture
 * because the Reconciler prefers to recreate rather than restart).
 *
 * @param {string} containerId
 */
async function startContainer(containerId) {
    if (!docker) return;
    try {
        const container = docker.getContainer(containerId);
        await container.start();
    } catch (err) {
        console.error(`[Worker] Failed to start container ${containerId}: ${err.message}`);
    }
}

/**
 * Stop and remove a container — called by:
 *   1. POST /commands/stop  (initiated by the control plane or frontend)
 *   2. POST /chaos/kill     (random container kill for chaos testing)
 *
 * Gives the container 5 seconds to shut down gracefully before force-killing.
 * Silently ignores "No such container" errors — already removed is fine.
 *
 * @param {string} containerId  Full or short Docker container ID
 */
async function stopContainer(containerId) {
    if (!docker || (containerId && containerId.startsWith('mock_'))) return;
    try {
        const container = docker.getContainer(containerId);
        await container.stop({ t: 5 });        // 5-second graceful shutdown window
        await container.remove({ force: true }); // Remove even if still running
    } catch (err) {
        // Don't throw if the container already doesn't exist
        if (!err.message.includes('No such container')) {
            console.error(`[Worker] Failed to stop container ${containerId}: ${err.message}`);
        }
    }
}

/**
 * Fetch logs for a specific container.
 *
 * @param {string} containerId
 * @param {number} tail
 * @returns {Promise<string>}
 */
async function getContainerLogs(containerId, tail = 100) {
    if (!docker) return 'Docker not available';
    try {
        const container = docker.getContainer(containerId);
        const logsBuffer = await container.logs({
            stdout: true,
            stderr: true,
            tail,
            timestamps: false,
        });
        const raw = logsBuffer.toString('utf8');
        const lines = raw.split('\n').map((line) => {
            if (line.length > 8) return line.slice(8);
            return line;
        });
        return lines.join('\n');
    } catch (err) {
        return `[Error fetching logs: ${err.message}]`;
    }
}

module.exports = { listRunningContainerIds, startContainer, stopContainer, getContainerLogs };
