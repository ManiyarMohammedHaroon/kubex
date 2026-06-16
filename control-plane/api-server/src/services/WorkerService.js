const Node = require('../models/Node');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');
const Docker = require('dockerode');

// Setup Docker client
let docker;
try {
    if (process.env.DOCKER_HOST && process.env.DOCKER_HOST.startsWith('tcp://')) {
        const parts = process.env.DOCKER_HOST.replace('tcp://', '').split(':');
        docker = new Docker({ host: parts[0], port: parseInt(parts[1]) });
    } else if (process.platform === 'win32') {
        docker = new Docker({ socketPath: '//./pipe/docker_engine' });
    } else {
        docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
    }
} catch (err) {
    console.error(`[WorkerService] Docker client initialization error: ${err.message}`);
}

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

async function provisionWorker(ownerId = null, type = 'local') {
    const nodes = await Node.find();

    const workerIds = nodes.map(n => {
        const match = n.nodeId.match(/worker-(\d+)/);
        return match ? parseInt(match[1]) : 0;
    });
    const suffix = crypto.randomBytes(2).toString('hex');
    const workerId = `worker-${(workerIds.length > 0 ? Math.max(...workerIds) : 0) + 1}-${suffix}`;

    // Generate a secure API token for this worker agent to authenticate with
    const token = crypto.randomBytes(32).toString('hex');
    const port = await getNextWorkerPort();

    // Create the Node record in MongoDB
    await Node.create({
        nodeId: workerId,
        token: token,
        address: `http://localhost:${port}`, // Will be overwritten by heartbeat
        status: 'Unknown',
        pid: null,
        owner: ownerId
    });

    if (type === 'local') {
        if (docker) {
            try {
                console.log(`[WorkerService] Spawning Docker container for ${workerId} on port ${port}...`);
                const container = await docker.createContainer({
                    Image: 'kubex-worker-agent:latest',
                    name: `kubex-${workerId}`,
                    Env: [
                        `NODE_ID=${workerId}`,
                        `NODE_ENV=local`,
                        `KUBEX_TOKEN=${token}`,
                        `AGENT_ADDRESS=http://localhost:${port}`,
                        `AGENT_PORT=${port}`,
                        `API_SERVER_URL=${process.env.NODE_ENV === 'development' ? 'http://host.docker.internal:3001' : 'http://kubex-api-server:3001'}`,
                        `DOCKER_HOST=${process.env.DOCKER_HOST || ''}`
                    ],
                    Labels: {
                        'kubex.worker': 'true'
                    },
                    HostConfig: {
                        NetworkMode: 'kubex_kubex-net',
                        PortBindings: {
                            [`${port}/tcp`]: [{ HostPort: port.toString() }]
                        },
                        // Mount docker socket natively (Docker Desktop handles this translation on Windows)
                        Binds: !process.env.DOCKER_HOST 
                            ? ['/var/run/docker.sock:/var/run/docker.sock'] 
                            : []
                    }
                });
                await container.start();
                console.log(`[WorkerService] Worker container ${workerId} started successfully.`);
            } catch (err) {
                console.error(`[WorkerService] Failed to spawn worker container: ${err.message}`);
            }
        } else {
            console.warn('[WorkerService] Docker not available, skipping auto-spawn.');
        }
    } else {
        console.log(`[WorkerService] Remote provisioning requested for ${workerId}. Skipping local Docker spawn.`);
    }

    return { workerId, token };
}

async function stopAllWorkers() {
    const nodes = await Node.find({ pid: { $exists: true } });
    
    // 1. Try graceful kill via stored PIDs
    for (const node of nodes) {
        try {
            if (node.pid) {
                process.kill(node.pid, 'SIGKILL');
                console.log(`[WorkerService] Killed worker ${node.nodeId} (PID: ${node.pid})`);
            }
        } catch (e) { /* already dead */ }
    }

    // 2. Aggressive cleanup for Windows: kill any node process in the worker-agent path
    // This catches "ghost" workers that survived a previous crash/restart.
    if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        try {
            const cmd = `powershell -Command "Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path -like '*worker-agent*') { Stop-Process $_.Id -Force } }"`;
            execSync(cmd);
            console.log('[WorkerService] Cleaned up ghost worker processes.');
        } catch (err) {
            // Ignore errors if no processes found
        }
    }
}

module.exports = { provisionWorker, stopAllWorkers };

