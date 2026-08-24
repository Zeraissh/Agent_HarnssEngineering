# Security policy

## Supported deployment

Security fixes target the latest revision of the main branch. The supported production profile is a
single-operator host behind TLS, using a 32+ character access token, an exact Origin/Host allowlist,
an encrypted history volume, and remote bash disabled. Multi-tenant or anonymous Internet exposure
is not supported.

## Credential-exposure boundaries

Three enforced boundaries reduce how far a leaked or injected instruction can reach:

- The launcher never prints the access token to stdout; the startup hint shows a placeholder, so
  persisted service logs (json-file, journald) never contain the credential.
- `bash` children run with a sanitized environment: variables whose names look like credentials
  (`*_API_KEY`, `*_TOKEN`, `*SECRET*`, `*_PASSWORD`, `*_ACCESS_KEY(_ID)`, …) are stripped before
  exec. Re-exposing a specific variable requires the explicit `AGENT_BASH_KEEP_ENV` allowlist.
- The approval-free `read_file` tool refuses credential-shaped files (`.env*`, `.npmrc`, `.netrc`,
  `id_rsa*`, `*.pem`; `.example`/`.sample` templates stay readable), so key material cannot be read
  without a human seeing the access. Reading them deliberately goes through the approval-gated
  `bash` tool.

Prompt-injected content that reaches the model can still request tool calls; the approval gate on
`bash`/`write_file` and the boundaries above are the defense. Treat fetched web content and files in
the workspace as untrusted input when reviewing approval prompts.

## Reporting a vulnerability

Do not include credentials, transcripts, customer files, or an exploit payload in a public issue.
Contact the repository maintainers through the private channel used for release credentials and
include the affected revision, deployment topology, minimal reproduction, and impact. Rotate any
token or model key that may have been exposed before sharing diagnostics.

## Operational response

For an authentication, Origin/Host, path-boundary, or command-execution bypass, remove traffic
immediately and roll back to the last known signed/image-digest release. Preserve logs and the
history volume for investigation, but do not copy them into the repository.
