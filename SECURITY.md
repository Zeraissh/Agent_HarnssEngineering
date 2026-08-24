# Security policy

## Supported deployment

Security fixes target the latest revision of the main branch. The supported production profile is a
single-operator host behind TLS, using a 32+ character access token, an exact Origin/Host allowlist,
an encrypted history volume, and remote bash disabled. Multi-tenant or anonymous Internet exposure
is not supported.

## Reporting a vulnerability

Do not include credentials, transcripts, customer files, or an exploit payload in a public issue.
Contact the repository maintainers through the private channel used for release credentials and
include the affected revision, deployment topology, minimal reproduction, and impact. Rotate any
token or model key that may have been exposed before sharing diagnostics.

## Operational response

For an authentication, Origin/Host, path-boundary, or command-execution bypass, remove traffic
immediately and roll back to the last known signed/image-digest release. Preserve logs and the
history volume for investigation, but do not copy them into the repository.
