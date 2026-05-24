/**
 * @file ReconcilerService.js — The core control loop of KUBEX.
 *
 * This is the most important service in the entire system. It runs on a
 * configurable timer (RECONCILER_INTERVAL_MS, default 5 s) and ensures the
 * actual state of Docker containers matches what is stored in MongoDB.
 */
const Deployment = require('../models/Deployment');
const Node = require('../models/Node');
const Event = require('../models/Event');
const DockerService = require('./DockerService');
const SchedulerService = require('./SchedulerService');
const LoadBalancer = require('./LoadBalancer');

let reconcilerTimer = null;

// Map to track active reconciliations per deployment name
const activeReconciliations = new Set();

/**
 * Write a cluster event to MongoDB (fire-and-forget, never throws).
 */
async function logEvent(type, reason, message, kind, name) {
    try {
        await Event.create({ type, reason, message, involvedObject: { kind, name } });
    } catch (_) { /* intentionally swallowed */ }
}

/**
 * Run a single reconciliation pass for one Deployment document.
 */
async function reconcileDeployment(deployment, validNodeIds = null, nodeAddressMap = null) {
    const { name, image, desiredReplicas, resourceLimits, envVars, containerPort } = deployment;

    if (activeReconciliations.has(name)) return;
    activeReconciliations.add(name);

    try {
        if (!validNodeIds || !nodeAddressMap) {
            const readyNodes = await Node.find({ status: 'Ready' }).select('nodeId address').lean();
            validNodeIds = new Set(readyNodes.map(n => n.nodeId));
            nodeAddressMap = new Map(readyNodes.map(n => [n.nodeId, n.address]));
        }

        // Fetch all containers (including stopped ones) labelled with this deployment
        const allContainers = await DockerService.listContainersByLabel({
            'kubex.deployment': name,
        });

        // ── Step 0: Image Rollout Enforcement ────────────────────────────────
        // If a container is running the wrong image, it's a "ghost" of an old version.
        // We stop them here so the rest of the loop will naturally recreate them.
        const wrongImageContainers = allContainers.filter(c => {
            // Robust comparison: handle cases like 'nginx' vs 'docker.io/library/nginx:latest'
            const normA = c.image.includes('/') ? c.image : `docker.io/library/${c.image}`;
            const normB = image.includes('/') ? image : `docker.io/library/${image}`;
            const finalA = normA.includes(':') ? normA : `${normA}:latest`;
            const finalB = normB.includes(':') ? normB : `${normB}:latest`;
            return finalA !== finalB;
        });

        if (wrongImageContainers.length > 0) {
            console.log(`[Reconciler] Detected ${wrongImageContainers.length} containers with outdated image for "${name}". Evicting for rollout...`);
            for (const old of wrongImageContainers) {
                await DockerService.stopAndRemoveContainer(old.containerId).catch(() => {});
            }
            // We DON'T recurse here. We let the next loop iteration (in 5s) handle the recreation.
            // This prevents infinite recursion if Docker is slow to remove containers.
            return; 
        }

        // ── HANDLE TERMINATION ────────────────────────────────────────────────
        if (deployment.status === 'Terminating') {
            console.log(`[Reconciler] Finalizing deletion for "${name}"...`);
            for (const c of allContainers) {
                await DockerService.stopAndRemoveContainer(c.containerId).catch(() => {});
            }
            LoadBalancer.removePool(name);
            await Deployment.deleteOne({ _id: deployment._id });
            console.log(`[Reconciler] Deployment "${name}" successfully deleted.`);
            return;
        }

        // ── Step 1: Detect and evict "Ghost" containers ───────────────────────
        const ghostContainers = allContainers.filter((c) => !validNodeIds.has(c.nodeId));
        for (const ghost of ghostContainers) {
            await DockerService.stopAndRemoveContainer(ghost.containerId).catch(() => {});
            await logEvent('Warning', 'ContainerEvicted', `Ghost container ${ghost.containerId.slice(0, 12)} evicted.`, 'Deployment', name);
        }

        const validContainers = allContainers.filter((c) => validNodeIds.has(c.nodeId));
        const runningContainers = validContainers.filter((c) => c.status === 'running');

        // ── Step 2: Clean up non-running containers ──────────────────────────
        const zombieContainers = validContainers.filter((c) => c.status !== 'running');
        for (const zombie of zombieContainers) {
            await DockerService.stopAndRemoveContainer(zombie.containerId).catch(() => {});
        }

        // ── Step 3: Detect and remove containers with stale configuration ─────
        // If the containerPort or Image has changed in the Deployment model,
        // we must recreate the containers to apply the new config.
        const staleContainers = runningContainers.filter(c => {
            const currentPort = c.labels?.['kubex.containerPort'];
            if (currentPort && currentPort !== String(containerPort || 80)) return true;
            return false;
        });

        if (staleContainers.length > 0) {
            console.log(`[Reconciler] Found ${staleContainers.length} stale containers for "${name}" (Config changed). Purging for rolling update...`);
            for (const c of staleContainers) {
                await DockerService.stopAndRemoveContainer(c.containerId);
                LoadBalancer.removeEndpoint(name, c.ip);
            }
            return; // Next tick will handle the scale-up
        }

        const actual = runningContainers.length;
        const diff = desiredReplicas - actual;


        if (diff > 0) {
            let staticPortInUse = false;
            if (deployment.staticHostPort) {
                staticPortInUse = runningContainers.some(c => c.hostPort === deployment.staticHostPort);
            }

            for (let i = 0; i < diff; i++) {
                try {
                    const { nodeId } = await SchedulerService.selectNode();
                    const replicaIndex = actual + i + 1;
                    await DockerService.pullImage(image);

                    let assignStaticPort = false;
                    if (deployment.staticHostPort && !staticPortInUse) {
                        assignStaticPort = true;
                        staticPortInUse = true;
                    }

                    // Bug 11 fix: removed dead deployment.containers.push() here.
                    // The push had zero effect because deployment.containers is
                    // completely rebuilt from a fresh Docker query at Step 5 (line ~168),
                    // which immediately overwrites any in-memory mutations.
                    await DockerService.createAndStartContainer(
                        image, name, replicaIndex, resourceLimits, envVars || [], nodeId,
                        assignStaticPort ? deployment.staticHostPort : '', containerPort || 80
                    );
                } catch (err) {
                    console.error(`[Reconciler] Scale up error for ${name}:`, err.message);
                }
            }
        } else if (diff < 0) {
            const sortedForRemoval = [...runningContainers].sort((a, b) => {
                if (deployment.staticHostPort) {
                    if (a.hostPort === deployment.staticHostPort) return 1;
                    if (b.hostPort === deployment.staticHostPort) return -1;
                }
                return 0;
            });

            const toRemove = sortedForRemoval.slice(0, Math.abs(diff));
            for (const c of toRemove) {
                await DockerService.stopAndRemoveContainer(c.containerId);
                deployment.containers = deployment.containers.filter(dc => dc.containerId !== c.containerId);
                LoadBalancer.removeEndpoint(name, c.ip);
            }
        }

        // ── Step 5 & 6: Sync and Update Status ────────────────────────────────
        const freshContainers = await DockerService.listContainersByLabel({ 'kubex.deployment': name });
        const freshRunning = freshContainers.filter(c => c.status === 'running' && validNodeIds.has(c.nodeId));
        
        const existingMap = new Map(deployment.containers.map(c => [c.containerId, c]));

        deployment.containers = freshRunning.map(c => {

            const existing = existingMap.get(c.containerId);
            return {
                containerId: c.containerId,
                nodeId: c.nodeId || existing?.nodeId || 'unknown',
                status: 'running',
                ip: c.ip || existing?.ip || '',
                hostPort: c.hostPort || existing?.hostPort || ''
            };
        });

        deployment.actualReplicas = freshRunning.length;

        if (deployment.status !== 'Terminating') {
            if (freshRunning.length === desiredReplicas) {
                deployment.status = 'Running';
            } else if (deployment.status !== 'Scaling') {
                deployment.status = (freshRunning.length === 0 && desiredReplicas === 0) ? 'Pending' : 'Degraded';
            }
        }

        const endpoints = freshRunning.map(c => ({ 
            ip: c.ip, 
            hostPort: c.hostPort,
            address: nodeAddressMap.get(c.nodeId)
        }));
        LoadBalancer.updatePool(name, endpoints);

        // ── Step 7: Atomic Update (Prevents VersionError) ────────────────────
        // Instead of deployment.save(), we use findByIdAndUpdate to only update
        // the fields we care about. This allows concurrent manual updates.
        const updateData = {
            containers: deployment.containers,
            actualReplicas: deployment.actualReplicas,
        };

        // Only update status if we aren't interfering with a manual deletion
        if (deployment.status !== 'Terminating') {
            updateData.status = deployment.status;
        }

        await Deployment.findByIdAndUpdate(deployment._id, { $set: updateData });

        // ── Step 8: Final Deletion ───────────────────────────────────────────
        // If the deployment was marked as Terminating and all containers are now 
        // confirmed gone, we can finally remove the document from MongoDB.
        if (deployment.status === 'Terminating' && freshRunning.length === 0) {
            console.log(`[Reconciler] Finalizing deletion of "${name}"...`);
            await Deployment.findByIdAndDelete(deployment._id);
            await logEvent('Normal', 'DeploymentRemoved', `Deployment "${name}" document removed from database.`, 'Deployment', name);
        }

    } catch (err) {
        if (err.name !== 'VersionError') {
            console.error(`[Reconciler] Error for ${name}:`, err.message);
        }
    } finally {
        activeReconciliations.delete(name);
    }
}

async function reconcileAll() {
    try {
        const readyNodes = await Node.find({ status: 'Ready' }).select('nodeId address').lean();
        const validNodeIds = new Set(readyNodes.map(n => n.nodeId));
        const nodeAddressMap = new Map(readyNodes.map(n => [n.nodeId, n.address]));
        
        const deployments = await Deployment.find();
        await Promise.allSettled(deployments.map(d => reconcileDeployment(d, validNodeIds, nodeAddressMap)));

    } catch (err) {
        console.error(`[Reconciler] Pass error:`, err.message);
    }
}

function start() {
    const interval = parseInt(process.env.RECONCILER_INTERVAL_MS || '5000');
    reconcilerTimer = setInterval(reconcileAll, interval);
    setTimeout(reconcileAll, 2000);
}

function stop() {
    if (reconcilerTimer) clearInterval(reconcilerTimer);
}

module.exports = { start, stop, reconcileAll, reconcileDeployment };
