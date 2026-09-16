# Cloudflare Skills

Vendored from [cloudflare/skills](https://github.com/cloudflare/skills) (Apache 2.0 —
see LICENSE alongside this file).

Cloudflare's own setup path for these is a Claude Code plugin:

    /plugin marketplace add cloudflare/skills
    /plugin install cloudflare@cloudflare

That route isn't available on every account, and a plugin installed in a
remote session doesn't follow you to your own machine. Skills also load
straight from `.claude/skills/`, so keeping them in the repo gets the same
result for anyone who clones it — no plugin system involved, and no
per-machine setup.

To update: re-copy the `skills/` directory from that repo.

To use these in another project (the Cloak repo, say), copy this directory
there, or into `~/.claude/skills/` to have them everywhere.
