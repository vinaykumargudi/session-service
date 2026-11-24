# session-vm-service

Tiny HTTP service that provisions a small GCP Linux VM per request and tags
every resource it creates with the session ID it generated. The Terraform plan
is saved locally per session.

```
client  --POST /create-session-->  Node server  --terraform apply-->  GCP VM
                                          |
                                          +-- sessions/<id>/plan.tfplan (local)
                                          +-- sessions/<id>/id_ed25519  (local)
```

## What gets created

For each `POST /create-session` call:

| Resource | Name | Tags / labels |
|---|---|---|
| VM | `vm-<session_id>` | labels `session_id`, `managed_by`, `created_at`; network tags `ssh`, `session-<session_id>` |
| Firewall | `fw-allow-ssh-<session_id>` | label `session_id`, `managed_by`; target tag `session-<session_id>` |

- VM is `e2-micro`, Debian 12, boot disk only (no extra persistent disks).
- Has an ephemeral external IP, so it is reachable from the public internet.
- Firewall allows `tcp/22` from `0.0.0.0/0` but only to the per-session tag.

## Prerequisites

- Node.js >= 18
- Terraform >= 1.5
- GCP credentials discoverable by the provider (see Auth below)

## Setup

```bash
npm install
cp .env.example .env       # then edit GOOGLE_PROJECT etc.
export $(grep -v '^#' .env | xargs)
gcloud auth application-default login   # one-time
npm start
```

## Auth

Any of these work; Terraform picks them up automatically:

- `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`
- `gcloud auth application-default login` (interactive)
- Workload Identity / metadata server (if running on GCP)

## API

### `POST /create-session`

Creates a session, provisions the VM, returns the SSH command.

```bash
curl -s -X POST http://localhost:3000/create-session | jq
```

Response:

```json
{
  "session_id": "a1b2c3d4e5f6",
  "vm_name": "vm-a1b2c3d4e5f6",
  "vm_external_ip": "34.123.45.67",
  "vm_internal_ip": "10.128.0.4",
  "session_tag": "session-a1b2c3d4e5f6",
  "ssh_user": "debian",
  "ssh_private_key_path": "/.../sessions/a1b2c3d4e5f6/id_ed25519",
  "ssh_command": "ssh -i /.../id_ed25519 -o StrictHostKeyChecking=no debian@34.123.45.67",
  "plan_file": "/.../sessions/a1b2c3d4e5f6/plan.tfplan",
  "state_dir": "/.../sessions/a1b2c3d4e5f6",
  "created_at": "2026-11-23T10:00:00.000Z"
}
```

SSH in:

```bash
ssh -i $(jq -r .ssh_private_key_path <<< "$RESP") \
    -o StrictHostKeyChecking=no \
    debian@$(jq -r .vm_external_ip <<< "$RESP")
```

### `POST /destroy-session/:sessionId`

Runs `terraform destroy` for that session's directory and removes the metadata entry.

```bash
curl -s -X POST http://localhost:3000/destroy-session/a1b2c3d4e5f6
```

### `GET /sessions` / `GET /sessions/:sessionId`

Lists / returns session metadata from `sessions.json`.

## Local artifacts

Per session, under `sessions/<session_id>/`:

- `terraform.tfvars` — variables fed to the apply
- `plan.tfplan` — saved Terraform plan (this is the "plan is stored locally" requirement)
- `terraform.tfstate` — Terraform state for this session
- `id_ed25519`, `id_ed25519.pub` — SSH keypair (private key, mode 600)
- A copy of `main.tf`, `variables.tf`, `outputs.tf` for self-containment

A top-level `sessions.json` keeps the metadata index of all sessions.

## Layout

```
session-vm-service/
├── terraform/
│   ├── main.tf        # VM + firewall + outputs
│   ├── variables.tf
│   └── outputs.tf
├── server.js          # Express app
├── package.json
├── .env.example
└── README.md
```

## Notes

- VM name, firewall name, and tag all embed `session_id`, so all resources are
  trivially filterable in the GCP console (`label:session_id=<id>`).
- `depends_on` on the VM pins the firewall to be created first.
- `backend "local"` keeps state on this machine — no remote backend required.
- Destroy is best-effort; if `terraform destroy` fails, rerun manually from
  `sessions/<id>/`.

---

## CI/CD: Deploy to GCP VM

Every push to `main` deploys this service to a single, pre-provisioned GCP VM
via GitHub Actions over SSH. The workflow SSHes into the VM, pulls the latest
code, installs production deps, and restarts the process under `pm2`. The
`sessions/` directory and `sessions.json` are gitignored and left intact across
deploys.

```
push to main  ──►  GitHub Actions  ──►  SSH (appleboy/ssh-action)
                                              │
                                              ▼
                              apt + node + pm2 (first run only)
                              git pull origin main
                              npm ci --omit=dev
                              write .env + SA key
                              pm2 restart session-service
                              GET /health  ──► green ✅
```

### Prerequisites

- A Debian/Ubuntu GCP VM with a **public IP** and **port 22 reachable from
  GitHub Actions** (or your CIDR — e.g. `35.235.0.0/16` and
  `4.227.0.0/16` for `actions.githubusercontent.com`).
