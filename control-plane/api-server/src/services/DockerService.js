/**
 * @file DockerService.js — Docker container lifecycle management.
 *
 * This is the ONLY place in the control-plane that talks directly to the
 * Docker daemon. All other services call functions here rather than using
 * dockerode directly.
 *
 * Connection strategy:
 *   • Windows Docker Desktop → named pipe //./pipe/docker_engine
 *   • TCP (DOCKER_HOST env)  → used when running inside a container pointing at the host
 *   • Linux / Docker socket  → /var/run/docker.sock (default in containers)
 *
 * Every KUBEX-managed container is tagged with labels so they can be found
 * later without knowing the container ID:
 *   kubex.managed    = "true"
 *   kubex.deployment = <deploymentName>
 *   kubex.replica    = <replicaIndex>
 *   kubex.node       = <nodeId>
 */
const Docker = require('dockerode');
const Deployment = require('../models/Deployment');


// ── Docker client setup ──────────────────────────────────────────────────────
let docker;
let isDockerAvailable = true;

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
    console.error('[Docker] FAILED to initialize Docker client:', err.message);
    isDockerAvailable = false;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Convert a human-readable memory string to bytes for Docker's HostConfig.
 * Robustly handles formats like "128m", "512K", "1 GB", "2048" (bytes).
 *
 * @param {string} memStr  Memory string
 * @returns {number}       Equivalent value in bytes
 */
function parseMemory(memStr) {
    if (!memStr) return 0;
    const match = String(memStr).match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
    if (!match) return 0;

    const val = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    if (unit.startsWith('g')) return Math.floor(val * 1024 * 1024 * 1024);
    if (unit.startsWith('m')) return Math.floor(val * 1024 * 1024);
    if (unit.startsWith('k')) return Math.floor(val * 1024);
    return Math.floor(val); // Assume bytes
}

// ─── Container Lifecycle ──────────────────────────────────────────────────────

/**
 * Ensure the 'kubex-net' user-defined bridge network exists.
 * This network allows containers to communicate with each other
 * and supports name-based DNS discovery.
 */
async function ensureNetwork() {
    if (!isDockerAvailable) return;
    try {
        const networks = await docker.listNetworks();
        if (!networks.find(n => n.Name === 'kubex-net')) {
            console.log('[Docker] Creating "kubex-net" network...');
            await docker.createNetwork({ Name: 'kubex-net', Driver: 'bridge' });
        }
    } catch (err) {
        console.error('[Docker] Failed to ensure network "kubex-net":', err.message);
    }
}

/**
 * Create and start a new Docker container for a KUBEX deployment replica.
 */
