# =============================================================================
# GitHub repository settings, branch protection, and deployment environments.
#
# This module does NOT create the repo — it manages settings on an existing one
# (the repo is created manually so that the GH-Actions billing/visibility
# defaults are picked deliberately).
#
# Bootstrap order in environments/privat:
#   1. Manual: create the repo at github.com/new (empty, public).
#   2. terraform apply — this module pulls it in via the data source and
#      converges settings, branch-protection, environments, and secrets.
# =============================================================================

# Reference the existing repo (sanity-check the name is correct).
data "github_repository" "this" {
  full_name = var.repository_full_name
}

# Manage settings on the existing repo. `name` is matched from the data source
# (Terraform import semantics handle the takeover on first apply).
resource "github_repository" "settings" {
  name                   = data.github_repository.this.name
  description            = var.repository_description
  visibility             = var.repository_visibility
  has_issues             = true
  has_wiki               = false
  has_projects           = false
  has_discussions        = false
  delete_branch_on_merge = true
  allow_squash_merge     = true
  allow_merge_commit     = false
  allow_rebase_merge     = false

  # `vulnerability_alerts` here is deprecated in provider >=6.x; a dedicated
  # resource (`github_repository_vulnerability_alerts`) handles it below.

  lifecycle {
    # Belt-and-braces guard against `terraform destroy` nuking the repo. Even
    # though this resource only manages settings, the provider would issue a
    # DELETE on the repo if removed from state.
    prevent_destroy = true

    # These fields only apply at repo CREATE time and would otherwise show
    # noisy plan diffs. They're irrelevant when we're managing an existing
    # repo.
    ignore_changes = [
      auto_init,
      gitignore_template,
      license_template,
      template,
    ]
  }
}

# Dependabot vulnerability alerts (dedicated resource — replaces the
# deprecated `vulnerability_alerts` flag on github_repository).
resource "github_repository_vulnerability_alerts" "this" {
  repository = github_repository.settings.name
  # Default enabled=true; explicit for clarity.
}

# -----------------------------------------------------------------------------
# Branch-protection for `main`.
# Solo-developer profile: no required reviewers, but the rest of the guardrails
# (no force-push, no deletion) stay in place to prevent accidents.
# -----------------------------------------------------------------------------
resource "github_branch_protection" "main" {
  repository_id = github_repository.settings.node_id
  pattern       = "main"

  required_status_checks {
    strict   = false # don't require up-to-date branch (allows merge of older PRs)
    contexts = []    # populate with CI-job-names once CI is wired up
  }

  required_pull_request_reviews {
    required_approving_review_count = 0 # solo-developer
    dismiss_stale_reviews           = true
  }

  enforce_admins          = false
  require_signed_commits  = false
  required_linear_history = false
  allows_force_pushes     = false
  allows_deletions        = false
}

# -----------------------------------------------------------------------------
# Environment: hetzner-production
# -----------------------------------------------------------------------------
resource "github_repository_environment" "hetzner_prod" {
  repository  = github_repository.settings.name
  environment = "hetzner-production"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

# Restrict environment-scoped deploys to the `main` branch (defence-in-depth
# alongside branch-protection above).
resource "github_repository_environment_deployment_policy" "hetzner_main_only" {
  repository     = github_repository.settings.name
  environment    = github_repository_environment.hetzner_prod.environment
  branch_pattern = "main"
}

# -----------------------------------------------------------------------------
# Environment: gcp-business (Phase-2 stub; opt-in via flag).
# -----------------------------------------------------------------------------
resource "github_repository_environment" "gcp_business" {
  count       = var.create_business_environment ? 1 : 0
  repository  = github_repository.settings.name
  environment = "gcp-business"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}
