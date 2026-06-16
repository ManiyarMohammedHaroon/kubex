const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const TunnelManager = require('./TunnelManager');
const Docker = require('dockerode');
const AIService = require('./AIService');
const ContainerRunner = require('./ContainerRunner');

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
const healthFailures = new Map(); // containerId -> count
const activeBuilds = new Set(); // dep._id -> boolean

// Helper: Ensure Dockerfile exists before building
const ensureDockerfile = async (dir, backendPort, envVars = []) => {
    backendPort = backendPort || 3000;
    const dfPath = path.join(dir, 'Dockerfile');
    const isKubexGen = fs.existsSync(dfPath) && fs.readFileSync(dfPath, 'utf8').includes('# KUBEX-GENERATED');
    if (fs.existsSync(dfPath) && !isKubexGen) return;

    // Try AI generation first
    const aiDockerfile = await AIService.generateDockerfile(dir, backendPort, envVars);
    if (aiDockerfile) {
        console.log('[Reconciler] Using AI-generated Dockerfile');
        fs.writeFileSync(dfPath, aiDockerfile);
        return;
    }

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
    const url = `${process.env.API_SERVER_URL}/api/nodes/${process.env.NODE_ID}/tasks`;
    const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${process.env.KUBEX_TOKEN}` },
        timeout: 5000
    });
    return res.data.data;
};

const updateDeploymentStatus = async (depId, status, tunnelUrl = null, containerInfo = null, error = null) => {
    const url = `${process.env.API_SERVER_URL}/api/deployments/worker/status`;
    // We will add this helper route to the API server later
    await axios.post(url, { depId, status, tunnelUrl, containerInfo, error }, {
        headers: { Authorization: `Bearer ${process.env.KUBEX_TOKEN}` }
    }).catch(() => {});
};

const buildContainer = async (dep) => {
    let buildOutput = '';
    if (activeBuilds.has(dep._id)) return;
    activeBuilds.add(dep._id);
    console.log(`[Reconciler] 🏗️ Starting build for deployment: ${dep.name}`);
    
    try {
        const cloneDir = path.join(__dirname, '..', '..', 'temp_builds', dep._id.toString());
        if (fs.existsSync(cloneDir)) {
            fs.rmSync(cloneDir, { recursive: true, force: true });
        }
        fs.mkdirSync(cloneDir, { recursive: true });

        let cloneUrl = dep.gitRepository;
        if (dep.gitToken && cloneUrl.startsWith('https://')) {
            cloneUrl = `https://${dep.gitToken}@${cloneUrl.substring(8)}`;
        }

        console.log(`[Reconciler] 📥 Cloning repository...`);
        await new Promise((resolve, reject) => {
            const git = spawn('git', ['-c', 'credential.helper=', '-c', 'core.fsmonitor=false', 'clone', '--depth', '1', '-b', dep.gitBranch, cloneUrl, cloneDir], {
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
                windowsHide: true
            });
            git.on('error', err => reject(new Error(`Git spawn error: ${err.message}`)));
            git.on('close', code => code === 0 ? resolve() : reject(new Error(`Git clone failed with code ${code}`)));
        });

        const targetDir = dep.gitSubfolder ? path.join(cloneDir, dep.gitSubfolder) : cloneDir;
        if (!fs.existsSync(targetDir)) {
            throw new Error(`Target directory "${dep.gitSubfolder}" not found.`);
        }

        await ensureDockerfile(targetDir, dep.containerPort, dep.envVars);

        // Determine the target image tag
        let imageTag = dep.image;
        if (!imageTag || imageTag.includes('kubex-deployment')) {
            if (dep.dockerHubUsername && dep.dockerHubToken) {
                // Push to Docker Hub
                imageTag = `${dep.dockerHubUsername.toLowerCase()}/${dep.name}:latest`;
            } else {
                imageTag = `kubex-deployment-${dep._id}`;
            }
        }
        
        const buildArgs = [];
        if (dep.envVars) {
            for (const ev of dep.envVars) {
                if (ev.key && ev.value) buildArgs.push('--build-arg', `${ev.key}=${ev.value}`);
            }
        }

        console.log(`[Reconciler] 🐳 Building Docker Image: ${imageTag}`);
        const dockerBuild = spawn('docker', ['build', '--no-cache', ...buildArgs, '-t', imageTag, '.'], {
            cwd: targetDir, windowsHide: true
        });
        
        dockerBuild.stdout.on('data', data => buildOutput += data.toString());
        dockerBuild.stderr.on('data', data => buildOutput += data.toString());
        
        await new Promise((resolve, reject) => {
            dockerBuild.on('error', err => reject(new Error(`Docker spawn error: ${err.message}`)));
            dockerBuild.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`Docker build failed with code ${code}`));
            });
        });

        if (dep.dockerHubUsername && dep.dockerHubToken) {
            console.log(`[Reconciler] 🔐 Logging into Docker Hub as ${dep.dockerHubUsername}...`);
            execSync(`docker login -u ${dep.dockerHubUsername} -p ${dep.dockerHubToken}`, { stdio: 'ignore' });
            
            console.log(`[Reconciler] ☁️ Pushing ${imageTag} to Docker Hub...`);
            execSync(`docker push ${imageTag}`);

            console.log(`[Reconciler] ✅ Push successful! Notifying Control Plane.`);
            const url = `${process.env.API_SERVER_URL}/api/deployments/${dep._id}/build-complete`;
            
            // Retry loop to handle intermittent Docker Desktop "socket hang up" network glitches
            let retries = 3;
            while (retries > 0) {
                try {
                    await axios.post(url, { image: imageTag }, {
                        headers: { Authorization: `Bearer ${process.env.KUBEX_TOKEN}` },
                        timeout: 10000
                    });
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) throw err;
                    console.log(`[Reconciler] ⚠️ Notification failed (${err.message}). Retrying...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        } else {
            console.log(`[Reconciler] ✅ Local build successful for ${dep.name}. Changing status to Pending.`);
            await updateDeploymentStatus(dep._id, 'Pending');
            // We still need to set the image locally so startContainer knows what to run
            const url = `${process.env.API_SERVER_URL}/api/deployments/${dep._id}/build-complete`;
            
            let retries = 3;
            while (retries > 0) {
                try {
                    await axios.post(url, { image: imageTag }, {
                        headers: { Authorization: `Bearer ${process.env.KUBEX_TOKEN}` },
                        timeout: 10000
                    });
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) throw err;
                    console.log(`[Reconciler] ⚠️ Notification failed (${err.message}). Retrying...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    } catch (e) {
        console.error(`[Reconciler] ❌ Build failed for ${dep.name}:`, e.message);
        // Only keep the last 50 lines of build output to prevent huge payloads
        const tailOutput = buildOutput.split('\n').slice(-50).join('\n');
        await updateDeploymentStatus(dep._id, 'Failed', null, null, `Build failed: ${e.message}\nLogs:\n${tailOutput}`);
    } finally {
        activeBuilds.delete(dep._id);
        const cloneDir = path.join(__dirname, '..', '..', 'temp_builds', dep._id.toString());
        if (fs.existsSync(cloneDir)) {
            try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch (e) {}
        }
    }
};



const startContainer = async (dep) => {
    console.log(`[Reconciler] Starting container for ${dep.name}...`);
    try {
        try {
            if (dep.dockerHubUsername && dep.dockerHubToken) {
                console.log(`[Reconciler] 🔐 Authenticating with registry as ${dep.dockerHubUsername}...`);
                execSync(`docker login -u ${dep.dockerHubUsername} -p ${dep.dockerHubToken}`, { stdio: 'ignore' });
            }
            console.log(`[Reconciler] Pulling image ${dep.image} from registry...`);
            execSync(`docker pull ${dep.image}`, { stdio: 'ignore' });
        } catch (e) {
            console.warn(`[Reconciler] Pull failed for ${dep.image}, falling back to local cache if present.`);
        }
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
                NetworkMode: 'kubex_kubex-net'
            },
            NetworkingConfig: {
                EndpointsConfig: {
                    'kubex_kubex-net': {
                        Aliases: [dep.name]
                    }
                }
            }
        });

        await container.start();
        const data = await container.inspect();
        const mappedPort = data.NetworkSettings.Ports[`${dep.containerPort}/tcp`][0].HostPort;
        
        const containerInfo = {
            containerId: container.id,
            nodeId: process.env.NODE_ID,
            ip: data.NetworkSettings.IPAddress || '',
            hostPort: mappedPort
        };
        await updateDeploymentStatus(dep._id, 'Running', null, containerInfo);

        // AUTO-TUNNEL
        const subdomain = `kubex-${dep.name}-${process.env.NODE_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        startTunnel(container.id, mappedPort, subdomain, dep);

    } catch (e) {
        console.error(`[Reconciler] Failed to start container for ${dep.name}:`, e.stack || e);
        await updateDeploymentStatus(dep._id, 'Failed', null, null, e.message);
    }
};

const startTunnel = async (containerId, port, subdomain, dep) => {
    if (activeTunnels.has(containerId)) return;
    
    const tunnelHost = process.env.RUNNING_IN_DOCKER === 'true' ? 'host.docker.internal' : 'localhost';
    
    try {
        const tunnelObj = await TunnelManager.createTunnel(containerId, port, subdomain, dep.name, tunnelHost);
        
        console.log(`[Auto-Tunnel] ✅ Live URL for ${dep.name}: ${tunnelObj.url}`);
        activeTunnels.set(containerId, { tunnel: tunnelObj, url: tunnelObj.url, subdomain });
        await updateDeploymentStatus(dep._id, 'Running', tunnelObj.url).catch(() => {});
    } catch (e) {
        console.error(`[Auto-Tunnel] ❌ Failed to create tunnel for ${dep.name}:`, e.message);
    }
};

let isReconciling = false;
const reconcile = async () => {
    if (isReconciling || !docker) return;
    isReconciling = true;

    try {
        const tasks = await getTasks();
        
        const containers = await docker.listContainers({
            all: true,
            filters: { label: ['kubex.managed=true', `kubex.node=${process.env.NODE_ID}`] }
        });

        // Clean up exited containers and sync database status with Crash Logs (Death Rattle)
        const exitedContainers = containers.filter(c => c.State === 'exited' || c.Status.toLowerCase().includes('exited'));
        for (const c of exitedContainers) {
            const depName = c.Labels['kubex.deployment'];
            const dep = tasks.find(d => d.name === depName);
            console.log(`[Reconciler] 🚨 Cleaning up crashed container ${c.Id.slice(0, 12)} (${depName}). Fetching crash logs...`);
            
            // Fetch the last 50 lines of logs before the container died
            const crashLogs = await ContainerRunner.getContainerLogs(c.Id, 50);
            
            const target = docker.getContainer(c.Id);
            await target.remove({ force: true }).catch(() => {});
            
            // Clean up health tracking
            healthFailures.delete(c.Id);
            
            if (dep) {
                // Pass the crash logs as the error parameter so it appears in dep.lastError on the UI!
                await updateDeploymentStatus(dep._id, 'Stopped', null, { containerId: c.Id }, crashLogs || 'Container exited with no logs');
            }
        }

        // Filter to only active running containers for reconciliation count
        const activeContainers = containers.filter(c => c.State === 'running' || c.State === 'created');

        for (const dep of tasks) {
            const runningCount = activeContainers.filter(c => c.Labels['kubex.deployment'] === dep.name).length;

            if (dep.status === 'Building') {
                // Kick off the build process locally
                buildContainer(dep);
                continue;
            }

            if (dep.status === 'Pending') {
                const oldContainers = activeContainers.filter(c => c.Labels['kubex.deployment'] === dep.name);
                if (oldContainers.length > 0) {
                    console.log(`[Reconciler] 🧹 Sweeping ${oldContainers.length} old containers for ${dep.name}...`);
                    for (const c of oldContainers) {
                        const target = docker.getContainer(c.Id);
                        await target.stop({ t: 5 }).catch(()=>{});
                        await target.remove({ force: true }).catch(()=>{});
                        if (activeTunnels.has(c.Id)) {
                            activeTunnels.get(c.Id).tunnel.close();
                            activeTunnels.delete(c.Id);
                        }
                    }
                } else {
                    if (runningCount < dep.desiredReplicas) {
                        await startContainer(dep);
                    }
                }
            } else if (dep.status === 'Running' || dep.status === 'Scaling' || dep.status === 'Degraded') {
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
                        await updateDeploymentStatus(dep._id, 'Stopped', null, { containerId: c.Id });
                    }
                }

                // Auto-Tunnel Reconnect Logic:
                // If a container is running but its tunnel crashed, restart the tunnel!
                const myContainers = activeContainers.filter(c => c.Labels['kubex.deployment'] === dep.name);
                for (const c of myContainers) {
                    let mappedPort = null;
                    try {
                        const target = docker.getContainer(c.Id);
                        const data = await target.inspect();
                        if (data.State.Running) {
                            mappedPort = data.NetworkSettings.Ports[`${dep.containerPort}/tcp`]?.[0]?.HostPort;
                            
                            // 1. Auto-Tunnel Check
                            if (!activeTunnels.has(c.Id) && mappedPort) {
                                const subdomain = `kubex-${dep.name}-${process.env.NODE_ID}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                                console.log(`[Reconciler] 🔄 Tunnel for ${dep.name} is missing. Reconnecting...`);
                                startTunnel(c.Id, mappedPort, subdomain, dep);
                            }
                            
                            // 2. L7 Application Health Check
                            if (dep.healthCheck && dep.healthCheck.enabled && mappedPort) {
                                try {
                                    // Make a very quick HTTP request to the health path
                                    await axios.get(`http://localhost:${mappedPort}${dep.healthCheck.path}`, { timeout: 2000 });
                                    // If it succeeds, reset the failure count
                                    healthFailures.set(c.Id, 0);
                                } catch (healthErr) {
                                    const failures = (healthFailures.get(c.Id) || 0) + 1;
                                    healthFailures.set(c.Id, failures);
                                    console.log(`[Reconciler] ⚠️ Health check failed for ${dep.name} (${failures}/${dep.healthCheck.maxRetries || 3}): ${healthErr.message}`);
                                    
                                    if (failures >= (dep.healthCheck.maxRetries || 3)) {
                                        console.log(`[Reconciler] ☠️ Container ${c.Id.slice(0, 12)} failed health checks! Assassinating...`);
                                        // Fetch logs BEFORE killing it so we can see why it froze
                                        const freezeLogs = await ContainerRunner.getContainerLogs(c.Id, 50);
                                        await target.kill().catch(() => {});
                                        healthFailures.delete(c.Id);
                                        await updateDeploymentStatus(dep._id, 'Failed', null, null, `Health check failed permanently. Last logs:\n${freezeLogs}`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // Container might have died exactly as we tried to inspect it
                    }
                }
            }
        } // End of tasks loop

        // Garbage Collection: Delete containers that have no Deployment, or if Deployment is Pending a rebuild
        for (const c of containers) {
            const depName = c.Labels['kubex.deployment'];
            const exists = tasks.find(d => d.name === depName);
            if (!exists || exists.desiredReplicas === 0 || exists.status === 'Pending') {
                console.log(`[Reconciler] Garbage collecting container ${c.Id.slice(0,12)} (${depName}) due to state change...`);
                const target = docker.getContainer(c.Id);
                await target.stop({ t: 5 }).catch(()=>{});
                await target.remove({ force: true }).catch(()=>{});
                if (activeTunnels.has(c.Id)) {
                    activeTunnels.get(c.Id).tunnel.close();
                }
            }
        }

    } catch (e) {
        console.error('[Reconciler] Loop error:', e.stack || e);
    }

    isReconciling = false;
};

const getActiveTunnels = () => Array.from(activeTunnels.values()).map(t => t.url);

module.exports = { reconcile, getActiveTunnels };
