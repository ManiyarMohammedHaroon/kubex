const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const localtunnel = require('localtunnel');
const Docker = require('dockerode');

// Setup Docker client (mirrors the old setup)
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
    console.error(`[Worker] Docker client error: ${err.message}`);
}

const activeTunnels = new Map(); // containerId -> { tunnel, url, subdomain }

// Helper: Ensure Dockerfile exists before building
const ensureDockerfile = (dir, backendPort, envVars = []) => {
    backendPort = backendPort || 3000;
    const dfPath = path.join(dir, 'Dockerfile');
    const isKubexGen = fs.existsSync(dfPath) && fs.readFileSync(dfPath, 'utf8').includes('# KUBEX-GENERATED');
    if (fs.existsSync(dfPath) && !isKubexGen) return;

    const header = '# KUBEX-GENERATED\n';
    let content = '';
    const buildEnvLines = [];
    if (envVars && envVars.length > 0) {
        for (const ev of envVars) {
            if (ev.key) {
                buildEnvLines.push(`ARG ${ev.key}`);
                buildEnvLines.push(`ENV ${ev.key}=$${ev.key}`);
            }
        }
    }
    
    if (fs.existsSync(path.join(dir, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const hasVite = !!(pkg.dependencies?.vite || pkg.devDependencies?.vite);
        if (hasVite) {
            const lines = [
                'FROM node:18-alpine AS build',
                'WORKDIR /app',
                'COPY package*.json ./',
                'RUN npm install',
                'COPY . .',
                'ARG VITE_API_URL=""',
                'ENV VITE_API_URL=$VITE_API_URL',
                ...buildEnvLines,
                'RUN npm run build',
                'RUN find dist -type f -name "*.js" -exec sed -i "s|http://localhost:5000||g" {} +',
                '',
                'FROM nginx:alpine',
                'RUN apk add --no-cache gettext',
                'COPY --from=build /app/dist /usr/share/nginx/html',
                'ENV API_PORT=80',
                `RUN mkdir -p /etc/nginx/templates && printf 'server { listen 80; location / { root /usr/share/nginx/html; try_files $uri $uri/ /index.html; } location /api/ { proxy_pass http://$API_BACKEND:$API_PORT; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; } }' > /etc/nginx/templates/default.conf.template`,
                'EXPOSE 80',
                'CMD envsubst \'\\$API_BACKEND \\$API_PORT\' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g \'daemon off;\'',
            ];
            content = header + lines.join('\n');
        } else {
            const startScript = pkg.scripts?.start ? 'npm start' : 'node server.js';
            const exposePort = backendPort || 5000;
            content = header + [
                'FROM node:20-alpine',
                'WORKDIR /app',
                'COPY package*.json ./',
                'RUN npm install',
                'COPY . .',
                ...buildEnvLines,
                `EXPOSE ${exposePort}`,
                `CMD ${startScript}`,
            ].join('\n');
        }
    } else if (fs.existsSync(path.join(dir, 'index.html'))) {
        content = header + 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80';
    }
    if (content) {
        fs.writeFileSync(dfPath, content);
    }
};

const getTasks = async () => {
    const url = `${process.env.API_SERVER_URL}/nodes/${process.env.NODE_ID}/tasks`;
    const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${process.env.KUBEX_TOKEN}` },
        timeout: 5000
    });
    return res.data.data;
};

const updateDeploymentStatus = async (depId, status, tunnelUrl = null) => {
    const url = `${process.env.API_SERVER_URL}/deployments/worker/status`;
    // We will add this helper route to the API server later
    await axios.post(url, { depId, status, tunnelUrl }, {
        headers: { Authorization: `Bearer ${process.env.KUBEX_TOKEN}` }
    }).catch(() => {});
};

const runLocalBuild = async (dep) => {
    console.log(`[Reconciler] Building ${dep.name}...`);
    try {
        await updateDeploymentStatus(dep._id, 'Building');
        const cloneDir = path.join(__dirname, '..', 'temp_builds', dep._id.toString());
        if (fs.existsSync(cloneDir)) {
            fs.rmSync(cloneDir, { recursive: true, force: true });
        }
        fs.mkdirSync(cloneDir, { recursive: true });

        let cloneUrl = dep.gitRepository;
        if (dep.gitToken) cloneUrl = `https://${dep.gitToken}@${cloneUrl.substring(8)}`;

        execSync(`git -c credential.helper= clone --depth 1 -b ${dep.gitBranch} "${cloneUrl}" "${cloneDir}"`, { stdio: 'ignore' });

        const targetDir = dep.gitSubfolder ? path.join(cloneDir, dep.gitSubfolder) : cloneDir;
        ensureDockerfile(targetDir, dep.containerPort, dep.envVars);

        const buildArgs = [];
        if (dep.envVars) {
            for (const ev of dep.envVars) {
                if (ev.key && ev.value) buildArgs.push('--build-arg', `${ev.key}=${ev.value}`);
            }
        }

        execSync(`docker build ${buildArgs.join(' ')} -t ${dep.image} .`, { cwd: targetDir, stdio: 'ignore' });
        fs.rmSync(cloneDir, { recursive: true, force: true });

        await updateDeploymentStatus(dep._id, 'Pending');
    } catch (e) {
        console.error(`[Reconciler] Build failed for ${dep.name}:`, e.message);
        await updateDeploymentStatus(dep._id, 'Failed');
    }
};

const startContainer = async (dep) => {
    console.log(`[Reconciler] Starting container for ${dep.name}...`);
    try {
        const envParams = (dep.envVars || []).map(ev => `${ev.key}=${ev.value}`);
        envParams.push(`KUBEX_DEPLOYMENT_ID=${dep._id}`);

        const portBinding = {};
        if (dep.staticHostPort) {
            portBinding[`${dep.containerPort}/tcp`] = [{ HostPort: dep.staticHostPort.toString() }];
        } else {
            portBinding[`${dep.containerPort}/tcp`] = [{ HostPort: '0' }]; // Auto-assign random port
        }

        const container = await docker.createContainer({
            Image: dep.image,
            Env: envParams,
            Labels: {
                'kubex.managed': 'true',
                'kubex.deployment': dep.name,
                'kubex.node': process.env.NODE_ID
            },
            HostConfig: {
                PortBindings: portBinding,
                Memory: 256 * 1024 * 1024,
                CpuQuota: 50000,
                CpuPeriod: 100000,
            }
        });

        await container.start();
        const data = await container.inspect();
        const mappedPort = data.NetworkSettings.Ports[`${dep.containerPort}/tcp`][0].HostPort;
        
        await updateDeploymentStatus(dep._id, 'Running');

        // AUTO-TUNNEL
        const subdomain = `kubex-${dep.name}-${process.env.NODE_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        startTunnel(container.id, mappedPort, subdomain, dep);

    } catch (e) {
        console.error(`[Reconciler] Failed to start container for ${dep.name}:`, e.message);
        await updateDeploymentStatus(dep._id, 'Failed');
    }
};

const startTunnel = async (containerId, port, subdomain, dep) => {
    if (activeTunnels.has(containerId)) return;
    console.log(`[Reconciler] Spawning Auto-Tunnel for port ${port}...`);
    
    try {
        const tunnel = await localtunnel({ port: parseInt(port), subdomain });
        tunnel.on('error', err => {
            console.error(`[Auto-Tunnel] Error for ${dep.name}:`, err);
        });
        tunnel.on('close', () => {
            console.log(`[Auto-Tunnel] Closed for ${dep.name}.`);
            activeTunnels.delete(containerId);
        });
        
        console.log(`[Auto-Tunnel] Live URL for ${dep.name}: ${tunnel.url}`);
        activeTunnels.set(containerId, { tunnel, url: tunnel.url, subdomain });
        await updateDeploymentStatus(dep._id, 'Running', tunnel.url);
    } catch (e) {
        console.error(`[Auto-Tunnel] Failed to create tunnel for ${dep.name}:`, e.message);
    }
};

let isReconciling = false;
const reconcile = async () => {
    if (isReconciling || !docker) return;
    isReconciling = true;

    try {
        const tasks = await getTasks();
        
        const containers = await docker.listContainers({
            filters: { label: ['kubex.managed=true', `kubex.node=${process.env.NODE_ID}`] }
        });

        for (const dep of tasks) {
            const runningCount = containers.filter(c => c.Labels['kubex.deployment'] === dep.name).length;

            if (dep.status === 'Building') {
                // If it's already running a build somewhere, wait.
                // Wait, if it just says 'Building' we should check if WE are building it.
                // We'll use 'Pending' to start a build.
                continue;
            }

            if (dep.status === 'Pending') {
                if (dep.gitRepository && !dep.image.includes('latest')) { // Needs build
                    runLocalBuild(dep);
                } else {
                    if (runningCount < dep.desiredReplicas) {
                        await startContainer(dep);
                    }
                }
            } else if (dep.status === 'Running' || dep.status === 'Scaling') {
                if (runningCount < dep.desiredReplicas) {
                    await startContainer(dep);
                } else if (runningCount > dep.desiredReplicas) {
                    // Stop one
                    const c = containers.find(c => c.Labels['kubex.deployment'] === dep.name);
                    if (c) {
                        const target = docker.getContainer(c.Id);
                        await target.stop({ t: 5 }).catch(()=>{});
                        await target.remove({ force: true }).catch(()=>{});
                        if (activeTunnels.has(c.Id)) {
                            activeTunnels.get(c.Id).tunnel.close();
                        }
                    }
                }
            }
        }

        // Garbage Collection: Delete containers that have no Deployment
        for (const c of containers) {
            const depName = c.Labels['kubex.deployment'];
            const exists = tasks.find(d => d.name === depName);
            if (!exists || exists.desiredReplicas === 0) {
                console.log(`[Reconciler] Garbage collecting orphaned container ${c.Id.slice(0,12)} (${depName})`);
                const target = docker.getContainer(c.Id);
                await target.stop({ t: 5 }).catch(()=>{});
                await target.remove({ force: true }).catch(()=>{});
                if (activeTunnels.has(c.Id)) {
                    activeTunnels.get(c.Id).tunnel.close();
                }
            }
        }

    } catch (e) {
        console.error('[Reconciler] Loop error:', e.message);
    }

    isReconciling = false;
};

const getActiveTunnels = () => Array.from(activeTunnels.values()).map(t => t.url);

module.exports = { reconcile, getActiveTunnels };
