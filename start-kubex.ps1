# Start KUBEX 100% Locally (Pull Architecture)

Write-Host "Starting KUBEX API Server..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd control-plane/api-server; npm run dev"

Write-Host "Starting KUBEX Frontend UI..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd frontend; npm run dev"

Write-Host "Starting KUBEX Worker Agent (Localtunnel & Docker Engine)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", ".\start-worker.ps1"

Write-Host "All KUBEX components are starting up in separate windows!" -ForegroundColor Green
Write-Host "Wait a few seconds, then open http://localhost:5173 in your browser." -ForegroundColor Cyan
