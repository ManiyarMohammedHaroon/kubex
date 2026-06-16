# KUBEX Worker Agent Startup Script
# This runs the local engine that builds your Docker images and spawns Localtunnels.

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "        KUBEX LOCAL WORKER AGENT         " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check for Docker Desktop
Write-Host "Checking for Docker Engine..." -ForegroundColor Yellow
$dockerCheck = Get-Command "docker" -ErrorAction SilentlyContinue
if (-not $dockerCheck) {
    Write-Host "ERROR: Docker is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Please install Docker Desktop and start it before running KUBEX." -ForegroundColor Red
    exit 1
}
Write-Host "OK Docker Engine found." -ForegroundColor Green

# [CHANGE THIS] Use localhost for now, but change this to your Render URL later!
$ApiServerUrl = "http://localhost:3001"
if ($env:API_SERVER_URL) {
    $ApiServerUrl = $env:API_SERVER_URL
}
Write-Host "Connecting to Control Plane at: $ApiServerUrl" -ForegroundColor Green

# Start the worker agent
Write-Host "Starting Worker Agent..." -ForegroundColor Yellow
Set-Location -Path ".\worker-agent"

# Set necessary environment variables
$env:API_SERVER_URL = $ApiServerUrl
$env:NODE_ID = "kubex-local-laptop"

# [CHANGE THIS] Paste the token you generate from the Vercel UI here later!
$env:KUBEX_TOKEN = '797e9bd139a48c6f27a16adccd04243e09405391a3cbbee1637ea375e27cf2ff'
# Set your preferred tunnel provider (localtunnel or localhost.run)
# localhost.run uses native SSH, is much faster, and doesn't require an account!
$env:TUNNEL_PROVIDER = "localhost.run"

npm run start
