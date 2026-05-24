#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Universal deployer for KUBEX - automatically builds and deploys any folder
.DESCRIPTION
    Accepts any folder path, detects the app type, builds a Docker image,
    and creates a KUBEX deployment automatically.
.EXAMPLE
    .\deploy-any-app.ps1 "C:\Users\maniy\Desktop\WEB PRACTICE\ExpensesTracker\Backend"
    .\deploy-any-app.ps1 -FolderPath "C:\path\to\app" -AppName "my-app" -Replicas 2
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$FolderPath,
    
    [string]$AppName = "",
    [int]$Replicas = 1
)

# --- Validation ---
if (-not (Test-Path $FolderPath)) {
    Write-Host "[ERROR] Folder not found: $FolderPath" -ForegroundColor Red
    exit 1
}

# Auto-detect app name from folder basename
if (-not $AppName) {
    $AppName = (Split-Path $FolderPath -Leaf).ToLower() -replace '\s+', '-'
}

$ImageName = "$($AppName):latest"
$API_URL = "http://localhost:3001/api"

Write-Host " "
Write-Host "**************************************************************" -ForegroundColor Cyan
Write-Host "*          KUBEX UNIVERSAL DEPLOYER                          *" -ForegroundColor Cyan
Write-Host "**************************************************************" -ForegroundColor Cyan

Write-Host " "
Write-Host "[CONFIG] Deployment Configuration:" -ForegroundColor Yellow
Write-Host "   App Name    : $AppName"
Write-Host "   Folder      : $FolderPath"
Write-Host "   Docker Image: $ImageName"
Write-Host "   Replicas    : $Replicas"

# --- Step 1: Build Docker image ---
Write-Host " "
Write-Host "[BUILD] Building Docker image..." -ForegroundColor Cyan
try {
    docker build -t $ImageName $FolderPath 2>&1 | ForEach-Object { 
        Write-Host "   $_"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Docker build failed with exit code $LASTEXITCODE"
    }
    Write-Host "[SUCCESS] Image built successfully" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Build failed: $_" -ForegroundColor Red
    exit 1
}

# --- Step 2: Detect containerPort ---
$Port = 80
if (Test-Path "$FolderPath\Dockerfile") {
    $DockerContent = Get-Content "$FolderPath\Dockerfile"
    if ($DockerContent -match "EXPOSE\s+(?<port>\d+)") {
        $Port = [int]$Matches["port"]
    }
} elseif (Test-Path "$FolderPath\package.json") {
    $Pkg = Get-Content "$FolderPath\package.json" | ConvertFrom-Json
    if ($Pkg.scripts.dev -match "vite" -or $Pkg.scripts.start -match "vite") {
        $Port = 5173
    } elseif ($Pkg.scripts.start -match "node") {
        $Port = 5000
    }
}

Write-Host "[CONFIG] Detected container port: $Port" -ForegroundColor Yellow

# --- Step 3: Create deployment in KUBEX ---
Write-Host " "
Write-Host "[KUBEX] Creating deployment in KUBEX..." -ForegroundColor Cyan

$DeploymentPayload = @{
    name = $AppName
    image = $ImageName
    desiredReplicas = $Replicas
    containerPort = $Port
    resourceLimits = @{
        cpu = "0.5"
        memory = "256m"
    }
} | ConvertTo-Json

try {
    $Response = Invoke-WebRequest -Method POST "$API_URL/deployments" `
        -Headers @{"Content-Type"="application/json"} `
        -Body $DeploymentPayload `
        -UseBasicParsing `
        -ErrorAction Stop

    $ResponseData = $Response.Content | ConvertFrom-Json
    
    if ($ResponseData.success) {
        Write-Host "[SUCCESS] Deployment created successfully!" -ForegroundColor Green
        $DeployId = $ResponseData.data._id
        Write-Host "   Deployment ID: $DeployId" -ForegroundColor Cyan
    } else {
        throw $ResponseData.error
    }
} catch {
    Write-Host "[ERROR] Deployment creation failed!" -ForegroundColor Red
    Write-Host "   Error: $_" -ForegroundColor Red
    Write-Host " "
    Write-Host "CHECKLIST:" -ForegroundColor Yellow
    Write-Host "   - API server is running on localhost:3001"
    Write-Host "   - MongoDB is accessible"
    Write-Host "   - Docker engine is running"
    exit 1
}

# --- Step 3: Monitor deployment ---
Write-Host " "
Write-Host "[WAIT] Waiting for containers to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

try {
    $Deployment = Invoke-WebRequest -Method GET "$API_URL/deployments/$DeployId" -UseBasicParsing -ErrorAction Stop | ConvertFrom-Json
    $ActualReplicas = $Deployment.data.actualReplicas
    $Status = $Deployment.data.status
    
    Write-Host "[STATUS] Deployment Status:" -ForegroundColor Cyan
    Write-Host "   Status    : $Status"
    Write-Host "   Desired   : $Replicas"
    Write-Host "   Actual    : $ActualReplicas"
} catch {
    Write-Host "[WARN] Could not fetch deployment details" -ForegroundColor Yellow
}

# --- Success summary ---
Write-Host " "
Write-Host "**************************************************************" -ForegroundColor Green
Write-Host "*                  DEPLOYMENT COMPLETE                       *" -ForegroundColor Green
Write-Host "**************************************************************" -ForegroundColor Green

Write-Host " "
Write-Host "[INFO] Next steps:" -ForegroundColor Yellow
Write-Host "   1. Open http://localhost:5173 in your browser"
Write-Host "   2. Go to Deployments tab"
Write-Host "   3. Find your app: $AppName"
Write-Host "   4. Click the endpoint link to access your app"

Write-Host " "
Write-Host "[INFO] Useful commands:" -ForegroundColor Yellow
Write-Host "   - View logs : curl http://localhost:3001/api/logs/$DeployId"

# Building the scale command safely with single quotes for the outer part and double-single for internal literal
$ScaleCmd = 'curl -X PUT http://localhost:3001/api/deployments/' + $DeployId + '/scale -H "Content-Type: application/json" -d ''{"replicas":3}'''
Write-Host "   - Scale up  : $ScaleCmd"

Write-Host "   - Delete    : curl -X DELETE http://localhost:3001/api/deployments/$DeployId"

Write-Host " "
