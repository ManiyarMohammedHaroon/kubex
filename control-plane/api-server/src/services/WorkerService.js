const Node = require('../models/Node');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function spawnWorker() {
    const nodes = await Node.find();

    // Bug 6 fix: scan actually-used ports instead of computing from workerIds.length.
    // The old formula (4001 + workerIds.length) collides when workers have been
    // deleted and re-created (e.g. two workers exist on ports 4001 and 4003;
    // the formula would still return 4002 even if it's already taken).
    const usedPorts = nodes.map(n => {
        const match = n.address && n.address.match(/:(\d+)$/);
        return match ? parseInt(match[1]) : null;
    }).filter(p => p !== null);

    let port = 4001;
    while (usedPorts.includes(port)) {
        port++;
    }

    const workerIds = nodes.map(n => {
        const match = n.nodeId.match(/worker-(\d+)/);
        return match ? parseInt(match[1]) : 0;
    });
    const suffix = Math.random().toString(36).substring(2, 6);
    const workerId = `worker-${(workerIds.length > 0 ? Math.max(...workerIds) : 0) + 1}-${suffix}`;

    // Path to worker-agent (up 4 levels: services -> src -> api-server -> control-plane -> KUBEX)
    const workerPath = path.join(__dirname, '../../../..', 'worker-agent');

    console.log(`📦 Spawning new worker: ${workerId} on port ${port}`);

    const out = fs.openSync(path.join(workerPath, `worker-${port}.log`), 'a');
    const err = fs.openSync(path.join(workerPath, `worker-${port}.err`), 'a');

    // Bug 12 fix: wait briefly before creating the DB record so that synchronous
    // spawn failures (e.g. node binary not found) can fire the 'error' event
    // and prevent a ghost Node document from being written to MongoDB.
    const workerProcess = spawn(process.execPath, ['src/index.js'], {
        cwd: workerPath,
        detached: true,
        stdio: ['ignore', out, err],
        env: {
            ...process.env,
            NODE_ID: workerId,
            AGENT_PORT: port.toString(),
            AGENT_ADDRESS: `http://localhost:${port}`,
        }
    });

    // Wait up to 500 ms for an immediate spawn error before committing to the DB
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500); // No error in 500ms → assume started OK
        workerProcess.on('error', (spawnErr) => {
            clearTimeout(timer);
            reject(new Error(`Failed to spawn worker ${workerId}: ${spawnErr.message}`));
        });
    });

    workerProcess.unref();

    await Node.create({
        nodeId: workerId,
        address: `http://localhost:${port}`,
        status: 'Unknown',
        pid: workerProcess.pid
    });

    return { workerId, port };
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

module.exports = { spawnWorker, stopAllWorkers };

