# Octave agentic toolkit

Skills that teach AI agents (Claude Code, GitHub Copilot and other clients that read `SKILL.md` files) how to
work with GNU Octave through the **octave-session** VS Code extension's MCP server, in the user's live,
shared Octave session. Modelled on the core plugin of MathWorks' MATLAB Agentic Toolkit.

| Skill | Use it for |
|---|---|
| `octave-run-code` | Running code, scripts and functions; inspecting variables; help lookups. Shared-session etiquette. |
| `octave-debugging` | Reproduce → read the error → breakpoints / `dbstop if error` → step and inspect → fix → verify. |
| `octave-testing` | Octave's built-in test framework: `%!test`, `%!assert`, `%!error`, `test ()`, `oruntests ()`. |
| `octave-review-code` | Severity-ranked review: correctness, performance, robustness, Octave/MATLAB portability. |

The skills don't connect anything. First turn the server on in VS Code with **Octave: Set Up MCP Server**
and add it to your agent (the command copies the configuration).

## Install

**Claude Code** (plugin marketplace in this folder):

```
/plugin marketplace add C:/path/to/octave-extension/agent-toolkit
/plugin install octave-core@octave-agentic-toolkit
```

**Other agents / per project:** copy the folders under `octave-core/skills/` into the agent's skills folder,
for example `.claude/skills/` (Claude Code, one project), `.github/skills/` (GitHub Copilot in VS Code, one
project) or `~/.copilot/skills/` (Copilot, all projects).

## Layout

```
agent-toolkit/
  .claude-plugin/marketplace.json   marketplace "octave-agentic-toolkit"
  octave-core/
    .claude-plugin/plugin.json      plugin "octave-core"
    skills/<skill>/SKILL.md         one folder per skill (frontmatter: name, description, metadata.version)
```

The tool names the skills use (`octave_run`, `octave_run_file`, `octave_status`, `octave_workspace`,
`octave_get_value`, `octave_help`, `octave_interrupt`, `octave_debug`, `octave_breakpoints`) are defined in
`src/mcp/tools.ts`; keep the two in sync.
