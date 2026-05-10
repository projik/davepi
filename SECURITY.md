# Security policy

Thank you for helping keep dAvePi and its users safe. Tenant
isolation, auth, and the typed-error contract are the project's
hardest invariants — anything that breaks them is treated as a
security issue, not a bug.

## Reporting a vulnerability

**Don't open a public issue.** Use one of the private channels
below so we can ship a fix before the report is public.

- **GitHub private vulnerability reporting**:
  <https://github.com/projik/davepi/security/advisories/new>
  (Preferred — uses GitHub's built-in flow.)
- **Email**: `security@davepi.dev`
  (Available for reporters without a GitHub account.)

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a minimal schema and request.
- The dAvePi version (`npm ls davepi` or `git rev-parse HEAD`).
- Whether the issue has been disclosed elsewhere.

We don't currently maintain a GPG key. If you'd like to encrypt
your report, request the current key over the email above.

## What we consider in scope

- **Tenant isolation bypass.** Any path that lets one tenant read,
  write, or delete another tenant's data — REST, GraphQL, MCP,
  aggregations, relations.
- **Authentication / session bypass.** Token forgery, JWT verification
  flaws, session fixation, missing checks on protected routes.
- **ACL bypass.** Field-level read/create/update ACLs leaking via
  webhook payloads, audit log, or relation traversal.
- **Idempotency-key replay or confusion.** Two different operations
  collapsing under one key, or a key changing the response of a
  successfully-completed request.
- **State-machine bypass.** Persisting an undeclared transition.
- **Code execution / SSRF / injection.** Anything that lets an
  attacker run code or reach internal targets.
- **Sensitive data exposure.** Credentials, tokens, password hashes,
  or other secrets reaching logs, response bodies, or error pages.

## Out of scope

- Issues that require an attacker to already have valid credentials
  AND administrator role on the same tenant — that's the operator,
  by design.
- Self-XSS or social engineering.
- Vulnerabilities in optional templates or example projects (please
  still report them, but expect a slower SLA).
- Reports relying on browser, OS, or third-party-library bugs that
  aren't reachable through dAvePi's APIs.
- Volumetric DoS reports without a specific amplification primitive
  (rate limiters mitigate the obvious cases).

## Response timeline

We aim to:

| Step | Target |
|------|--------|
| Acknowledge receipt | within 3 business days |
| Triage decision (in-scope, severity) | within 7 business days |
| Coordinated disclosure window | 90 days from acknowledgement, sooner if a patch ships |
| Patch release | as fast as the fix and its tests allow; critical issues hot-patch within 7 days |

If you don't hear back within the acknowledgement window, please
follow up — emails sometimes get caught in filters.

## Supported versions

dAvePi follows semver from v1.0.0 onward (see
[Stability commitments](https://docs.davepi.dev/reference/stability/)).

| Version line | Status |
|--------------|--------|
| 1.x (current) | Supported with security fixes. |
| Pre-1.0 (`0.x`) | Best-effort only; please upgrade. |

When a 2.0 ships, the previous major (1.x) will receive security
fixes for at least 6 months from the 2.0 release date.

## Disclosure

Once a fix is released, we'll publish a [GitHub Security Advisory](https://github.com/projik/davepi/security/advisories)
that credits the reporter (with permission) and links to the patch.
A `## Security` section in the [CHANGELOG](./CHANGELOG.md) will
note the affected versions and the fix.

## Hall of fame

Researchers who report valid issues are listed below (with their
permission). Empty for now — be the first.

<!-- Begin hall of fame -->
<!-- End hall of fame -->
