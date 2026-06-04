/**
 * @file routes/deployments.js - REST API routes for managing Deployments.
 *
 * All routes are mounted at /api/deployments (see index.js).
 *
 * Overview of endpoints:
 *   GET    /               - list all deployments
 *   GET    /:id            - get a single deployment by MongoDB _id
 *   POST   /               - create a new deployment (triggers reconciliation)
 *   PUT    /:id/scale      - manually set desired replica count
 *   PATCH  /:id            - update autoscaling settings
 *   DELETE /:id            - terminate and remove a deployment + all containers
 */
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

/**
 * Bulletproof git clone using spawn and 'exit' event.
 * Fixes the issue on Windows where git spawns background daemons (like credential-manager or fsmonitor)
 * that keep stdout/stderr pipes open, causing child_process.exec() to hang forever.
 */
const spawnGitClone = (branch, url, targetPath) => {
    return new Promise((resolve, reject) => {
        const git = spawn('git', [
            '-c', 'credential.helper=', 
            '-c', 'core.fsmonitor=false', 
            'clone', '--depth', '1', 
            '-b', branch, 
            url, targetPath
        ], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
            windowsHide: true
        });

        let errOut = '';
        if (git.stderr) {
            git.stderr.on('data', data => { errOut += data.toString(); });
        }

        // 'exit' fires as soon as the main git.exe process dies, ignoring any background children.
        git.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(errOut || `Git clone exited with code ${code}`));
        });
        
        git.on('error', (err) => reject(err));
        
        // Safety timeout (120s)
        setTimeout(() => {
            try { git.kill(); } catch (e) {}
            reject(new Error("Git clone timed out after 120s"));
        }, 120000);
    });
};

const Deployment = require('../models/Deployment');
const Event = require('../models/Event');
const User = require('../models/User');


const auth = require('../middleware/auth');

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

const ensureDockerfile = (dir, backendPort, envVars = []) => {
    backendPort = backendPort || 3000;
    const dfPath = path.join(dir, 'Dockerfile');
    const isKubexGen = fs.existsSync(dfPath) && fs.readFileSync(dfPath, 'utf8').includes('# KUBEX-GENERATED');
    if (fs.existsSync(dfPath) && !isKubexGen) return; // user owns this Dockerfile

    const header = '# KUBEX-GENERATED\n';
    let content = '';
    
    // Convert KUBEX envVars into Dockerfile ARG and ENV lines
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
            // Vite frontend: multi-stage build + nginx with runtime envsubst
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
            // Node.js backend
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
        console.log(`[FolderDeploy] ${isKubexGen ? 'Updating' : 'Generating'} Dockerfile for: ${dir}`);
        fs.writeFileSync(dfPath, content);
    }
};

