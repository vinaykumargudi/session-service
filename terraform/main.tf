terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  backend "local" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# Locals used for naming + tagging
locals {
  vm_name       = "vm-${var.session_id}"
  firewall_name = "fw-allow-ssh-${var.session_id}"
  session_tag   = "session-${var.session_id}"
  common_labels = {
    session_id = var.session_id
    managed_by = "session-vm-service"
  }
}

# VM: small (e2-micro), Debian 12, no extra disks (boot disk only)
resource "google_compute_instance" "vm" {
  name         = local.vm_name
  machine_type = "e2-micro"
  zone         = var.zone

  labels = merge(
    local.common_labels,
    {
      created_at = formatdate("YYYY-MM-DD", timestamp())
    }
  )
  tags = ["ssh", local.session_tag]

  # Boot disk only — no external/additional persistent disks
  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
      type  = "pd-standard"
    }
  }

  network_interface {
    network = "default"

    # Ephemeral external IP -> reachable from the public internet
    access_config {}
  }

  # Inject SSH public key so the user can ssh in directly
  metadata = {
    ssh-keys = "${var.ssh_user}:${file(var.ssh_public_key_path)}"
  }

  metadata_startup_script = <<-EOT
    #!/bin/bash
    echo "Session ${var.session_id} VM is ready." | tee /etc/motd
  EOT

  # Make sure the firewall exists before the VM is created
  depends_on = [google_compute_firewall.ssh_session]
}

# Firewall rule: allow SSH (tcp/22) from the public internet, scoped to this session's VM via tag
resource "google_compute_firewall" "ssh_session" {
  name        = local.firewall_name
  network     = "default"
  description = "Allow SSH from public internet to session ${var.session_id} VM"

  direction = "INGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = [local.session_tag]

  labels = local.common_labels
}

# Outputs the server reads to return to the caller
output "vm_name" {
  value = google_compute_instance.vm.name
}

output "vm_external_ip" {
  value = google_compute_instance.vm.network_interface[0].access_config[0].nat_ip
}

output "vm_internal_ip" {
  value = google_compute_instance.vm.network_interface[0].network_ip
}

output "vm_self_link" {
  value = google_compute_instance.vm.self_link
}

output "ssh_command" {
  value = "ssh -i ${var.ssh_private_key_path} -o StrictHostKeyChecking=no ${var.ssh_user}@${google_compute_instance.vm.network_interface[0].access_config[0].nat_ip}"
}

output "session_tag" {
  value = local.session_tag
}