async function createAndStartContainer(image, deploymentName, replicaIndex, resourceLimits = {}, envVars = [], nodeId = 'local', forcedHostPort = '', containerPort = 80) {
    if (!isDockerAvailable) {
        console.warn(`[Docker] Cannot create container: Docker is NOT available`);
        return { containerId: `mock_${Date.now()}`, ip: '127.0.0.1', hostPort: '8080' };
    }

    await ensureNetwork();

    // Convert fractional CPU (e.g. 0.5) to Docker's NanoCpus unit (1 CPU = 1,000,000,000 NanoCpus)
    const NanoCpus = Math.floor((parseFloat(resourceLimits.cpu || '0.5')) * 1e9);
    const Memory = parseMemory(resourceLimits.memory || '128m');

    // ─── Step 0.5: Infrastructure Injection ──────────────────────────────────
    const infraEnvs = [
        { key: 'NODE_ENV', value: 'production' }
    ];

    // ─── Step 0.6: Service Discovery Injection ─────────────────────────────────
    const allDeps = await Deployment.find({ status: { $ne: 'Terminating' } });
    const serviceEnvs = allDeps.map(d => ({
        key: `KUBEX_SERVICE_${d.name.toUpperCase().replace(/-/g, '_')}`,
        value: `http://${d.name}:${d.containerPort}`
    }));

    // Merge everything into a flat array of "KEY=VALUE" strings
    const finalEnvs = new Map();
    
    // Order: Infra < Service Discovery < User-Defined (highest priority)
    infraEnvs.forEach(e => finalEnvs.set(e.key, e.value));
    serviceEnvs.forEach(e => finalEnvs.set(e.key, e.value));
    if (envVars && Array.isArray(envVars)) {
        envVars.forEach(e => {
            if (e.key) finalEnvs.set(e.key, e.value);
        });
    }

    const envArray = Array.from(finalEnvs.entries()).map(([k, v]) => `${k}=${v}`);
    console.log(`[Docker] Final Env for ${deploymentName}:`, envArray.filter(e => e.includes('MONGO')));



        const container = await docker.createContainer({
            Image: image,
            // Use a combination of name, index, and random suffix to guarantee uniqueness
            name: `kubex_${deploymentName}_rev${Date.now().toString().slice(-4)}_${replicaIndex}_${Math.random().toString(36).slice(2, 6)}`,
            Env: envArray.length ? envArray : undefined,
        Labels: {
            'kubex.managed': 'true',           // Allows bulk lookup of all KUBEX containers
            'kubex.deployment': deploymentName,   // Which deployment this replica belongs to
            'kubex.replica': String(replicaIndex),
            'kubex.node': nodeId,            // Which worker this is assigned to
            'kubex.containerPort': String(containerPort), // Store the port so we can find it later
        },
        ExposedPorts: { [`${containerPort}/tcp`]: {} }, // Port the app is listening on
        NetworkingConfig: {
            EndpointsConfig: {
                'kubex-net': {
                    Aliases: [deploymentName], // This allows other containers to find this one by name!
                },
            },
        },
        HostConfig: {
            NanoCpus,
            Memory,
            RestartPolicy: { Name: 'no' },
            PortBindings: { [`${containerPort}/tcp`]: [{ HostPort: forcedHostPort }] }, // Map to random or fixed host port
            NetworkMode: 'kubex-net', // Put all containers in the same network
            ExtraHosts: ["host.docker.internal:host-gateway"], // Connect to host machine easily
        },
    });

    await container.start();

    // Use a small delay and retry to ensure Docker has assigned an IP address
    // to the container's network interface before we return.
    let ip = '127.0.0.1';
    for (let attempt = 0; attempt < 3; attempt++) {
        const inspect = await container.inspect();
        ip = inspect.NetworkSettings.Networks['kubex-net']?.IPAddress;
        if (ip && ip !== '') break;
        await new Promise(r => setTimeout(r, 500)); // Wait 500ms between retries
    }

    const info = await container.inspect();
    const hostPort = info.NetworkSettings.Ports[`${containerPort}/tcp`]?.[0]?.HostPort || '';
    
    console.log(`[Docker] Started container ${container.id.slice(0, 12)} for ${deploymentName} on node ${nodeId} (HostPort: ${hostPort})`);
    return { containerId: container.id, ip: ip || '127.0.0.1', hostPort };
}

/**
 * Gracefully stop then forcibly remove a container.
 * Gives the container 5 seconds to shut down cleanly before force-killing it.
 * Silently ignores "No such container" errors (already removed is fine).
 *
 * @param {string} containerId  Full or short Docker container ID
 */
async function stopAndRemoveContainer(containerId) {
    if (!isDockerAvailable || (containerId && containerId.startsWith('mock_'))) {
        console.log(`[Docker] Mock stop/remove for ${containerId}`);
        return;
    }
    try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect().catch(() => null);
        if (!info) return; // Container already gone — nothing to do

        if (info.State.Running) {
            await container.stop({ t: 5 }); // Wait up to 5 seconds for graceful shutdown
        }
        await container.remove({ force: true }); // force:true removes even if still running
        console.log(`[Docker] Removed container ${containerId.slice(0, 12)}`);
    } catch (err) {
        // Don't throw if the container was already removed by something else
        if (!err.message.includes('No such container')) {
            console.error(`[Docker] Error removing ${containerId.slice(0, 12)}: ${err.message}`);
        }
    }
}