const triggerGitBuild = async (dep) => {
    const buildsLogDir = path.join(__dirname, '..', 'logs', 'builds');
    if (!fs.existsSync(buildsLogDir)) {
        fs.mkdirSync(buildsLogDir, { recursive: true });
    }
    const logFilePath = path.join(buildsLogDir, `${dep._id}.log`);
    
    // Clear any previous logs
    fs.writeFileSync(logFilePath, `🧪 KUBEX Git Build Started for "${dep.name}"\n`);
    
    const writeLog = (msg) => {
        fs.appendFileSync(logFilePath, `[${new Date().toLocaleTimeString()}] ${msg}\n`);
        console.log(`[GitBuild - ${dep.name}] ${msg}`);
    };

    // Prepare workspace directory
    const tempBuildsDir = path.join(__dirname, '..', '..', 'temp_git_builds');
    if (!fs.existsSync(tempBuildsDir)) {
        fs.mkdirSync(tempBuildsDir, { recursive: true });
    }
    // Use unique workspace subdirectory per-build to avoid race conditions
    const workspacePath = path.join(tempBuildsDir, `${dep._id.toString()}_${Date.now()}`);
    
    const cleanWorkspace = () => {
        try {
            if (fs.existsSync(workspacePath)) {
                fs.rmSync(workspacePath, { recursive: true, force: true });
                writeLog('Cleaned up build workspace folder.');
            }
        } catch (err) {
            writeLog(`⚠️ Workspace cleanup warning: ${err.message}`);
        }
    };

    // Construct clone URL
    let cloneUrl = dep.gitRepository;
    if (dep.gitToken) {
        if (cloneUrl.startsWith('https://')) {
            cloneUrl = `https://${dep.gitToken}@${cloneUrl.substring(8)}`;
        }
    }

    writeLog(`Cloning repository "${dep.gitRepository}" (branch: "${dep.gitBranch}")...`);
    
    try {
        const { execSync } = require('child_process');
        execSync(`git -c credential.helper= -c core.fsmonitor=false clone --depth 1 -b ${dep.gitBranch} "${cloneUrl}" "${workspacePath}"`, {
            stdio: 'ignore',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
            windowsHide: true
        });
        writeLog('✅ Repository cloned successfully.');
    } catch (error) {
        writeLog(`❌ Git clone failed:\n${error.message}`);
        cleanWorkspace();
        await Deployment.findByIdAndUpdate(dep._id, { $set: { status: 'Failed' } });
        await Event.create({
            type: 'Error', reason: 'GitCloneFailed',
            message: `Git clone failed for "${dep.name}". Check build logs.`,
            involvedObject: { kind: 'Deployment', name: dep.name }
        });
        return;
    }

    try {
        // App Type and Port Detection
        writeLog('Analyzing codebase type & port requirements...');
        const buildContextPath = dep.gitSubfolder ? path.join(workspacePath, dep.gitSubfolder) : workspacePath;
        writeLog(`Build Context path resolved to: ${buildContextPath}`);

        let port = dep.containerPort || 80;
        const pkgPath = path.join(buildContextPath, 'package.json');
        
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const hasVite = !!(pkg.dependencies?.vite || pkg.devDependencies?.vite);
            if (hasVite) {
                writeLog('Detected App Type: React (Vite)');
                port = 80;
            } else {
                writeLog('Detected App Type: Node.js Backend');
                port = dep.containerPort || 3000;
            }
        } else if (fs.existsSync(path.join(buildContextPath, 'index.html'))) {
            writeLog('Detected App Type: Static Web Page');
            port = 80;
        }

        // Write/Generate Dockerfile
        writeLog(`Checking Dockerfile in cloned source...`);
        ensureDockerfile(buildContextPath, port, dep.envVars);
        
        const dfPathFinal = path.join(buildContextPath, 'Dockerfile');
        if (!fs.existsSync(dfPathFinal)) {
            throw new Error('Could not auto-generate Dockerfile. Add a Dockerfile manually.');
        } else {
            // Smart patch: upgrade node:18 to node:20 to fix crypto bugs
            let dContent = fs.readFileSync(dfPathFinal, 'utf8');
            if (dContent.includes('FROM node:18') && dContent.includes('server.js')) {
                dContent = dContent.replace(/FROM node:18/g, 'FROM node:20');
                fs.writeFileSync(dfPathFinal, dContent);
                writeLog('âš¡ Auto-patched user Dockerfile from Node 18 to Node 20 for MongoDB compatibility.');
            }
        }

        writeLog('✅ Dockerfile verified.');
        writeLog(`STARTING DOCKER BUILD: "${dep.image}"...`);

        // Convert dep.envVars to --build-arg flags
        let buildArgsFlags = '';
        if (dep.envVars && dep.envVars.length > 0) {
            for (const ev of dep.envVars) {
                if (ev.key) {
                    // escape double quotes in value if any
                    const val = (ev.value || '').replace(/"/g, '\\"');
                    buildArgsFlags += ` --build-arg ${ev.key}="${val}"`;
                }
            }
        }

        // Compile logs inside the Docker build process
        const buildProcess = exec(`docker build ${buildArgsFlags} -t ${dep.image} "${buildContextPath}"`, { maxBuffer: 1024 * 1024 * 50 });

        buildProcess.stdout.on('data', (data) => {
            fs.appendFileSync(logFilePath, data);
        });
        buildProcess.stderr.on('data', (data) => {
            fs.appendFileSync(logFilePath, data);
        });

        buildProcess.on('close', async (code) => {
            cleanWorkspace();

            if (code !== 0) {
                writeLog(`❌ Docker build failed with exit code: ${code}`);
                await Deployment.findByIdAndUpdate(dep._id, { $set: { status: 'Failed' } });
                await Event.create({
                    type: 'Error', reason: 'GitBuildFailed',
                    message: `Docker build failed for "${dep.name}". Check build logs.`,
                    involvedObject: { kind: 'Deployment', name: dep.name }
                });
                return;
            }

            writeLog('✅ Docker build completed successfully!');
            writeLog(`Pushing image "${dep.image}" to Docker Hub...`);
            
            const pushProcess = exec(`docker push ${dep.image}`);
            pushProcess.stdout.on('data', (data) => fs.appendFileSync(logFilePath, data));
            pushProcess.stderr.on('data', (data) => fs.appendFileSync(logFilePath, data));
            
            pushProcess.on('close', async (pCode) => {
                if (pCode !== 0) {
                    writeLog(`❌ Docker push failed with exit code: ${pCode}`);
                    await Deployment.findByIdAndUpdate(dep._id, { $set: { status: 'Failed' } });
                    await Event.create({
                        type: 'Error', reason: 'PushFailed',
                        message: `Docker push failed for "${dep.name}". Ensure credentials are set.`,
                        involvedObject: { kind: 'Deployment', name: dep.name }
                    });
                } else {
                    writeLog('✅ Docker image pushed successfully!');
                    finishGitDeploy(dep, logFilePath);
                }
            });
        });
    } catch (innerErr) {
        writeLog(`❌ Error during build setup: ${innerErr.message}`);
        cleanWorkspace();
        await Deployment.findByIdAndUpdate(dep._id, { $set: { status: 'Failed' } });
    }
};

