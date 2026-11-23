variable "project_id" {
  type        = string
  description = "GCP project ID where the VM will be created."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP region."
}

variable "zone" {
  type        = string
  default     = "us-central1-a"
  description = "GCP zone."
}

variable "session_id" {
  type        = string
  description = "Unique session ID — used to name and tag all created resources."
}

variable "ssh_user" {
  type        = string
  default     = "debian"
  description = "Linux user account that will receive the injected SSH public key."
}

variable "ssh_public_key_path" {
  type        = string
  description = "Filesystem path to the SSH public key file used by the VM."
}

variable "ssh_private_key_path" {
  type        = string
  description = "Filesystem path to the SSH private key file (returned in ssh_command output)."
}
