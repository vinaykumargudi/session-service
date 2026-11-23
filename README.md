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
