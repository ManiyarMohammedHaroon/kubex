const Node = require('../models/Node');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

async function provisionWorker() {
    const nodes = await Node.find();

    const workerIds = nodes.map(n => {
        const match = n.nodeId.match(/worker-(\d+)/);
        return match ? parseInt(match[1]) : 0;
    });
    const suffix = crypto.randomBytes(2).toString('hex');
    const workerId = `worker-${(workerIds.length > 0 ? Math.max(...workerIds) : 0) + 1}-${suffix}`;

    // Generate a secure API token for this worker agent to authenticate with
    const token = crypto.randomBytes(32).toString('hex');

    // Create the Node record in MongoDB with 'Pending' status.
    // The address will be updated automatically when the worker sends its first heartbeat.
    await Node.create({
        nodeId: workerId,
        token: token,
        address: 'Pending Registration', // Will be overwritten by heartbeat
        status: 'Unknown',
        pid: null
    });

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

