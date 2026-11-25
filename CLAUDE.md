# Octave VS Code extension
Goal: MATLAB-extension-like experience for GNU Octave in VS Code.
Read PLAN.md before starting. Decisions: one self-contained TypeScript extension,
Windows target, persistent octave-cli session, v1 = run file/selection/%% section + breakpoint debugging.
Commands: npm install; npm run compile; npm run package (builds the .vsix); press F5 in VS Code for the Extension Development Host.
Tests: npm run test:unit (includes the MCP protocol/HTTP tests, scripts/mcp.test.ts, the command queue and control records); npm run smoke; npm run smoke:debug; npm run test:prompts; npm run test:integration (also drives the Command Window webview through its test hooks).
Project: ~\Projects\octave-extension. Octave (dev machine): C:\Program Files\GNU Octave\Octave-11.1.0\mingw64\bin (octave-gui.exe --no-gui is spawned). Test .m files live in /test.
Spike findings (interrupt, figures, debugger behaviour) are in spike/RESULTS.md.