/**
 * Inspect a single container and return its current state string.
 *
 * @param {string} containerId
 * @returns {Promise<'running'|'exited'|'dead'|'paused'|'created'|'unknown'>}
 */
async function getContainerState(containerId) {
    try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        return info.State.Status; // running | exited | dead | paused | created
    } catch (err) {
        return 'unknown'; // Container not found or Docker error
    }
}

/**
 * Fetch the last `tail` log lines from a container (stdout + stderr combined).
 *
 * Docker multiplexes stdout and stderr into one stream with an 8-byte binary
 * header per frame: [stream_type(1), padding(3), size(4)].
 * We strip this header by slicing off the first 8 characters of each line.
 *
 * @param {string} containerId
 * @param {number} [tail=100]  Number of lines to fetch from the end of the log
 * @returns {Promise<string>}  Plain text log output
 */
async function getContainerLogs(containerId, tail = 100) {
    try {
        const container = docker.getContainer(containerId);
        const logsBuffer = await container.logs({
            stdout: true,
            stderr: true,
            tail,
            timestamps: false, // Don't prepend RFC3339 timestamps (handled by UI if needed)
        });

        // Bug 13 fix: Docker's multiplex header is 8 binary bytes per frame.
        // We must process the raw Buffer BEFORE converting to a string, so that
        // multi-byte UTF-8 characters (emoji, CJK, etc.) don't shift byte offsets
        // and corrupt the output.
        const lines = [];
        let offset = 0;
        while (offset < logsBuffer.length) {
            // Each Docker log frame: [stream(1), padding(3), size(4)] = 8 bytes header
            if (offset + 8 > logsBuffer.length) break;
            const frameSize = logsBuffer.readUInt32BE(offset + 4);
            const frameData = logsBuffer.slice(offset + 8, offset + 8 + frameSize);
            lines.push(frameData.toString('utf8'));
            offset += 8 + frameSize;
        }

        // Fallback: if the buffer doesn't look like multiplexed output (e.g. TTY mode),
        // just decode the whole thing as plain text.
        if (lines.length === 0) {
            return logsBuffer.toString('utf8');
        }

        return lines.join('');
    } catch (err) {
        return `[Error fetching logs: ${err.message}]`;
    }
}

/**
 * List all KUBEX-managed containers filtered by one or more labels.
 * Returns full detail (IP, host port, node ID) by inspecting each container.
 *
 * @param {object} labelFilter  Extra labels to filter on, e.g. { 'kubex.deployment': 'my-app' }
 * @returns {Promise<Array<{containerId, deploymentName, nodeId, replicaIndex, status, image, ip, hostPort}>>}
 */
async function listContainersByLabel(labelFilter = {}) {
    if (!isDockerAvailable) return [];
    // Always include the kubex.managed=true base filter to avoid touching non-KUBEX containers
    const filters = {
        label: ['kubex.managed=true'],
    };
    // Add any extra label filters provided by the caller
    Object.entries(labelFilter).forEach(([k, v]) => {
        filters.label.push(`${k}=${v}`);
    });

    // all: true → include stopped/exited containers too (Reconciler needs to see crashed ones)
    const containers = await docker.listContainers({ all: true, filters }).catch(() => []);

    // Inspect each container individually to get its network info (IP, ports)
    const fullDetails = await Promise.all(
        containers.map(async (c) => {
            const container = docker.getContainer(c.Id);
            const info = await container.inspect().catch(() => null);
            return {
                containerId: c.Id,
                deploymentName: c.Labels['kubex.deployment'],
                nodeId: c.Labels['kubex.node'] || 'local',
                replicaIndex: c.Labels['kubex.replica'],
                status: c.State,  // "running", "exited", "dead", etc.
                image: c.Image,
                labels: c.Labels,
                // Bug 10 fix: for user-defined bridge networks (kubex-net),
                // the top-level NetworkSettings.IPAddress is always ''. The correct
                // IP lives under NetworkSettings.Networks['kubex-net'].IPAddress.
                ip: info?.NetworkSettings?.Networks?.['kubex-net']?.IPAddress
                    || info?.NetworkSettings?.IPAddress
                    || '',
                hostPort: (() => {
                    const port = c.Labels['kubex.containerPort'] || '80';
                    return info?.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]?.HostPort || '';
                })(),
            };

        })
    );
    return fullDetails;
}

