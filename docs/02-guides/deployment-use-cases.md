# Deployment Use Cases

> A guide to every way you can deploy Sync — from the simplest single-machine setup to multi-cloud with Portlama tunneling. Read through and pick the one that matches your situation.

## Overview

Sync has two components that need a home:

- **Server** — stores your project definitions, storage credentials, and coordinates agents
- **Agent** — runs on the machine where your files live, watches for changes, and runs rclone

These two components can live on the same machine or on different machines. The connection between them can be direct HTTP, HTTPS, or tunneled through Portlama with mutual TLS certificates.

This guide walks through every realistic combination, from simplest to most complex.

---

## Use Case 1 — Single Machine (Everything Local)

> The simplest setup. Server and agent run on the same computer.

```
┌─────────────────────────────────────────┐
│  Your Computer                          │
│                                         │
│  ┌─────────────┐    ┌──────────────┐    │
│  │ sync-server  │◄───│ sync-agent   │    │
│  │ port 9393    │    │              │    │
│  │ 127.0.0.1   │    │ watches your │    │
│  └──────────────┘    │ folders      │    │
│                      └──────────────┘    │
│                            │             │
│                            ▼             │
│                    ~/Projects/my-app     │
│                    ~/Documents/research  │
└─────────────────────────────────────────┘
         │
         │ rclone sync (outbound HTTPS)
         ▼
   ☁ Cloud Storage
   (S3, Spaces, B2, etc.)
```

**When to use this:**
- You want to sync folders from your laptop or desktop to the cloud
- You do not need to sync between multiple computers
- You want the simplest possible setup

**What happens:**
1. You install Sync on your Mac or Linux machine
2. The server starts on `127.0.0.1:9393` — only your computer can talk to it
3. The agent runs on the same machine, polling the server over loopback
4. You create projects pointing to folders like `~/Projects/my-app`
5. The agent watches those folders and syncs changes to your cloud bucket

**Network:** Loopback only (`127.0.0.1`). Nothing listens on the network. The only outbound traffic is rclone talking to your cloud storage provider over HTTPS.

**Authentication:** Bearer API key. Since everything is on loopback, the key never crosses a network boundary.

**Install:**
```bash
npx @lamalibre/create-sync
```

The interactive wizard handles everything: server setup, storage configuration, first project, and system service installation (launchd on macOS, systemd on Linux).

---

## Use Case 2 — Two Virtual Machines on the Same Host

> Server on one VM, agent on another. Both VMs run on your physical machine (UTM, Parallels, VirtualBox, VMware, etc.).

```
┌─────────────────────────────────────────────────┐
│  Your Physical Machine (host OS)                │
│                                                 │
│  ┌───────────────────┐  ┌────────────────────┐  │
│  │  VM 1 (server)    │  │  VM 2 (agent)      │  │
│  │                   │  │                    │  │
│  │  sync-server      │  │  sync-agent        │  │
│  │  192.168.64.2     │◄─│                    │  │
│  │  port 9393        │  │  watches folders   │  │
│  └───────────────────┘  │  in this VM        │  │
│          │              └────────────────────┘  │
│      VM bridge network (192.168.64.0/24)        │
└─────────────────────────────────────────────────┘
```

**When to use this:**
- You are testing or developing with VMs
- You want to isolate the server from the agent for security or organizational reasons
- You run workloads in separate VMs and want one to be the sync coordinator

**What happens:**
1. VM 1 runs the server, listening on its VM bridge IP (e.g., `192.168.64.2`)
2. VM 2 runs the agent, configured to poll `http://192.168.64.2:9393`
3. The agent syncs folders inside VM 2 to cloud storage

**Network:** Traffic crosses the virtual bridge between VMs. This is internal to your physical machine — it does not reach your LAN or the internet. However, other VMs on the same bridge can potentially see this traffic.

**Authentication:** Bearer API key over HTTP on the VM bridge.

**Install on VM 1 (server):**
```bash
npx @lamalibre/create-sync
# During setup, note the API key
# Set SYNC_HOST=0.0.0.0 to listen on the VM's IP (not just loopback)
```

