$workers = @(
    @{ id = "worker-1"; port = 4001 },
    @{ id = "worker-2"; port = 4002 },
    @{ id = "worker-3"; port = 4003 }
)

foreach ($w in $workers) {
    Write-Host "🚀 Launching $($w.id) on port $($w.port)..." -ForegroundColor Cyan
    # Start in a new terminal window
    # We set AGENT_ADDRESS so each worker reports its correct unique port to the API server
    Start-Process powershell -ArgumentList "-NoExit -Command `$env:NODE_ID='$($w.id)'; `$env:AGENT_PORT=$($w.port); `$env:AGENT_ADDRESS='http://localhost:$($w.port)'; npm start" -WorkingDirectory "$PSScriptRoot\worker-agent"
}

Write-Host "`n✅ All workers triggered! Check the popup windows." -ForegroundColor Green