/**
 * Pull a Docker image from a registry before running it.
 * If the image already exists locally Docker is smart enough to skip layers.
 * Uses Docker modem's followProgress to wait for the full pull to complete.
 *
 * @param {string} image  Docker image reference (e.g. "nginx:alpine")
 * @returns {Promise<void>}
 */
async function pullImage(image) {
    // Check if the image already exists locally to avoid unnecessary registry pulls
    // (Crucial for local-only tags like ":local" which don't exist on Docker Hub)
    try {
        const localImage = docker.getImage(image);
        await localImage.inspect();
        console.log(`[Docker] Image ${image} found locally. Skipping pull.`);
        return;
    } catch (err) {
        // Not found locally, proceed to pull from registry
    }

    console.log(`[Docker] Pulling image from registry: ${image}`);
    return new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) {
                console.error(`[Docker] Pull error for ${image}: ${err.message}`);
                return reject(err);
            }
            // followProgress waits until the pull stream ends then calls back
            docker.modem.followProgress(stream, (pullErr, output) => {
                if (pullErr) {
                    console.error(`[Docker] Error following pull progress for ${image}: ${pullErr.message}`);
                    return reject(pullErr);
                }
                console.log(`[Docker] Finished pulling ${image}`);
                resolve(output);
            });
        });
    });
}

/**
 * DBaaS: Create and start an isolated Managed Database container with a persistent volume.
 */
async function createDatabaseContainer(dbRecord) {
    if (!isDockerAvailable) throw new Error('Docker is not available on this node.');

    await ensureNetwork();

    let image = '';
    let Env = [];
    const containerName = `kubex-db-${dbRecord._id}`;
    const volumeName = `kubex-vol-${dbRecord._id}`;

    switch (dbRecord.type) {
        case 'mongo':
            image = 'mongo:6.0';
            Env = [
                `MONGO_INITDB_ROOT_USERNAME=${dbRecord.credentials.username}`,
                `MONGO_INITDB_ROOT_PASSWORD=${dbRecord.credentials.password}`
            ];
            break;
        case 'postgres':
            image = 'postgres:15-alpine';
            Env = [
                `POSTGRES_USER=${dbRecord.credentials.username}`,
                `POSTGRES_PASSWORD=${dbRecord.credentials.password}`,
                `POSTGRES_DB=kubexdb`
            ];
            break;
        case 'mysql':
            image = 'mysql:8.0';
            Env = [
                `MYSQL_ROOT_PASSWORD=${dbRecord.credentials.password}`,
                `MYSQL_USER=${dbRecord.credentials.username}`,
                `MYSQL_PASSWORD=${dbRecord.credentials.password}`,
                `MYSQL_DATABASE=kubexdb`
            ];
            break;
        case 'redis':
            image = 'redis:7.0-alpine';
            break;
    }

    await pullImage(image);

    try {
        await docker.getVolume(volumeName).inspect();
    } catch (e) {
        await docker.createVolume({ Name: volumeName });
    }

    let mountTarget = '/data/db';
    if (dbRecord.type === 'postgres') mountTarget = '/var/lib/postgresql/data';
    if (dbRecord.type === 'mysql') mountTarget = '/var/lib/mysql';
    if (dbRecord.type === 'redis') mountTarget = '/data';

    const createOpts = {
        Image: image,
        name: containerName,
        Env,
        HostConfig: {
            NetworkMode: 'kubex-net',
            Binds: [`${volumeName}:${mountTarget}`],
            RestartPolicy: { Name: 'unless-stopped' }
        },
        Labels: {
            'com.kubex.type': 'database',
            'com.kubex.dbId': dbRecord._id.toString()
        }
    };

    if (dbRecord.type === 'redis') {
        createOpts.Cmd = ['redis-server', '--requirepass', dbRecord.credentials.password];
    }

    const container = await docker.createContainer(createOpts);
    await container.start();

    return { containerId: container.id, volumeName };
}