**Install on VM 2 (agent):**
```bash
npx @lamalibre/create-sync --agent \
  --server http://192.168.64.2:9393 \
  --api-key <your-api-key>
```

**Important:** Set `SYNC_HOST=0.0.0.0` on the server so it listens on the bridge IP, not just `127.0.0.1`.

---

## Use Case 3 — Host Computer + VM Agent

> Server on your main OS, agent inside a VM. Useful when you manage projects from your desktop but the files live inside a VM.

```
┌─────────────────────────────────────────────────┐
│  Your Computer (host OS)                        │
│                                                 │
│  ┌───────────────────┐                          │
│  │  sync-server      │                          │
│  │  127.0.0.1:9393   │                          │
│  │  (or bridge IP)   │                          │
│  └────────┬──────────┘                          │
│           │                                     │
│           │  ┌────────────────────┐              │
│           └─►│  VM (agent)        │              │
│              │                    │              │
│              │  sync-agent        │              │
│              │  watches VM folders│              │
│              └────────────────────┘              │
└─────────────────────────────────────────────────┘
```

**When to use this:**
- You develop inside a VM (e.g., a Linux dev environment on a Mac host)
- The files you want to sync live inside the VM
- You want to manage sync from the host

**What happens:**
1. Server runs on the host, listening on the bridge IP
2. Agent runs inside the VM, syncing folders from the VM's filesystem
3. You manage projects from the host using the CLI

**Network:** VM bridge, same as Use Case 2.

**Authentication:** Bearer API key over VM bridge.

---

## Use Case 4 — VM Server + Host Computer Agent

> Server inside a VM, agent on your main OS. The reverse of Use Case 3.

```
┌─────────────────────────────────────────────────┐
│  Your Computer (host OS)                        │
│                                                 │
│  ┌───────────────────┐                          │
│  │  sync-agent       │                          │
│  │  watches:         │                          │
│  │  ~/Projects/      │                          │
│  │  ~/Documents/     │                          │
│  └────────┬──────────┘                          │
│           │                                     │
│           │  ┌────────────────────┐              │
│           └─►│  VM (server)       │              │
│              │                    │              │
│              │  sync-server       │              │
│              │  192.168.64.2:9393 │              │
│              └────────────────────┘              │
└─────────────────────────────────────────────────┘
```

**When to use this:**
- You want to keep the server isolated in a VM for security
- Your actual files live on the host OS
- You treat the VM as a "service box" that manages infrastructure

**What happens:**
1. Server runs inside a VM
2. Agent runs on the host, watching your personal folders
3. The agent syncs your host folders to cloud storage

**Network:** VM bridge.

**Authentication:** Bearer API key over VM bridge.

**Note:** The agent runs on the host where your personal files are (Documents, SSH keys, etc.). The server in the VM tells the agent which folders to sync. See the [Security Model](../01-concepts/security-model.md) for how path validation works.

---

## Use Case 5 — DigitalOcean Server + Personal Computer Agent (Standalone)

> Server on a cloud droplet, agent on your laptop/desktop. Direct connection over the internet.

```
    DigitalOcean                         Your Computer
┌──────────────────┐                ┌──────────────────────┐
│  Droplet         │                │                      │
│                  │   Internet     │  sync-agent           │
│  sync-server     │◄───────────────│                      │
│  0.0.0.0:9393    │  HTTP/HTTPS    │  watches:            │
│                  │  Bearer token  │  ~/Projects/my-app   │
│  ☁ stores config │                │  ~/Music/production  │
│  ☁ manages state │                └──────────────────────┘
└──────────────────┘
```

**When to use this:**
- You want a central server that is always on (your laptop can sleep)
- You do not use Portlama
- You have a cloud server (DigitalOcean, Hetzner, AWS EC2, etc.)

**What happens:**
1. You deploy the server on a DigitalOcean droplet
2. The server listens on `0.0.0.0:9393` so your agent can reach it
3. You install the agent on your personal computer
4. The agent polls the server over the internet and syncs your local folders

**Network:** Public internet between your computer and the droplet.

**Authentication:** Bearer API key sent as an HTTP header.

