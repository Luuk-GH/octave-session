// Writes dist/README.vsix.md, the README packaged in the .vsix (and shown on the Marketplace page).
// The Marketplace and VS Code's Extensions page only show images from https URLs. With a GitHub "repository" in
// package.json, local images (media/...) become raw.githubusercontent.com URLs of the default branch, so they show
// once the repository is public and pushed. Without one, local images are left out (they would show as broken).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
const gh = repoUrl && /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(repoUrl);
const branch = process.env.README_BRANCH ?? 'main';
const base = gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${branch}/` : undefined;

const md = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(
  /^(!\[[^\]]*\]\()((?!https?:|data:)[^)]+)(\))\r?\n(\r?\n)?/gm,
  (all, open, rel, close, blank) => {
    if (!base) { return ''; }
    if (!fs.existsSync(path.join(root, rel))) { throw new Error(`README image not found: ${rel}`); }
    return `${open}${base}${rel}${close}\n${blank ?? ''}`;
  });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'README.vsix.md'), md);
console.log(base ? `README images from ${base}` : 'README images left out (no GitHub "repository" in package.json)');
