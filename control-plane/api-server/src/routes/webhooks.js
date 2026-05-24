const router = require('express').Router();
const Deployment = require('../models/Deployment');
const Event = require('../models/Event');
const deploymentsRouter = require('./deployments');
const { triggerGitBuild } = deploymentsRouter;

// POST /api/webhooks/github/:id
router.post('/github/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { token } = req.query;

        // Find the deployment
        const deployment = await Deployment.findById(id);
        if (!deployment) {
            return res.status(404).json({ success: false, error: 'Deployment not found' });
        }

        // Validate webhook secret token
        if (!deployment.webhookSecret || token !== deployment.webhookSecret) {
            return res.status(401).json({ success: false, error: 'Unauthorized webhook request' });
        }

        // Check if autoDeploy is enabled
        if (!deployment.autoDeploy) {
            return res.json({ success: true, message: 'Auto-deploy is disabled for this deployment' });
        }

        // Validate branch if from a push payload
        const ref = req.body && req.body.ref;
        if (ref) {
            const expectedRef = `refs/heads/${deployment.gitBranch}`;
            if (ref !== expectedRef) {
                console.log(`[Webhook] Push event on branch ${ref} does not match configured branch ${expectedRef}. Skipping.`);
                return res.json({ success: true, message: `Skipping build: push was on ${ref}, but configured branch is ${expectedRef}` });
            }
        }

        console.log(`[Webhook] Push event verified for deployment "${deployment.name}". Triggering background rebuild...`);

        // Generate a new timestamp-based tag to trigger reconciler rolling update
        const timestamp = Date.now();
        let baseImage = deployment.image;
        if (baseImage.includes(':')) {
            baseImage = baseImage.substring(0, baseImage.lastIndexOf(':'));
        }
        const newImageTag = `${baseImage}:${timestamp}`;

        // Update status and image
        await Deployment.findByIdAndUpdate(deployment._id, {
            $set: {
                status: 'Building',
                image: newImageTag
            }
        });

        await Event.create({
            type: 'Normal',
            reason: 'WebhookTriggered',
            message: `GitHub webhook triggered redeploy. Pulling latest code and rebuilding in background...`,
            involvedObject: { kind: 'Deployment', name: deployment.name }
        });

        // Trigger background build
        const updatedDep = await Deployment.findById(deployment._id);
        setImmediate(() => triggerGitBuild(updatedDep).catch(e => console.error('[Webhook] Git Build Error:', e.message)));

        res.json({ success: true, message: 'Git rebuild and redeployment successfully triggered in background', data: updatedDep });
    } catch (err) {
        console.error('[Webhook Error]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