**Install on droplet:**
```bash
npx @lamalibre/create-sync
# Set SYNC_HOST=0.0.0.0 to accept connections from the internet
```

**Install on your computer:**
```bash
npx @lamalibre/create-sync --agent \
  --server https://your-droplet-ip:9393 \
  --api-key <your-api-key>
```

**Important — TLS is essential for this setup.** Without it, your API key and cloud storage credentials travel as plaintext over the internet. Place a reverse proxy (Caddy, nginx) in front of the server with a TLS certificate, or configure Fastify's built-in TLS support. See [Security Model](../01-concepts/security-model.md) for details.

**Firewall:** Open port 9393 (or your reverse proxy port) on the droplet. Consider restricting to your home/office IP if it is static.

---

## Use Case 6 — DigitalOcean Server + Personal Computer Agent (Portlama Plugin)

> Server on a cloud droplet inside Portlama, agent on your laptop. Connection goes through Portlama's encrypted tunnel.

```
    DigitalOcean                         Your Computer
┌──────────────────┐                ┌──────────────────────┐
│  Droplet         │                │                      │
│                  │   Portlama     │  sync-agent           │
│  Portlama Server │◄──mTLS tunnel──│  (agent cert)        │
│  ┌────────────┐  │                │                      │
│  │ Sync Plugin│  │                │  watches:            │
│  │ /api/sync  │  │                │  ~/Projects/my-app   │
│  └────────────┘  │                │  ~/Music/production  │
└──────────────────┘                └──────────────────────┘
```

**When to use this:**
- You already use Portlama or want its certificate-based security
- You do not want to manage TLS certificates yourself
- Your computer is behind a firewall or NAT that blocks incoming connections
- You want a single admin panel for multiple services

**What happens:**
1. Portlama runs on the droplet with the Sync plugin registered
2. Portlama provides mTLS — both the server and agent authenticate with certificates
3. The agent on your computer connects through Portlama's tunnel
4. No API keys needed — Portlama's certificates handle authentication
5. The tunnel works even if your computer is behind a firewall

**Network:** Portlama's mTLS tunnel over the internet. All traffic is encrypted end-to-end with mutual certificate verification.

**Authentication:** mTLS client certificates issued by Portlama. The agent certificate carries capabilities (`sync:read`, `sync:write`) that control what it can do.

**Install agent on your computer:**
```bash
npx @lamalibre/create-sync --bundle
# Enter the encrypted config bundle and one-time passphrase from Portlama
```

**Advantages over Use Case 5:**
- No need to configure TLS yourself — Portlama handles it
- Works behind firewalls and NAT — the tunnel is outbound from your computer
- Certificate-based auth instead of a shared API key
- Portlama admin panel for management

---

## Use Case 7 — Two DigitalOcean Droplets (Standalone)

> Server on one droplet, agent on another. Both in the cloud.

```
    DigitalOcean                       DigitalOcean
┌──────────────────┐              ┌──────────────────────┐
│  Droplet 1       │              │  Droplet 2           │
│                  │  DO internal  │                      │
│  sync-server     │◄──or public───│  sync-agent          │
│  0.0.0.0:9393    │   network     │                      │
│                  │               │  watches:            │
│  ☁ manages state │               │  /opt/data/training  │
│                  │               │  /var/lib/app/media  │
└──────────────────┘              └──────────────────────┘
```

**When to use this:**
- You run workloads on cloud servers and want to sync data between them and cloud storage
- You have a dedicated "management" droplet and one or more "worker" droplets
- The files you are syncing live on cloud servers (training data, media files, backups)

**What happens:**
1. Droplet 1 runs the server
2. Droplet 2 runs the agent, syncing directories from its filesystem to cloud storage
3. Communication happens over DigitalOcean's internal network (VPC) or the public internet

**Network:** If both droplets are in the same VPC, use the private IP (e.g., `10.114.0.2`). Otherwise, use the public IP.

**Authentication:** Bearer API key.

**Important:** Even on DigitalOcean's internal network, use TLS. VPC traffic is not encrypted by default — other droplets in the same VPC can potentially observe it.