/**
 * DBaaS: Spin up or fetch a Web GUI container for a specific database.
 */
async function ensureGuiContainer(dbRecord) {
    if (!isDockerAvailable) throw new Error('Docker is not available.');
    
    const guiName = `kubex-db-gui-${dbRecord._id}`;
    let internalPort = 8081;
    if (dbRecord.type === 'postgres' || dbRecord.type === 'mysql') {
        internalPort = 8080;
    }
    
    try {
        const existingContainer = docker.getContainer(guiName);
        let existing = await existingContainer.inspect();
        if (!existing.State.Running) {
            await existingContainer.start();
            existing = await existingContainer.inspect();
            // Wait for internal GUI service to boot up before allowing proxy connection
            await new Promise(r => setTimeout(r, 3000));
        }
        const hostPort = existing.NetworkSettings.Ports[`${internalPort}/tcp`]?.[0]?.HostPort;
        if (!hostPort) throw new Error('No host port mapped');
        return `http://127.0.0.1:${hostPort}`;
    } catch (e) {
        // Container doesn't exist or is invalid, we must create it
        try {
            // cleanup if it existed but failed to map port
            await docker.getContainer(guiName).remove({ force: true }).catch(() => {});
        } catch(err) {}
    }

    let image = '';
    let Env = [];

    if (dbRecord.type === 'mongo') {
        image = 'mongo-express:1.0.0-alpha.4'; // Lightweight version
        Env = [
            `ME_CONFIG_MONGODB_SERVER=kubex-db-${dbRecord._id}`,
            `ME_CONFIG_MONGODB_ADMINUSERNAME=${dbRecord.credentials.username}`,
            `ME_CONFIG_MONGODB_ADMINPASSWORD=${dbRecord.credentials.password}`,
            `ME_CONFIG_BASICAUTH_USERNAME=${dbRecord.credentials.username}`,
            `ME_CONFIG_BASICAUTH_PASSWORD=${dbRecord.credentials.password}`,
            `ME_CONFIG_SITE_BASEURL=/api/databases/${dbRecord._id}/gui/`
        ];
    } else if (dbRecord.type === 'postgres' || dbRecord.type === 'mysql') {
        image = 'adminer:4.8.1';
        Env = [
            `ADMINER_DEFAULT_SERVER=kubex-db-${dbRecord._id}`
        ];
        internalPort = 8080; // Adminer uses 8080 internally
    } else if (dbRecord.type === 'redis') {
        image = 'rediscommander/redis-commander:latest';
        Env = [
            `REDIS_HOSTS=local:kubex-db-${dbRecord._id}:6379:0:${dbRecord.credentials.password}`,
            `HTTP_USER=${dbRecord.credentials.username}`,
            `HTTP_PASSWORD=${dbRecord.credentials.password}`
        ];
    }

    if (!image) throw new Error('No GUI available for this database type.');

    await pullImage(image);

    const container = await docker.createContainer({
        Image: image,
        name: guiName,
        Env,
        HostConfig: {
            NetworkMode: 'kubex-net',
            RestartPolicy: { Name: 'unless-stopped' },
            PortBindings: { [`${internalPort}/tcp`]: [{ HostPort: '0' }] }
        },
        ExposedPorts: { [`${internalPort}/tcp`]: {} }
    });

    await container.start();
    
    // KUBEX Premium Aesthetic Injection
    if (dbRecord.type === 'mongo') {
        try {
            const themeCss = `
                body, html { background-color: #f4f6f8 !important; color: #212529 !important; font-family: 'Inter', system-ui, -apple-system, sans-serif !important; }
                .navbar, .navbar-default { background-color: #ffffff !important; border-bottom: 1px solid #dee2e6 !important; box-shadow: 0 1px 3px rgba(0,0,0,0.02) !important; }
                .navbar-brand, .navbar-default .navbar-brand, .navbar-default .navbar-nav>li>a { color: #212529 !important; font-weight: 600; letter-spacing: -0.5px; }
                .navbar-default .navbar-nav>li>a:hover { color: #0d6efd !important; background-color: #f8f9fa !important; }
                .well, .panel, .panel-default>.panel-heading, .panel-body { background-color: #ffffff !important; border: 1px solid #dee2e6 !important; color: #212529 !important; border-radius: 6px !important; box-shadow: 0 1px 3px rgba(0,0,0,0.02) !important; }
                .panel-heading h4 { font-weight: 600 !important; color: #212529 !important; }
                .modal-content, .modal-header, .modal-footer { background-color: #ffffff !important; border-color: #dee2e6 !important; color: #212529 !important; border-radius: 6px !important; }
                .modal-title { font-weight: 700 !important; }
                .table { border-collapse: collapse !important; }
                .table th { background-color: #f8f9fa !important; color: #495057 !important; text-transform: uppercase; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; border-bottom: 1px solid #dee2e6 !important; padding: 12px 16px !important; }
                .table td { color: #212529 !important; background-color: transparent !important; border-bottom: 1px solid #dee2e6 !important; border-top: none !important; padding: 14px 16px !important; font-size: 14px; }
                .table-striped>tbody>tr:nth-of-type(odd) { background-color: #f8f9fa !important; }
                .table-bordered, .table-bordered>tbody>tr>td, .table-bordered>thead>tr>th { border-color: #dee2e6 !important; }
                .table>tbody>tr:hover>td { background-color: #f8f9fa !important; }
                .btn { border-radius: 4px !important; font-weight: 500 !important; border: 1px solid transparent; text-shadow: none !important; box-shadow: none !important; transition: all 0.2s; }
                .btn-primary { background-color: #0d6efd !important; color: white !important; }
                .btn-primary:hover { background-color: #0b5ed7 !important; }
                .btn-success { background-color: #198754 !important; color: white !important; }
                .btn-success:hover { background-color: #146c43 !important; }
                .btn-danger { background-color: #dc3545 !important; color: white !important; border: 1px solid #dc3545 !important; }
                .btn-danger:hover { background-color: #b02a37 !important; color: white !important; }
                .btn-warning { background-color: #ffc107 !important; color: #212529 !important; }
                .btn-default, .btn-secondary { background-color: white !important; color: #212529 !important; border: 1px solid #dee2e6 !important; }
                .btn-default:hover, .btn-secondary:hover { background-color: #e9ecef !important; border-color: #ced4da !important; }
                a { color: #0d6efd !important; text-decoration: none !important; }
                a:hover { color: #0a58ca !important; }
                h1, h2, h3, h4, h5, .page-header { color: #212529 !important; font-weight: 700 !important; border-bottom-color: #dee2e6 !important; margin-top: 0 !important; padding-top: 15px !important; letter-spacing: -0.5px; }
                .breadcrumb { background-color: #ffffff !important; border-radius: 6px !important; border: 1px solid #dee2e6 !important; }
                .form-control, input[type="text"], input[type="password"] { background-color: #ffffff !important; border: 1px solid #dee2e6 !important; color: #212529 !important; height: 40px !important; border-radius: 4px !important; box-shadow: none !important; font-size: 14px !important; }
                .form-control:focus { border-color: #0d6efd !important; box-shadow: 0 0 0 0.25rem rgba(13,110,253,.25) !important; }
                .dropdown-menu { background-color: #ffffff !important; border: 1px solid #dee2e6 !important; border-radius: 6px !important; box-shadow: 0 4px 12px rgba(0,0,0,0.05) !important; }
                .dropdown-menu > li > a { color: #495057 !important; padding: 8px 16px !important; }
                .dropdown-menu > li > a:hover { background-color: #f8f9fa !important; color: #212529 !important; }
                code, pre { background-color: #f8f9fa !important; color: #6f42c1 !important; border: 1px solid #dee2e6 !important; border-radius: 4px !important; text-shadow: none !important; }
                .text-muted, .help-block { color: #6c757d !important; }
                p, td, th { color: #212529; }
                span { color: inherit; }
                .CodeMirror { background-color: #ffffff !important; color: #212529 !important; border-radius: 4px; border: 1px solid #dee2e6 !important; }
                .CodeMirror-gutters { background-color: #f8f9fa !important; border-right: 1px solid #dee2e6 !important; }
                .glyphicon { margin-right: 6px; }
            `.replace(/\n/g, ' ').replace(/\s+/g, ' ');

            const exec = await docker.getContainer(guiName).exec({
                Cmd: ['sh', '-c', `sed -i 's|</head>|<style>${themeCss}</style></head>|' /node_modules/mongo-express/lib/views/layout.html || true`],
                AttachStdout: true,
                AttachStderr: true
            });
            await exec.start({});
            
            // Wait a second for the sed command to finish, then restart the container
            // This is required because mongo-express reads and caches layout.html into memory instantly upon boot,
            // which causes a race condition where the injection happens too late.
            await new Promise(r => setTimeout(r, 1000));
            await docker.getContainer(guiName).restart();
            
            console.log(`[Docker] Injected KUBEX Classy Light Mode into ${guiName} and restarted`);
        } catch (themeErr) {
            console.error(`[Docker] Failed to inject theme:`, themeErr.message);
        }
    }

    // Wait 3 seconds for the internal Node.js server to fully bind to the port
    await new Promise(r => setTimeout(r, 3000));

    const info = await container.inspect();
    const newHostPort = info.NetworkSettings.Ports[`${internalPort}/tcp`]?.[0]?.HostPort;
    return `http://127.0.0.1:${newHostPort}`;
}