const finishGitDeploy = async (dep, logFilePath) => {
    fs.appendFileSync(logFilePath, `[${new Date().toLocaleTimeString()}] ✅ Build successful. Deploying containers in cluster...\n`);
    await Deployment.findByIdAndUpdate(dep._id, { $set: { status: 'Pending' } });
    await Event.create({
        type: 'Normal', reason: 'BuildComplete',
        message: `Git build complete. Starting "${dep.name}"...`,
        involvedObject: { kind: 'Deployment', name: dep.name }
    });
    const fresh = await Deployment.findById(dep._id);
};

// Protect all deployment routes under this router
router.use(auth);

// --- POST /api/deployments/worker/status --------------------------------
// Called by the Worker Agent to update the status of a deployment and provide the localtunnel URL.
router.post('/worker/status', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();
        // Just verify any valid node token for now
        const Node = require('../models/Node');
        const node = await Node.findOne({ token });
        if (!node) return res.status(403).json({ success: false, error: 'Forbidden' });

        const { depId, status, tunnelUrl } = req.body;
        const updateDoc = { status };
        if (tunnelUrl) updateDoc.tunnelUrl = tunnelUrl;
        
        // Update actualReplicas based on status
        if (status === 'Running') updateDoc.actualReplicas = 1; // Assuming 1 replica for local tunnels
        if (status === 'Failed' || status === 'Pending') updateDoc.actualReplicas = 0;

        await Deployment.findByIdAndUpdate(depId, { $set: updateDoc });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- GET /api/deployments -----------------------------------------------
router.get('/', async (req, res) => {
    try {
        const query = req.user.role === 'viewer'
            ? { viewers: req.user._id }
            : { owner: req.user._id };
        const deployments = await Deployment.find(query).sort({ createdAt: -1 });
        res.json({ success: true, data: deployments });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- GET /api/deployments/:id -------------------------------------------
router.get('/:id', async (req, res) => {
    try {
        const query = req.user.role === 'viewer'
            ? { _id: req.params.id, viewers: req.user._id }
            : { _id: req.params.id, owner: req.user._id };
        const dep = await Deployment.findOne(query);
        if (!dep) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: dep });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- POST /api/deployments ----------------------------------------------
router.post('/', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot create deployments.' });
    }
    try {
        const {
            name,
            desiredReplicas = 1, resourceLimits = {}, envVars = [],
            autoscalingEnabled = false, minReplicas = 1, maxReplicas = 10,
            cpuThresholdUp = 80, cpuThresholdDown = 20,
            staticHostPort = '', containerPort = 80,
            gitRepository = '', gitBranch = 'main', gitToken = '', autoDeploy = true,
            dockerHubUsername = '', healthCheck = { enabled: false, path: '/health', maxRetries: 3 }
        } = req.body;

        if (autoscalingEnabled && cpuThresholdUp <= cpuThresholdDown) {
            return res.status(400).json({ success: false, error: 'Scale-up threshold must be greater than scale-down threshold.' });
        }
        if (!name) {
            return res.status(400).json({ success: false, error: 'Deployment base name is required' });
        }
        if (!gitRepository) {
            return res.status(400).json({ success: false, error: 'KUBEX only supports Git-based deployments. gitRepository is required.' });
        }
        if (!dockerHubUsername) {
            return res.status(400).json({ success: false, error: 'dockerHubUsername is required for public built images.' });
        }

        // Fast shallow scan clone to detect directory structure
        let cloneUrl = gitRepository;
        if (gitToken) {
            if (cloneUrl.startsWith('https://')) {
                cloneUrl = `https://${gitToken}@${cloneUrl.substring(8)}`;
            }
        }

        const tempScansDir = path.join(__dirname, '..', '..', 'temp_git_scans');
        if (!fs.existsSync(tempScansDir)) {
            fs.mkdirSync(tempScansDir, { recursive: true });
        }
        const tempScanPath = path.join(tempScansDir, `${Date.now()}_${Math.random().toString(36).substring(7)}`);

        console.log(`[API Scanner] Running shallow clone scan for "${gitRepository}"...`);
        try {
            const { execSync } = require('child_process');
            execSync(`git -c credential.helper= -c core.fsmonitor=false clone --depth 1 -b ${gitBranch} "${cloneUrl}" "${tempScanPath}"`, {
                stdio: 'ignore',
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
                windowsHide: true
            });
        } catch (cloneErr) {
            console.error(`[API Scanner] Shallow clone failed: ${cloneErr.message}`);
            return res.status(400).json({ success: false, error: `Failed to clone repository: ${cloneErr.message}` });
        }

        // Case-insensitive folder detection: read actual directory entries to find
        // the real folder name (handles 'Frontend', 'frontend', 'FRONTEND' etc.)
        const scanEntries = fs.readdirSync(tempScanPath);
        const frontendEntry = scanEntries.find(e => e.toLowerCase() === 'frontend' && fs.statSync(path.join(tempScanPath, e)).isDirectory());
        const backendEntry = scanEntries.find(e => e.toLowerCase() === 'backend' && fs.statSync(path.join(tempScanPath, e)).isDirectory());
        const frontendExists = !!frontendEntry;
        const backendExists = !!backendEntry;
        const isMonorepo = frontendExists && backendExists;
        // Store the REAL folder names (preserving original casing from the repo)
        const frontendFolder = frontendEntry || 'frontend';
        const backendFolder = backendEntry || 'backend';

        // Cleanup shallow scan clone folder immediately
        try {
            if (fs.existsSync(tempScanPath)) {
                fs.rmSync(tempScanPath, { recursive: true, force: true });
            }
        } catch (cleanupErr) {
            console.error('[API Scanner] Temp scan cleanup error:', cleanupErr.message);
        }

        const { v4: uuidv4 } = require('uuid');
        const webhookSecret = uuidv4();

        if (isMonorepo) {
            console.log(`[API Scanner] Monorepo detected with "${frontendFolder}/" and "${backendFolder}/". Splitting deployments...`);
            
            const existingFrontend = await Deployment.findOne({ name: `${name}-frontend` });
            const existingBackend = await Deployment.findOne({ name: `${name}-backend` });
            if (existingFrontend || existingBackend) {
                return res.status(409).json({ success: false, error: `One or both of the monorepo deployments ("${name}-frontend" / "${name}-backend") already exist` });
            }

            // Create Frontend Deployment
            const frontendImage = `${dockerHubUsername}/${name}-frontend:latest`;
            const frontendDeployment = await Deployment.create({
                name: `${name}-frontend`,
                image: frontendImage,
                desiredReplicas,
                resourceLimits: { cpu: resourceLimits.cpu || '0.5', memory: resourceLimits.memory || '128m' },
                envVars: [...(envVars || []), { key: 'API_BACKEND', value: `${name}-backend` }], // AUTO-CONNECT TO BACKEND
                previewDomain: `preview-${name}-frontend.localhost:8080`,
                autoscalingEnabled, minReplicas, maxReplicas,
                cpuThresholdUp, cpuThresholdDown,
                staticHostPort: '', // auto-assign to avoid conflict
                containerPort: 80,
                status: 'Building',
                owner: req.user._id,
                viewers: req.body.viewers || [],
                gitRepository, gitBranch, gitToken, webhookSecret, autoDeploy,
                gitSubfolder: frontendFolder, // Use actual folder name from repo
                dockerHubUsername, healthCheck
            });

            // Create Backend Deployment
            const backendImage = `${dockerHubUsername}/${name}-backend:latest`;
            const backendDeployment = await Deployment.create({
                name: `${name}-backend`,
                image: backendImage,
                desiredReplicas,
                resourceLimits: { cpu: resourceLimits.cpu || '0.5', memory: resourceLimits.memory || '128m' },
                envVars,
                previewDomain: `preview-${name}-backend.localhost:8080`,
                autoscalingEnabled, minReplicas, maxReplicas,
                cpuThresholdUp, cpuThresholdDown,
                staticHostPort: '', // auto-assign to avoid conflict
                containerPort: 3000,
                status: 'Building',
                owner: req.user._id,
                viewers: req.body.viewers || [],
                gitRepository, gitBranch, gitToken, webhookSecret, autoDeploy,
                gitSubfolder: backendFolder, // Use actual folder name from repo
                dockerHubUsername, healthCheck
            });

            await Event.create({
                type: 'Normal', reason: 'DeploymentCreated',
                message: `Monorepo split deployment: "${name}-frontend" created from subfolder "${frontendFolder}"`,
                involvedObject: { kind: 'Deployment', name: `${name}-frontend` },
            });

            await Event.create({
                type: 'Normal', reason: 'DeploymentCreated',
                message: `Monorepo split deployment: "${name}-backend" created from subfolder "${backendFolder}"`,
                involvedObject: { kind: 'Deployment', name: `${name}-backend` },
            });



            return res.status(201).json({ success: true, data: [frontendDeployment, backendDeployment] });
        } else {
            console.log(`[API Scanner] Standard repository structure detected.`);
            
            const existing = await Deployment.findOne({ name });
            if (existing) {
                return res.status(409).json({ success: false, error: `Deployment "${name}" already exists` });
            }

            if (staticHostPort) {
                const portConflict = await Deployment.findOne({ staticHostPort });
                if (portConflict) {
                    return res.status(409).json({ success: false, error: `Static port ${staticHostPort} is already reserved by deployment "${portConflict.name}"` });
                }
            }

            const singleImage = `${dockerHubUsername}/${name}:latest`;
            const deployment = await Deployment.create({
                name,
                image: singleImage,
                desiredReplicas,
                resourceLimits: { cpu: resourceLimits.cpu || '0.5', memory: resourceLimits.memory || '128m' },
                envVars,
                previewDomain: `preview-${name}.localhost:8080`,
                autoscalingEnabled, minReplicas, maxReplicas,
                cpuThresholdUp, cpuThresholdDown,
                staticHostPort,
                containerPort,
                status: 'Building',
                owner: req.user._id,
                viewers: req.body.viewers || [],
                gitRepository, gitBranch, gitToken, webhookSecret, autoDeploy,
                gitSubfolder: '',
                dockerHubUsername, healthCheck
            });

            await Event.create({
                type: 'Normal', reason: 'DeploymentCreated',
                message: `Deployment "${name}" created with ${desiredReplicas} desired replicas`,
                involvedObject: { kind: 'Deployment', name },
            });



            return res.status(201).json({ success: true, data: [deployment] });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- PUT /api/deployments/:id/scale -------------------------------------
router.put('/:id/scale', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot scale deployments.' });
    }
    try {
        const { replicas } = req.body;
        if (replicas === undefined || replicas < 0) {
            return res.status(400).json({ success: false, error: 'replicas must be >= 0' });
        }

        const dep = await Deployment.findOne({ _id: req.params.id, owner: req.user._id });
        if (!dep) return res.status(404).json({ success: false, error: 'Not found' });

        const oldCount = dep.desiredReplicas;
        const newCount = Math.min(replicas, dep.maxReplicas);

        await Deployment.findByIdAndUpdate(dep._id, { $set: { desiredReplicas: newCount, status: 'Scaling' } });

        await Event.create({
            type: 'Normal', reason: 'ManualScale',
            message: `Deployment "${dep.name}" scaled from ${oldCount} to ${newCount}`,
            involvedObject: { kind: 'Deployment', name: dep.name },
        });

        const updatedDep = await Deployment.findById(dep._id);

        res.json({ success: true, data: updatedDep });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- PATCH /api/deployments/:id -----------------------------------------
router.patch('/:id', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot modify deployments.' });
    }
    try {
        const allowed = ['autoscalingEnabled', 'minReplicas', 'maxReplicas', 'cpuThresholdUp', 'cpuThresholdDown', 'viewers'];
        const updates = {};
        allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

        const dep = await Deployment.findOneAndUpdate({ _id: req.params.id, owner: req.user._id }, { $set: updates }, { new: true });
        if (!dep) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: dep });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- POST /api/deployments/:id/rebalance --------------------------------
router.post('/:id/rebalance', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot rebalance deployments.' });
    }
    try {
        const dep = await Deployment.findOne({ _id: req.params.id, owner: req.user._id });
        if (!dep) return res.status(404).json({ success: false, error: 'Not found' });

        console.log(`[API] Rebalancing deployment "${dep.name}"...`);

        await Deployment.findByIdAndUpdate(dep._id, { $set: { containers: [], status: 'Scaling' } });

        await Event.create({
            type: 'Normal', reason: 'RebalanceTriggered',
            message: `Deployment "${dep.name}" rebalanced across cluster nodes.`,
            involvedObject: { kind: 'Deployment', name: dep.name },
        });

        const freshDep = await Deployment.findById(dep._id);

        res.json({ success: true, message: `Rebalance initiated for "${dep.name}"` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- DELETE /api/deployments/:id ----------------------------------------
router.delete('/:id', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot delete deployments.' });
    }
    try {
        const dep = await Deployment.findOne({ _id: req.params.id, owner: req.user._id });
        if (!dep) return res.status(404).json({ success: false, error: 'Not found' });

        console.log(`[API] Deleting deployment "${dep.name}" (Background Cleanup Initiated)`);

        // 1. Respond to user immediately so they don't get a timeout
        res.json({ success: true, message: `Deployment "${dep.name}" deletion initiated` });

        // 2. Perform heavy cleanup in the background
        setImmediate(async () => {
            try {
                // Finally delete the record
                await Deployment.deleteOne({ _id: dep._id });

                await Event.create({
                    type: 'Normal', reason: 'DeploymentDeleted',
                    message: `Deployment "${dep.name}" deleted. ${allContainers.length} container(s) removed.`,
                    involvedObject: { kind: 'Deployment', name: dep.name },
                });
            } catch (bgErr) {
                console.error(`[API] Background deletion error for ${dep.name}:`, bgErr.message);
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- GET /api/deployments/:id/build-logs ---------------------------------
router.get('/:id/build-logs', async (req, res) => {
    try {
        const query = req.user.role === 'viewer'
            ? { _id: req.params.id, viewers: req.user._id }
            : { _id: req.params.id, owner: req.user._id };
        const dep = await Deployment.findOne(query);
        if (!dep) return res.status(404).json({ success: false, error: 'Deployment not found' });

        const logFilePath = path.join(__dirname, '..', 'logs', 'builds', `${dep._id}.log`);
        if (!fs.existsSync(logFilePath)) {
            return res.json({ success: true, logs: 'Waiting for build to start...' });
        }

        const logs = fs.readFileSync(logFilePath, 'utf8');
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- POST /api/deployments/:id/redeploy ---------------------------------
// Rebuilds and redeploys a deployment from its saved gitRepository
router.post('/:id/redeploy', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Permission denied. Viewers cannot redeploy applications.' });
    }
    try {
        const dep = await Deployment.findOne({ _id: req.params.id, owner: req.user._id });
        if (!dep) {
            return res.status(404).json({ success: false, error: 'Deployment not found' });
        }
        
        if (!dep.gitRepository) {
            return res.status(400).json({ success: false, error: 'Deployment was not deployed from Git' });
        }

        // Update deployment status to Building
        const timestamp = Date.now();
        let baseImage = dep.image;
        if (baseImage.includes(':')) {
            baseImage = baseImage.substring(0, baseImage.lastIndexOf(':'));
        }
        const newImageTag = `${baseImage}:${timestamp}`;

        await Deployment.findByIdAndUpdate(dep._id, { 
            $set: { 
                status: 'Building', 
                image: newImageTag
            } 
        });

        await Event.create({ 
            type: 'Normal', 
            reason: 'RedeployStarted', 
            message: `Git re-deployment triggered. Pulling branch "${dep.gitBranch}" and rebuilding in background...`, 
            involvedObject: { kind: 'Deployment', name: dep.name } 
        });

        const updatedDep = await Deployment.findById(dep._id);
        setImmediate(() => triggerGitBuild(updatedDep));
        return res.json({ success: true, message: 'Git re-deployment started in background', data: updatedDep });
    } catch (err) {
        console.error('[API] Redeploy Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- POST /api/deployments/:id/share ------------------------------------
router.post('/:id/share', async (req, res) => {
    if (req.user.role === 'viewer') return res.status(403).json({ success: false, message: 'Viewers cannot share deployments.' });
    try {
        const { email } = req.body;
        const dep = await Deployment.findOne({ _id: req.params.id, owner: req.user._id });
        if (!dep) return res.status(404).json({ success: false, message: 'Deployment not found' });

        const client = await User.findOne({ email });
        if (!client) return res.status(404).json({ success: false, message: 'User not found with that email' });
        if (client._id.equals(req.user._id)) return res.status(400).json({ success: false, message: 'Cannot share with yourself' });

        if (!dep.viewers.includes(client._id)) {
            dep.viewers.push(client._id);
            await dep.save();
        }

        res.json({ success: true, message: 'Deployment shared successfully' });
    } catch (err) {
        console.error('[API] Share error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- DELETE /api/deployments/:id/share/:userId --------------------------
router.delete('/:id/share/:userId', async (req, res) => {
    if (req.user.role === 'viewer') return res.status(403).json({ success: false, message: 'Viewers cannot revoke access.' });
    try {
        const dep = await Deployment.findOne({ _id: req.params.id, owner: req.user._id });
        if (!dep) return res.status(404).json({ success: false, message: 'Deployment not found' });

        dep.viewers = dep.viewers.filter(v => !v.equals(req.params.userId));
        await dep.save();

        res.json({ success: true, message: 'Access revoked' });
    } catch (err) {
        console.error('[API] Revoke error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.triggerGitBuild = triggerGitBuild;
// POST /:id/domains - Add a custom domain
router.post('/:id/domains', async (req, res) => {
    try {
        const { domain } = req.body;
        if (!domain) return res.status(400).json({ error: 'Domain is required' });

        const dep = await Deployment.findById(req.params.id);
        if (!dep) return res.status(404).json({ error: 'Deployment not found' });
        if (dep.owner.toString() !== req.user.userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (!dep.customDomains.includes(domain)) {
            dep.customDomains.push(domain);
            await dep.save();
        }

        res.json({ success: true, customDomains: dep.customDomains });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id/domains/:domain - Remove a custom domain
router.delete('/:id/domains/:domain', async (req, res) => {
    try {
        const { domain } = req.params;
        const dep = await Deployment.findById(req.params.id);
        if (!dep) return res.status(404).json({ error: 'Deployment not found' });
        if (dep.owner.toString() !== req.user.userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        dep.customDomains = dep.customDomains.filter(d => d !== domain);
        await dep.save();

        res.json({ success: true, customDomains: dep.customDomains });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