**Install on Droplet 1 (server):**
```bash
npx @lamalibre/create-sync
# SYNC_HOST=0.0.0.0 or the private VPC IP
```

**Install on Droplet 2 (agent):**
```bash
npx @lamalibre/create-sync --agent \
  --server http://10.114.0.2:9393 \
  --api-key <your-api-key>
```

---

## Use Case 8 — Two DigitalOcean Droplets (Portlama Plugin)

> Server on one droplet inside Portlama, agent on another droplet. Portlama tunnel between them.

```
    DigitalOcean                       DigitalOcean
┌──────────────────┐              ┌──────────────────────┐
│  Droplet 1       │              │  Droplet 2           │
│                  │   Portlama   │                      │
│  Portlama Server │◄──mTLS──────│  sync-agent          │
│  ┌────────────┐  │   tunnel     │  (agent cert)        │
│  │ Sync Plugin│  │              │                      │
│  └────────────┘  │              │  watches:            │
│                  │              │  /opt/data/training   │
└──────────────────┘              └──────────────────────┘
```

**When to use this:**
- Same as Use Case 7, but you want Portlama's certificate infrastructure
- You manage multiple services through Portlama and want Sync as another plugin
- You prefer mTLS over shared API keys

**Network:** Portlama's mTLS tunnel, even between droplets.

**Authentication:** mTLS certificates.

---

## Use Case 9 — Personal Computer Server (Portlama) + Cloud Agent

> The reverse of Use Case 6. Your computer is the server, and a cloud droplet is the agent.

```
    Your Computer                      DigitalOcean
┌──────────────────┐              ┌──────────────────────┐
│                  │              │  Droplet             │
│  Portlama Server │   Portlama  │                      │
│  ┌────────────┐  │──mTLS──────►│  sync-agent          │
│  │ Sync Plugin│  │   tunnel    │  (agent cert)        │
│  └────────────┘  │              │                      │
│                  │              │  watches:            │
│  manages state   │              │  /opt/app/uploads    │
│  from your desk  │              │  /var/lib/media      │
└──────────────────┘              └──────────────────────┘
```

**When to use this:**
- You want to manage sync from your laptop, but the files live on a cloud server
- Your computer does not have a public IP (NAT, dynamic IP, etc.)
- Portlama's tunnel lets the cloud agent reach your computer without port forwarding

**What happens:**
1. Portlama runs on your computer with the Sync plugin
2. The agent on the cloud droplet connects back to your computer through Portlama's tunnel
3. You manage everything from your local Portlama admin panel
4. The cloud agent syncs files from the droplet to cloud storage

**Network:** Portlama's mTLS tunnel. Your computer does not need a public IP — Portlama handles the connection through its relay.

**Authentication:** mTLS certificates.

---

## Use Case 10 — Multiple Agents, One Server

> One central server coordinating agents on several machines. Works with any server location.

```
                          ┌──────────────────────┐
                          │  Machine A (agent)   │
                          │  ~/Projects/         │
                    ┌────►│  ~/Documents/        │
                    │     └──────────────────────┘
┌──────────────┐    │
│              │    │     ┌──────────────────────┐
│  sync-server │    │     │  Machine B (agent)   │
│  (anywhere)  │◄───┼────►│  /opt/data/          │
│              │    │     └──────────────────────┘
└──────────────┘    │
                    │     ┌──────────────────────┐
                    │     │  Machine C (agent)   │
                    └────►│  /var/lib/media/     │
                          └──────────────────────┘

Each agent syncs its own projects to the shared cloud bucket.
```

**When to use this:**
- You have several computers or servers that each have folders to sync
- You want a single point of management
- Each machine syncs its own local folders — the server coordinates, agents execute

**What happens:**
1. The server runs on any machine (your laptop, a droplet, a VM)
2. Each agent registers with the server and receives its project assignments
3. Projects are per-machine: Machine A syncs `~/Projects`, Machine B syncs `/opt/data`
4. All agents sync to the same cloud bucket but under different remote paths
5. Each agent operates independently — a stuck sync on Machine A does not block Machine B