/**
 * DBaaS: Stop and remove a Managed Database container, and permanently delete its volume.
 */
async function removeDatabaseContainer(containerId, volumeName, dbId = null) {
    if (!isDockerAvailable) return;
    try {
        const container = docker.getContainer(containerId);
        await container.stop({ t: 2 }).catch(() => {});
        await container.remove({ force: true }).catch(() => {});
    } catch (err) {
        console.warn(`[Docker] Failed to remove DB container ${containerId}:`, err.message);
    }

    if (dbId) {
        try {
            const guiName = `kubex-db-gui-${dbId}`;
            const guiContainer = docker.getContainer(guiName);
            await guiContainer.stop({ t: 2 }).catch(() => {});
            await guiContainer.remove({ force: true }).catch(() => {});
        } catch (err) {
            console.warn(`[Docker] Failed to remove DB GUI container for ${dbId}:`, err.message);
        }
    }

    if (volumeName) {
        try {
            const volume = docker.getVolume(volumeName);
            await volume.remove({ force: true }).catch(() => {});
        } catch (err) {
            console.warn(`[Docker] Failed to remove DB volume ${volumeName}:`, err.message);
        }
    }
}

module.exports = {
    createAndStartContainer,
    stopAndRemoveContainer,
    getContainerState,
    getContainerLogs,
    listContainersByLabel,
    pullImage,
    docker,
    isAvailable: () => isDockerAvailable,
    createDatabaseContainer,
    ensureGuiContainer,
    removeDatabaseContainer
};