- A non-root SSH user with **passwordless `sudo`** on the VM (the workflow
  installs Node.js, git, pm2, and writes `/etc/session-service/`).
- A **GCP service account** with permission to create Compute Engine VMs and
  firewall rules in your project. Save its JSON key file — it goes into a
  GitHub secret.
- A **GitHub Personal Access Token** (classic with `repo` scope, or
  fine-grained with read access to this repo). The VM uses it to
  `git pull` over HTTPS. Use a fine-grained token scoped to a single repo if
  you want to follow least-privilege.

### One-time VM bootstrap

The workflow is fully idempotent and will bootstrap a fresh VM on the first run,
but if you prefer to see what's installed before pushing, run the bootstrap
script manually:

```bash
# From your laptop — replace session-vm with your instance name
gcloud compute ssh session-vm --command 'curl -fsSL https://raw.githubusercontent.com/vinaykumargudi/session-service/main/scripts/setup-vm.sh | bash'
```

Or SSH in directly:

```bash
gcloud compute ssh session-vm
curl -fsSL https://raw.githubusercontent.com/vinaykumargudi/session-service/main/scripts/setup-vm.sh | bash
```

What it does:

1. Installs Node.js 20.x, git, and curl (if missing).
2. Installs `pm2` globally (if missing).
3. Creates `/etc/session-service/` (mode 750, owned by the SSH user) — the
   service-account key will be written here on every deploy.
4. Enables `pm2` as a systemd service so the app resurrects after VM reboot.

### Configure GitHub secrets and variables

Go to **Settings → Secrets and variables → Actions** for this repo, then add
the values below.

#### Secrets

| Name | Required | Description |
| --- | --- | --- |
| `GCP_VM_SSH_KEY` | yes | Private SSH key (PEM, OpenSSH format) whose **public counterpart is on the VM**. Include the full key — `-----BEGIN OPENSSH PRIVATE KEY-----` … `-----END OPENSSH PRIVATE KEY-----` — including newlines. |
| `GCP_SA_KEY` | yes | The GCP service account JSON key (full file contents). Used by the service on the VM to authenticate to Compute Engine. The workflow writes it to `/etc/session-service/gcp-sa-key.json` with mode `600`. |
| `GITHUB_DEPLOY_TOKEN` | yes | GitHub PAT used by the VM for `git pull` over HTTPS. **Classic** token with `repo` scope, or a **fine-grained** token with read access to this repo. Revoke and rotate by editing this secret. |

#### Variables

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `GCP_VM_HOST` | yes | — | Public IP or DNS of the target GCP VM. |
| `GCP_VM_USER` | yes | — | SSH user on the VM (e.g. `deploy`). Must have passwordless `sudo`. |
| `GCP_VM_PORT` | no | `22` | SSH port. |
| `GOOGLE_PROJECT` | yes | — | GCP project ID the service runs against. |
| `GOOGLE_REGION` | no | `us-central1` | Default GCP region. |
| `GOOGLE_ZONE` | no | `us-central1-a` | Default GCP zone. |
| `APP_DIR` | no | `/opt/session-service` | Install path on the VM. The workflow clones/updates this directory. |
| `PORT` | no | `3000` | Port the service listens on (also published in the health check). |

#### Adding secrets with multiline content

The GitHub web UI handles multiline secrets (SSH keys, JSON) fine — paste the
full content. From the CLI:

```bash
# SSH key
gh secret set GCP_VM_SSH_KEY < ~/.ssh/id_rsa

# GCP service account JSON
gh secret set GCP_SA_KEY < ~/keys/sa-key.json

# GitHub PAT
gh secret set GITHUB_DEPLOY_TOKEN
# paste token on stdin
```

Variables (non-secret config):

```bash
gh variable set GCP_VM_HOST --body '34.123.45.67'
gh variable set GCP_VM_USER --body 'deploy'
gh variable set GOOGLE_PROJECT --body 'my-gcp-project-id'
```

### Deploy

- **Automatic:** push to `main`. Markdown, `.gitignore`, and `.github/**` only
  changes do **not** trigger a deploy.
- **Manual:** Actions tab → "Deploy to GCP VM" → Run workflow.

The workflow:

1. SSHes into the VM with `GCP_VM_SSH_KEY`.
2. **First run only:** installs Node.js + git + pm2, creates
   `/etc/session-service/`, clones the repo into `APP_DIR`, and registers pm2
   for systemd boot.
3. **Every run:** `git pull`s `main`, runs `npm ci --omit=dev`, writes the GCP
   service account key to `/etc/session-service/gcp-sa-key.json` (mode 600),
   rewrites `.env`, restarts `pm2` (delete + start), and polls `/health` for
   up to 10 s.
4. If the health check fails, the step fails with the last 50 lines of pm2
   logs attached.

`sessions/`, `sessions.json`, and any SSH keys generated under
`sessions/<id>/` are preserved across deploys because they are in
`.gitignore`.

### Tearing down a session on the deployed VM

The service exposes `/destroy-session/:id` as normal:

```bash
curl -s -X POST http://<GCP_VM_HOST>:3000/destroy-session/a1b2c3d4e5f6
```

If you need to SSH into the deployed VM to inspect state:

```bash
gcloud compute ssh session-vm
sudo -u deploy bash -c 'cd /opt/session-service && pm2 logs session-service'
```