**Scaling:** Add more agents by running `npx @lamalibre/create-sync --agent` on each new machine.

**Authentication:** Bearer API key (standalone) or mTLS certificates (Portlama plugin). All agents use the same server.

---

## Choosing Your Setup

### Start Simple

If you are not sure, start with **Use Case 1** (single machine). You can always move the server to a droplet later — the agent just needs a new server URL and API key.

### Decision Tree

```
Do your files live on one machine only?
├─ Yes → Use Case 1 (single machine)
│
└─ No — files on multiple machines
    │
    ├─ Are all machines on the same physical host (VMs)?
    │   ├─ Yes → Use Case 2, 3, or 4 (VM setups)
    │   └─ No ↓
    │
    ├─ Do you use Portlama?
    │   ├─ Yes → Use Case 6, 8, or 9 (Portlama plugin)
    │   └─ No ↓
    │
    ├─ Is the server on the internet (cloud droplet)?
    │   ├─ Yes → Use Case 5 or 7 (standalone with TLS)
    │   └─ No → Use Case 1 with remote agents on LAN
    │
    └─ Multiple agents?
        └─ Yes → Use Case 10 (any server + multiple agents)
```

### Quick Comparison

| Use Case | Machines | Network | Auth | TLS Required? | Complexity |
|----------|----------|---------|------|---------------|------------|
| 1. Single machine | 1 | Loopback | API key | No | Minimal |
| 2. Two VMs, same host | 2 VMs | VM bridge | API key | Optional | Low |
| 3. Host + VM agent | 1 + 1 VM | VM bridge | API key | Optional | Low |
| 4. VM server + host agent | 1 VM + 1 | VM bridge | API key | Optional | Low |
| 5. Cloud + PC (standalone) | 2 | Internet | API key | **Yes** | Medium |
| 6. Cloud + PC (Portlama) | 2 | mTLS tunnel | Certificates | Built-in | Medium |
| 7. Cloud + Cloud (standalone) | 2 | VPC/Internet | API key | **Yes** | Medium |
| 8. Cloud + Cloud (Portlama) | 2 | mTLS tunnel | Certificates | Built-in | Medium |
| 9. PC server + Cloud agent (Portlama) | 2 | mTLS tunnel | Certificates | Built-in | Medium |
| 10. Multi-agent | 3+ | Mixed | Mixed | Depends | Higher |

### When to Use Portlama vs Standalone

**Choose standalone when:**
- All machines are on the same network (local, LAN, or VPN)
- You are comfortable setting up TLS (reverse proxy or Fastify TLS config)
- You want fewer moving parts
- You only have one or two machines

**Choose Portlama plugin when:**
- Machines are behind firewalls or NAT (Portlama tunnels through)
- You do not want to manage TLS certificates
- You already use Portlama for other services
- You want a web-based admin panel
- You want certificate-based auth instead of shared API keys

---

## What Gets Synced

Regardless of which use case you choose, the sync behavior is the same:

- **Only the folders you configure as projects are synced.** Nothing else on the machine is touched.
- **Each project has a local path** — the absolute path to the folder on the agent's machine, set via `sync agent-approve` and stored locally in `~/.sync-agent/approved-paths.json`. Local paths never leave the machine.
- **Each project has a `direction`** — `push` (local → cloud), `pull` (cloud → local), or `bidirectional`.
- **Exclude patterns** let you skip files (e.g., `node_modules/`, `.DS_Store`, `*.tmp`).
- **Optional encryption** encrypts files before they leave the machine.

The agent only reads and writes inside the configured local path directories. rclone handles the actual file transfer over HTTPS to your cloud storage provider.

---

## Related Documentation

- [Deployment Modes](../01-concepts/deployment-modes.md) — standalone vs plugin technical details
- [Standalone Setup](standalone-setup.md) — step-by-step server installation
- [Agent Enrollment](agent-enrollment.md) — enrolling agents in both modes
- [Configuring Storage](configuring-storage.md) — cloud storage provider setup
- [Managing Projects](managing-projects.md) — creating and configuring sync projects
- [Security Model](../01-concepts/security-model.md) — how credentials and files are protected
