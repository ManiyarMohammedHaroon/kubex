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



const Deployment = require('../models/Deployment');
const Event = require('../models/Event');
const User = require('../models/User');


const auth = require('../middleware/auth');

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────




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

        const { depId, status, tunnelUrl, containerInfo, error } = req.body;
        const updateDoc = { status };
        if (tunnelUrl) updateDoc.tunnelUrl = tunnelUrl;
        if (error) updateDoc.lastError = error;
        if (status === 'Running') updateDoc.lastError = ''; // Clear error on success
        
        let mongoUpdate = { $set: updateDoc };

        if (status === 'Running' && containerInfo) {
            mongoUpdate.$push = { containers: containerInfo };
            mongoUpdate.$inc = { actualReplicas: 1 };
        } else if (status === 'Stopped' && containerInfo) {
            mongoUpdate.$pull = { containers: { containerId: containerInfo.containerId } };
            mongoUpdate.$inc = { actualReplicas: -1 };
        } else if (status === 'Failed' || status === 'Pending') {
            mongoUpdate.$set.actualReplicas = 0;
            mongoUpdate.$set.containers = [];
        }

        await Deployment.findByIdAndUpdate(depId, mongoUpdate);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/deployments/:id/build-complete ────────────────────────────────
// Called by the worker node when it finishes building the Docker image
router.post('/:id/build-complete', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();
        const Node = require('../models/Node');
        const node = await Node.findOne({ token });
        if (!node) return res.status(403).json({ success: false, error: 'Forbidden' });

        const { image } = req.body;
        if (!image) return res.status(400).json({ success: false, error: 'image tag is required' });

        const dep = await Deployment.findByIdAndUpdate(req.params.id, {
            $set: { 
                status: 'Pending',
                image: image,
                lastError: null
            }
        }, { new: true });

        if (!dep) return res.status(404).json({ success: false, error: 'Deployment not found' });
        
        res.json({ success: true, data: dep });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Protect all deployment routes under this router
router.use(auth);

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
            dockerHubUsername = '', healthCheck = { enabled: false, path: '/health', maxRetries: 3 },
            environment = 'local'
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
            const util = require('util');
            const execAsync = util.promisify(require('child_process').exec);
            await execAsync(`git -c credential.helper= -c core.fsmonitor=false clone --depth 1 -b ${gitBranch} "${cloneUrl}" "${tempScanPath}"`, {
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
                envVars: [
                    { key: 'API_BACKEND', value: `${name}-backend` },
                    { key: 'API_PORT', value: '3000' }
                ], // AUTO-CONNECT TO BACKEND
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
                dockerHubUsername, healthCheck,
                environment
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
                dockerHubUsername, healthCheck,
                environment
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

            // The status is 'Building', so the Worker Agent will automatically pick this up!
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
                dockerHubUsername, healthCheck,
                environment
            });

            await Event.create({
                type: 'Normal', reason: 'DeploymentCreated',
                message: `Deployment "${name}" created with ${desiredReplicas} desired replicas`,
                involvedObject: { kind: 'Deployment', name },
            });

            // The status is 'Building', so the Worker Agent will automatically pick this up!
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
                // Save image to images collection before deleting the deployment record
                const Image = require('../models/Image');
                const [repo, tag = 'latest'] = dep.image.split(':');
                
                const existingImg = await Image.findOne({ repo, tag, owner: dep.owner });
                if (!existingImg) {
                    await Image.create({
                        repo,
                        tag,
                        imageId: dep.containers?.[0]?.containerId?.slice(0, 12) || 'unknown',
                        size: dep.resourceLimits?.memory || '128m',
                        owner: dep.owner
                    });
                    console.log(`[API] Saved deleted deployment image ${dep.image} to Image Library for user ${dep.owner}`);
                }

                // Finally delete the record
                await Deployment.deleteOne({ _id: dep._id });

                await Event.create({
                    type: 'Normal', reason: 'DeploymentDeleted',
                    message: `Deployment "${dep.name}" deleted. ${dep.containers ? dep.containers.length : 0} container(s) removed.`,
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

        const updatedDep = await Deployment.findByIdAndUpdate(
            dep._id,
            { $set: { status: 'Building', lastError: '' } },
            { new: true }
        );
        res.json({ success: true, message: 'Git re-deployment started in background', data: updatedDep });
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

// PUT /:id/env - Update environment variables
router.put('/:id/env', async (req, res) => {
    try {
        const { envVars } = req.body;
        if (!Array.isArray(envVars)) return res.status(400).json({ error: 'envVars must be an array' });

        const dep = await Deployment.findById(req.params.id);
        if (!dep) return res.status(404).json({ error: 'Deployment not found' });
        
        // Authorization check
        if (dep.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        dep.envVars = envVars;
        
        // Force the Worker Agent to completely rebuild this deployment with the new env vars
        dep.status = 'Pending';
        dep.actualReplicas = 0;
        dep.containers = []; // Wiping containers forces Reconciler to GC them immediately
        dep.lastError = '';
        
        await dep.save();

        res.json({ success: true, data: dep });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



module.exports = router;
