// server.js
// HTTP server that exposes /create-session. Each call spins up an isolated
// Terraform working directory, generates an SSH keypair, runs `terraform init
// / plan / apply`, and returns a session_id + the SSH command for the VM.

const express = require('express');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileP = promisify(execFile);

// ---------- Paths & config ----------
const ROOT = __dirname;
const TERRAFORM_SRC = path.join(ROOT, 'terraform');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const METADATA_FILE = path.join(ROOT, 'sessions.json');

const PROJECT_ID = process.env.GOOGLE_PROJECT || process.env.GCP_PROJECT_ID;
const REGION = process.env.GOOGLE_REGION || 'us-central1';
const ZONE = process.env.GOOGLE_ZONE || 'us-central1-a';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!PROJECT_ID) {
  console.error(
    '[fatal] GOOGLE_PROJECT (or GCP_PROJECT_ID) env var is required. ' +
      'Set it before starting the server.'
  );
  process.exit(1);
}

[SESSIONS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(METADATA_FILE)) fs.writeFileSync(METADATA_FILE, '{}');

// ---------- Helpers ----------
function newSessionId() {
  // 12 hex chars -> short enough for names/tags, plenty of entropy for uniqueness
  return crypto.randomBytes(6).toString('hex');
}

function loadSessions() {
  return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
}

function saveSessions(s) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(s, null, 2));
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, id);
}

// Run a binary with args, stream output to console, return {stdout, stderr}.
// Throws on non-zero exit with a readable error.
async function run(bin, args, cwd) {
  return execFileP(bin, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
}

function generateSshKeypair(dir) {
  const priv = path.join(dir, 'id_ed25519');
  const pub = priv + '.pub';
  if (fs.existsSync(priv) && fs.existsSync(pub)) return { priv, pub };

  // sync, fine at startup
  const { execFileSync } = require('child_process');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', priv, '-q'], {
    stdio: 'inherit',
  });
  fs.chmodSync(priv, 0o600);
  return { priv, pub };
}

// ---------- Express ----------
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

// Create a session: provision a new VM tagged with a fresh session_id.
app.post('/create-session', async (_req, res) => {
  const sessionId = newSessionId();
  const dir = sessionDir(sessionId);
  const planFile = path.join(dir, 'plan.tfplan');

  try {
    fs.mkdirSync(dir, { recursive: true });

    // 1) Per-session SSH keypair (private key stays on this server)
    const { priv, pub } = generateSshKeypair(dir);

    // 2) Copy the terraform module into the per-session directory so state,
    //    plan, and tfvars stay fully isolated per session.
    for (const f of fs.readdirSync(TERRAFORM_SRC)) {
      if (f.endsWith('.tf')) {
        fs.copyFileSync(path.join(TERRAFORM_SRC, f), path.join(dir, f));
      }
    }

    // 3) Write terraform.tfvars for this session
    const tfvars = [
      `project_id            = "${PROJECT_ID}"`,
      `region                = "${REGION}"`,
      `zone                  = "${ZONE}"`,
      `session_id            = "${sessionId}"`,
      `ssh_user              = "debian"`,
      `ssh_public_key_path   = "${pub}"`,
      `ssh_private_key_path  = "${priv}"`,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'terraform.tfvars'), tfvars);

    // 4) terraform init / plan / apply. The plan is saved locally as required.
    await run('terraform', ['init', '-input=false', '-no-color'], dir);
    await run(
      'terraform',
      ['plan', '-input=false', '-no-color', `-out=${planFile}`],
      dir
    );
    await run(
      'terraform',
      ['apply', '-input=false', '-no-color', '-auto-approve', planFile],
      dir
    );

    // 5) Read outputs -> the response payload
    const out = await run('terraform', ['output', '-json'], dir);
    const outputs = JSON.parse(out.stdout);

    const record = {
      session_id: sessionId,
      project_id: PROJECT_ID,
      region: REGION,
      zone: ZONE,
      vm_name: outputs.vm_name.value,
      vm_external_ip: outputs.vm_external_ip.value,
      vm_internal_ip: outputs.vm_internal_ip.value,
      vm_self_link: outputs.vm_self_link.value,
      session_tag: outputs.session_tag.value,
      ssh_user: 'debian',
      ssh_private_key_path: priv,
      ssh_public_key_path: pub,
      ssh_command: outputs.ssh_command.value,
      plan_file: planFile,
      state_dir: dir,
      created_at: new Date().toISOString(),
    };

    const sessions = loadSessions();
    sessions[sessionId] = record;
    saveSessions(sessions);

    res.status(201).json(record);
  } catch (err) {
    // Surface the failure but leave the partial session dir on disk for debugging
    console.error(`[create-session ${sessionId}] FAILED:`, err.message);
    res.status(500).json({
      error: err.message,
      session_id: sessionId,
      state_dir: dir,
      hint: 'Inspect sessions/<id>/ and sessions.json for details.',
    });
  }
});

// Tear down a session: runs `terraform destroy` in that session's dir.
app.post('/destroy-session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const dir = sessionDir(sessionId);

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'unknown session', session_id: sessionId });
  }

  try {
    await run('terraform', ['destroy', '-input=false', '-no-color', '-auto-approve'], dir);

    const sessions = loadSessions();
    delete sessions[sessionId];
    saveSessions(sessions);

    res.json({ session_id: sessionId, destroyed: true });
  } catch (err) {
    console.error(`[destroy-session ${sessionId}] FAILED:`, err.message);
    res.status(500).json({ error: err.message, session_id: sessionId });
  }
});

// List sessions
app.get('/sessions', (_req, res) => res.json(loadSessions()));

// Get one session
app.get('/sessions/:sessionId', (req, res) => {
  const sessions = loadSessions();
  const s = sessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error: 'unknown session' });
  res.json(s);
});

app.listen(PORT, () => {
  console.log(`session-vm-service listening on http://localhost:${PORT}`);
  console.log(`  project=${PROJECT_ID} region=${REGION} zone=${ZONE}`);
  console.log(`  terraform src: ${TERRAFORM_SRC}`);
  console.log(`  sessions dir:  ${SESSIONS_DIR}`);
});
