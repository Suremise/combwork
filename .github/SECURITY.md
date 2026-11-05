# Security

## Reporting a vulnerability

Please report a security problem in Combwork privately, never in a public issue, pull request or discussion.

Use GitHub's private vulnerability reporting: on the repository's **Security** tab, click **Report a vulnerability**,
or go straight to [the form](https://github.com/Suremise/combwork/security/advisories/new). Only the maintainer
sees what you send.

Please include:

- what the problem is, and what someone could do with it;
- the steps to show it, or a proof of concept;
- the Combwork version (Help → About Combwork) and Windows version;
- whether it involves a coding agent's CLI (Claude Code, Codex, GitHub Copilot), and its version.

Leave out real tokens, keys and private files. If **Help → Copy Diagnostics…** helps, paste what it shows: it leaves
your own text out.

The maintainer replies in the report, and you can follow it there. Once a fix is released, the advisory is published,
and you are credited in it unless you'd rather not be.

A problem in a coding agent's CLI itself, rather than in how Combwork uses it, belongs to its maker: Anthropic for Claude
Code, OpenAI for Codex, GitHub for the Copilot CLI.

## Supported versions

Only the latest release gets security fixes. Installed copies of Combwork update themselves from
[GitHub Releases](https://github.com/Suremise/combwork/releases), so keeping updates on is the way to get them.
