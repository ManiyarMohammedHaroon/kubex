const localtunnel = require('localtunnel');
const { spawn } = require('child_process');

class TunnelManager {
    /**
     * Create a tunnel using the specified provider.
     * Supported providers: 'localtunnel', 'localhost.run'
     */
    static async createTunnel(containerId, port, subdomain, depName, tunnelHost) {
        const provider = process.env.TUNNEL_PROVIDER || 'localhost.run';
        
        console.log(`[TunnelManager] Spawning Auto-Tunnel for ${depName} on port ${port} using ${provider}...`);

        if (provider === 'localtunnel') {
            return this._createLocalTunnel(containerId, port, subdomain, depName, tunnelHost);
        } else if (provider === 'localhost.run' || provider === 'pinggy') {
            // We use localhost.run because it has better raw stdout support for Node.js child_process
            return this._createSshTunnel(containerId, port, depName, tunnelHost);
        } else {
            throw new Error(`Unknown TUNNEL_PROVIDER: ${provider}`);
        }
    }

    static _createLocalTunnel(containerId, port, subdomain, depName, tunnelHost) {
        return new Promise(async (resolve, reject) => {
            try {
                const tunnel = await Promise.race([
                    localtunnel({ port: parseInt(port), host: 'https://localtunnel.me', local_host: tunnelHost, subdomain }),
                    new Promise((_, rj) => setTimeout(() => rj(new Error('Tunnel connect timeout after 30s')), 30000))
                ]);

                // Create a generic wrapper so Reconciler doesn't care about the provider specifics
                const closeTunnel = () => tunnel.close();
                
                tunnel.on('error', err => {
                    console.error(`[Auto-Tunnel] Error for ${depName}:`, err.message);
                });
                tunnel.on('close', () => {
                    console.log(`[Auto-Tunnel] Closed for ${depName}.`);
                });

                resolve({ url: tunnel.url, close: closeTunnel });
            } catch (err) {
                reject(err);
            }
        });
    }

    static _createSshTunnel(containerId, port, depName, tunnelHost) {
        return new Promise((resolve, reject) => {
            // Use native Windows OpenSSH to forward port to localhost.run
            const ssh = spawn('ssh', [
                '-R', `80:${tunnelHost}:${port}`,
                'nokey@localhost.run',
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'ServerAliveInterval=30'
            ], { windowsHide: true });

            let resolved = false;

            const handleOutput = (data) => {
                const text = data.toString();
                // Look for the generated LHR URL
                const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/);
                if (match && !resolved) {
                    resolved = true;
                    resolve({
                        url: match[0],
                        close: () => ssh.kill()
                    });
                }
            };

            ssh.stdout.on('data', handleOutput);
            ssh.stderr.on('data', handleOutput);

            ssh.on('close', (code) => {
                if (!resolved) reject(new Error(`SSH Tunnel exited prematurely with code ${code}`));
                console.log(`[Auto-Tunnel] Closed for ${depName}.`);
            });

            ssh.on('error', (err) => {
                if (!resolved) reject(err);
                console.error(`[Auto-Tunnel] Error for ${depName}:`, err.message);
            });

            // Fallback timeout
            setTimeout(() => {
                if (!resolved) {
                    ssh.kill();
                    reject(new Error('SSH Tunnel connect timeout after 30s'));
                }
            }, 30000);
        });
    }
}

module.exports = TunnelManager;
