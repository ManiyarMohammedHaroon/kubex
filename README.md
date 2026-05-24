# ⬡ KUBEX — Kubernetes-Inspired Container Orchestrator

A production-grade Kubernetes-inspired container orchestration system built with **MERN + Docker**.

---

## 🏗 Architecture

```
Control Plane (api-server)
├── REST API (Express)
├── ReconcilerService    — desired vs actual diff loop (5s)
├── AutoScalerService    — HPA based on CPU metrics (10s)
├── FailureDetector      — node heartbeat timeout (15s)
├── SchedulerService     — least-loaded node selection
└── LoadBalancer         — round-robin endpoint pool

Worker Agents (worker-agent-1,2,3)
├── HeartbeatService     — POST /heartbeat every 3s
├── MetricsCollector     — simulated CPU/mem (sine wave)
└── ContainerRunner      — local dockerode operations

Database (MongoDB)
├── Deployment           — desired state + actual state
├── Node                 — worker registration + metrics
└── Event                — audit log

Frontend (React + Vite)
├── Dashboard            — cluster health ring + charts
├── Nodes                — per-node resource bars
├── Deployments          — create/scale/delete table
└── Logs                 — per-container terminal viewer
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- **Node.js 20+**
- **MongoDB** running on `localhost:27017`
- **Docker Desktop** running (or Docker daemon accessible)
- **Docker Images:** Public images (nginx, node, etc.) are required. Locally built images won't work across worker agents.

### 1. Start MongoDB (if not running)
```bash
mongod --dbpath "C:\data\db"
# Runs on mongodb://localhost:27017
```

### 2. Start API Server
```bash
cd control-plane/api-server
npm install
npm start
# Runs on http://localhost:3001
```

### 3. Start Worker Agents
You can start multiple workers manually or use the helper script:

**Automated (Recommended):**
Run this in a single PowerShell terminal from the root:
```powershell
./start-workers.ps1
```
*(This will pop up 3 separate terminal windows for workers 1, 2, and 3)*

**Manual (Separate Terminals):**
```powershell
# Terminal 1 (Worker-1)
cd worker-agent
$env:NODE_ID="worker-1"; $env:AGENT_PORT=4001; npm start
```

### 🚀 Rapid Deployment from Local Folder
If you have a project on your local machine, you can build and deploy it in one step using the helper script:

```powershell
# Example: Deploying a portfolio project
./deploy-any-app.ps1 -FolderPath "C:\Users\maniy\Desktop\WEB PRACTICE\MyPortfolio" -AppName "portfolio" -Replicas 2
```
This script will:
1. Detect your app type (Node, Vite, etc.)
2. Build the Docker image automatically
3. Create the KUBEX deployment and start the containers

### 4. Start Frontend
```bash
cd frontend
npm install
npm run dev
# Opens http://localhost:5173
```

---

## 🔌 API Reference

### Deployments
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/deployments` | List all deployments |
| `POST` | `/api/deployments` | Create deployment |
| `PUT` | `/api/deployments/:id/scale` | Scale deployment |
| `POST` | `/api/deployments/:id/rebalance` | Redistribute containers |
| `DELETE` | `/api/deployments/:id` | Delete deployment + containers |

### Cluster
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cluster/status` | Cluster health overview |
| `GET` | `/api/nodes` | List worker nodes |
| `GET` | `/api/nodes/:nodeId/logs` | View worker agent logs |
| `POST` | `/api/heartbeat` | Worker agent heartbeat |
| `GET` | `/api/logs/:deploymentId` | Container logs |
| `GET` | `/api/nodes/events/list` | Recent events |

---

## 🔄 How Reconciliation Works

Every **5 seconds** the ReconcilerService runs this logic for each Deployment:

```
desired = deployment.desiredReplicas       (from MongoDB)
actual  = docker ps --filter kubex.deployment=<name> | running

diff = desired - actual

if diff > 0:                               # SCALE UP / HEAL
  for i in range(diff):
    node = SchedulerService.selectNode()   # least-loaded
    create+start container with kubex labels on that node

elif diff < 0:                             # SCALE DOWN
  stop+remove excess containers
```

**Self-healing**: If a container crashes, it's detected as `exited` on the next pass → removed from Docker → `actualReplicas` drops below `desiredReplicas` → new container created within 5s.

---

## 📁 Folder Structure

```
KUBEX/
├── control-plane/api-server/  # Express API + all background services
├── worker-agent/              # Worker node service
├── frontend/                  # React + Vite dashboard
└── deploy-any-app.ps1         # Universal folder deployer
```

---

*Happy Orchestrating!*  Key: MONGODB_URI
Value: mongodb://host.docker.internal:27017/AgentTracker



# build a docker image 

docker build -t your-app-name:latest .
----------------------------------------------------------------------------------------------------------
# To push an image to Docker Hub, you need to complete three steps: Login, Tag, and Push.

## 1. Log in to Docker Hub
# First, authenticate your Docker CLI with your Docker Hub account.
# bash

docker login

(It will prompt you for your Docker Hub username and password/access token).
-----------------------------------------------------------------------------------------------------
## 2. Tag the Image
# Docker Hub requires the image name to include your specific Docker Hub username. You use the docker tag command to duplicate your local image under the new required naming format.
# bash

Format: docker tag <local-image-name> <your-username>/<repository-name>:<tag>

docker tag your-app-name:latest yourusername/your-app-name:latest
--------------------------------------------------------------------------------------------------------
## 3. Push the Image
# Finally, upload the correctly tagged image to Docker Hub.
# bash

docker push yourusername/your-app-name:latest
--------------------------------------------------------------------------------------------------
### All in one line (if you are already logged in):
## If your image is already built locally as your-app-name, you would run:
# bash

docker tag your-app-name:latest yourusername/your-app-name:latest && docker push yourusername/your-app-name:latest

(Note: Replace yourusername with your actual Docker Hub account username).