# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security tab → *Report a vulnerability*) and include steps to reproduce.

Things we especially want to hear about:

- A plugin escaping its sandbox: reading files outside its own folder, reaching the network outside its declared
  `permissions.network` hosts, getting data topics it didn't declare, or running code in the app itself.
- Plugin installation (folder, zip or Git) writing outside the plugins folder.
- Anything that lets web content or terminal output run code.

## Plugins

Bundled plugins are reviewed by the maintainers. Plugins you install yourself from a folder, a zip or a Git
repository run in a sandbox, but they are still third-party code: only install plugins from people you trust.
