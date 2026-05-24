/**
 * @file routes/system.js — System-level utility routes.
 * 
 * Provides native OS integration for the KUBEX dashboard, such as
 * opening a folder browser dialog on the server's machine.
 */
const router = require('express').Router();
const { exec } = require('child_process');



/**
 * GET /api/system/images - Returns a list of all local Docker images.
 */
router.get('/images', (req, res) => {
    // Using {{json .}} is the most robust way to get machine-readable output from Docker.
    exec(`docker images --format "{{json .}}"`, (error, stdout, stderr) => {
        if (error) {
            console.error('[API] Docker Images Error:', stderr);
            return res.status(500).json({ success: false, error: 'Failed to fetch images' });
        }
        
        // Handle Windows line endings (\r\n) by splitting with a regex
        const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
        const images = lines.map(line => {
            try {
                const raw = JSON.parse(line);
                // Docker's JSON keys are capitalized (Repository, Tag, etc.)
                return {
                    repo: raw.Repository || raw.repo || 'unknown',
                    tag: raw.Tag || raw.tag || 'latest',
                    id: raw.ID || raw.id || 'unknown',
                    created: raw.CreatedSince || raw.created || 'recently',
                    size: raw.Size || raw.size || '0 B'
                };
            } catch (e) {
                console.error('[API] Failed to parse image line:', line, e.message);
                return null;
            }
        }).filter(img => img && img.repo !== '<none>');

        console.log(`[API] Found ${images.length} Docker images`);
        res.json({ success: true, images });
    });
});

/**
 * DELETE /api/system/images/:id — Deletes a specific image by ID.
 * Automatically cleans up any "ghost" containers using this image first.
 */
router.delete('/images/:id', (req, res) => {
    const { id } = req.params;

    // 1. Find and remove all containers (running or stopped) using this image ID
    // This prevents the "Image is in use" error.
    exec(`docker ps -a -q --filter "ancestor=${id}"`, (psErr, psStdout) => {
        const containerIds = psStdout.trim().split(/\s+/).filter(cid => cid.length > 0);
        
        const deleteImage = () => {
            exec(`docker rmi -f ${id}`, (error, stdout, stderr) => {
                if (error) {
                    console.error('[API] Docker RMI Error:', stderr);
                    const cleanError = stderr.split(':').pop().trim() || 'Image could not be deleted';
                    return res.status(500).json({ success: false, error: cleanError });
                }
                res.json({ success: true, message: 'Image and its ghost containers deleted' });
            });
        };

        if (containerIds.length > 0) {
            console.log(`[API] Cleaning up ${containerIds.length} ghost containers for image ${id}...`);
            exec(`docker rm -f ${containerIds.join(' ')}`, () => {
                deleteImage();
            });
        } else {
            deleteImage();
        }
    });
});

/**
 * POST /api/system/images/prune — Removes all dangling/unused images AND stopped containers.
 */
router.post('/images/prune', (req, res) => {
    // We prune containers first, then images to maximize cleanup
    exec(`docker container prune -f && docker image prune -f`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: 'Prune failed' });
        }
        res.json({ success: true, message: 'Unused images and ghost containers pruned' });
    });
});



module.exports = router;
