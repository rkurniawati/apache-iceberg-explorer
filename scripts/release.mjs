#!/usr/bin/env node

/**
 * Release Automation Script for Iceberg Explorer VS Code Extension
 * 
 * Automates:
 *  1. Version calculation (patch, minor, major, or custom)
 *  2. Updating package.json and package-lock.json
 *  3. Updating CHANGELOG.md with date and release notes
 *  4. Running test suite verification
 *  5. Git staging and commit
 *  6. Annotated Git tag creation (vX.Y.Z)
 *  7. Pushing commits and tags to origin (which triggers the GitHub Actions release workflow)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');

// ANSI Color Helpers
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

const c = {
  reset: colors.reset,
  bold: (t) => `${colors.bold}${t}${colors.reset}`,
  dim: (t) => `${colors.dim}${t}${colors.reset}`,
  green: (t) => `${colors.green}${t}${colors.reset}`,
  yellow: (t) => `${colors.yellow}${t}${colors.reset}`,
  blue: (t) => `${colors.blue}${t}${colors.reset}`,
  cyan: (t) => `${colors.cyan}${t}${colors.reset}`,
  red: (t) => `${colors.red}${t}${colors.reset}`,
};

for (const [k, v] of Object.entries(colors)) {
  if (typeof c[k] === 'function') {
    c[k].toString = () => v;
  }
}

function log(msg) { console.log(msg); }
function success(msg) { console.log(`${c.green}✔${c.reset} ${msg}`); }
function info(msg) { console.log(`${c.cyan}ℹ${c.reset} ${msg}`); }
function warn(msg) { console.log(`${c.yellow}⚠${c.reset} ${msg}`); }
function error(msg) { console.error(`${c.red}✖${c.reset} ${msg}`); }

function run(cmd, options = {}) {
  return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf-8', stdio: options.silent ? 'pipe' : 'inherit', ...options });
}

function runSilent(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return null;
  }
}

function parseSemver(versionStr) {
  const match = versionStr.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    raw: match[0],
  };
}

function bumpVersion(current, type) {
  if (type.toLowerCase() === 'current') {
    return current;
  }
  const parsed = parseSemver(current);
  if (!parsed) throw new Error(`Invalid current version: ${current}`);
  switch (type.toLowerCase()) {
    case 'major':
      return `${parsed.major + 1}.0.0`;
    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case 'patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    default: {
      const explicit = parseSemver(type);
      if (!explicit) {
        throw new Error(`Invalid version or bump type: "${type}". Expected current, patch, minor, major, or X.Y.Z`);
      }
      return explicit.raw;
    }
  }
}

function updateChangelog(changelogContent, newVersion, releaseNotes, dateStr) {
  // If this version is already documented in CHANGELOG.md, avoid duplicating it
  const existingVersionRegex = new RegExp(`^##\\s+\\[${newVersion.replace(/\\./g, '\\.')}\\]`, 'm');
  if (existingVersionRegex.test(changelogContent)) {
    if (!releaseNotes || releaseNotes.trim().length === 0) {
      return changelogContent;
    }
  }

  const unreleasedRegex = /^##\s+\[Unreleased\]\s*$/im;
  const versionHeaderRegex = /^##\s+\[(\d+\.\d+\.\d+)\]/m;

  let notesFormatted = '';
  if (releaseNotes && releaseNotes.trim().length > 0) {
    const trimmed = releaseNotes.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('-')) {
      notesFormatted = trimmed;
    } else {
      notesFormatted = `### Added / Changed\n- ${trimmed}`;
    }
  } else {
    notesFormatted = `### Maintenance\n- Release version v${newVersion}`;
  }

  if (unreleasedRegex.test(changelogContent)) {
    const parts = changelogContent.split(unreleasedRegex);
    const beforeUnreleased = parts[0];
    const afterUnreleased = parts[1];

    const nextHeadingIndex = afterUnreleased.search(/^##\s+/m);
    let unreleasedBody = '';
    let restOfChangelog = '';

    if (nextHeadingIndex !== -1) {
      unreleasedBody = afterUnreleased.slice(0, nextHeadingIndex).trim();
      restOfChangelog = afterUnreleased.slice(nextHeadingIndex);
    } else {
      unreleasedBody = afterUnreleased.trim();
    }

    let releaseBody = '';
    if (unreleasedBody.length > 0) {
      releaseBody = unreleasedBody;
      if (releaseNotes && releaseNotes.trim().length > 0) {
        releaseBody += `\n\n${notesFormatted}`;
      }
    } else {
      releaseBody = notesFormatted;
    }

    return `${beforeUnreleased.trimEnd()}\n\n## [Unreleased]\n\n## [${newVersion}] - ${dateStr}\n\n${releaseBody}\n\n${restOfChangelog.trimStart()}`.trimEnd() + '\n';
  } else {
    const match = changelogContent.match(versionHeaderRegex);
    if (match) {
      const index = match.index;
      const beforeFirstVersion = changelogContent.slice(0, index).trimEnd();
      const firstVersionAndRest = changelogContent.slice(index);

      return `${beforeFirstVersion}\n\n## [Unreleased]\n\n## [${newVersion}] - ${dateStr}\n\n${notesFormatted}\n\n${firstVersionAndRest}`.trimEnd() + '\n';
    } else {
      return `${changelogContent.trimEnd()}\n\n## [Unreleased]\n\n## [${newVersion}] - ${dateStr}\n\n${notesFormatted}\n`;
    }
  }
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    versionArg: null,
    notes: null,
    dryRun: process.env.npm_config_dry_run === 'true',
    noPush: false,
    noTest: false,
    allowDirty: false,
    forceTag: false,
    yes: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run' || arg === '--dry' || arg === 'dry' || arg === 'preview') {
      options.dryRun = true;
    } else if (arg === '--no-push' || arg === 'no-push') {
      options.noPush = true;
    } else if (arg === '--no-test' || arg === 'no-test') {
      options.noTest = true;
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true;
    } else if (arg === '--force' || arg === '-f' || arg === '--force-tag') {
      options.forceTag = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '--notes' || arg === '-m') {
      options.notes = args[++i];
    } else if (!arg.startsWith('-') && !options.versionArg) {
      options.versionArg = arg;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
${c.bold}Iceberg Explorer Release Automation${c.reset}

${c.bold}USAGE:${c.reset}
  npm run release [version | patch | minor | major] [OPTIONS]

${c.bold}OPTIONS:${c.reset}
  -m, --notes <text>    Release notes to include in CHANGELOG.md
  --dry-run             Simulate the release without modifying git or pushing
  --no-push             Create commit and git tag locally without pushing to origin
  --no-test             Skip running test suite before releasing
  --allow-dirty         Allow running even if working directory has other uncommitted changes
  -y, --yes             Skip confirmation prompts and accept defaults
  -h, --help            Show this help message

${c.bold}EXAMPLES:${c.reset}
  npm run release                      # Interactive release wizard
  npm run release patch                # Bump patch (0.0.1 -> 0.0.2)
  npm run release minor -m "New UI"    # Bump minor with release notes
  npm run release 0.2.0                # Set specific version
  npm run release patch --dry-run      # Preview release without committing
`);
}

async function main() {
  const options = parseCliArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  log(`\n${c.bold}${c.cyan}=== Iceberg Explorer Release Automation ===${c.reset}\n`);

  // 1. Verify Git Repository
  const isGit = runSilent('git rev-parse --is-inside-work-tree');
  if (isGit !== 'true') {
    error('Current directory is not a git repository.');
    process.exit(1);
  }

  const currentBranch = runSilent('git rev-parse --abbrev-ref HEAD') || 'main';
  info(`Current Git Branch: ${c.bold}${currentBranch}${c.reset}`);

  // Check working directory status
  const gitStatus = runSilent('git status --porcelain');
  if (gitStatus && !options.allowDirty) {
    warn('Working directory has uncommitted changes:\n');
    console.log(gitStatus.split('\n').map(l => `  ${l}`).join('\n'));
    log('');
    error('Please commit, stash, or run with --allow-dirty to proceed.');
    process.exit(1);
  }

  // 2. Read package.json
  if (!fs.existsSync(PKG_PATH)) {
    error(`package.json not found at ${PKG_PATH}`);
    process.exit(1);
  }

  const pkgJsonRaw = fs.readFileSync(PKG_PATH, 'utf-8');
  const pkg = JSON.parse(pkgJsonRaw);
  const currentVersion = pkg.version;
  info(`Current Version: ${c.bold}v${currentVersion}${c.reset}`);

  // 3. Determine Target Version
  let targetVersion = null;
  const isInteractive = process.stdin.isTTY && !options.yes;
  const currentTagExists = Boolean(runSilent(`git rev-parse -q --verify "refs/tags/v${currentVersion}"`));

  if (options.versionArg) {
    targetVersion = bumpVersion(currentVersion, options.versionArg);
  } else if (isInteractive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const patchV = bumpVersion(currentVersion, 'patch');
      const minorV = bumpVersion(currentVersion, 'minor');
      const majorV = bumpVersion(currentVersion, 'major');

      console.log(`\nSelect release type:`);
      if (!currentTagExists) {
        console.log(`  0) ${c.bold}current${c.reset} (${c.cyan}v${currentVersion}${c.reset}) ${c.dim}- initial release / untagged version${c.reset}`);
      }
      console.log(`  1) ${c.bold}patch${c.reset} (${c.green}v${patchV}${c.reset})`);
      console.log(`  2) ${c.bold}minor${c.reset} (${c.yellow}v${minorV}${c.reset})`);
      console.log(`  3) ${c.bold}major${c.reset} (${c.red}v${majorV}${c.reset})`);
      console.log(`  4) custom version`);

      const defaultChoice = !currentTagExists ? '0' : '1';
      const promptRange = !currentTagExists ? '0-4' : '1-4';
      const choice = (await rl.question(`\nEnter choice [${promptRange}] (default: ${defaultChoice}): `)).trim() || defaultChoice;

      if ((choice === '0' || choice.toLowerCase() === 'current') && !currentTagExists) {
        targetVersion = currentVersion;
      } else if (choice === '1' || choice.toLowerCase() === 'patch') {
        targetVersion = patchV;
      } else if (choice === '2' || choice.toLowerCase() === 'minor') {
        targetVersion = minorV;
      } else if (choice === '3' || choice.toLowerCase() === 'major') {
        targetVersion = majorV;
      } else if (choice === '4' || choice.toLowerCase() === 'custom') {
        const custom = await rl.question('Enter custom version (e.g. 0.0.1 or 0.1.0): ');
        targetVersion = bumpVersion(currentVersion, custom.trim());
      } else {
        targetVersion = bumpVersion(currentVersion, choice);
      }

      if (!options.notes) {
        const notesInput = await rl.question('\nEnter release notes (optional, press Enter to use default): ');
        if (notesInput.trim()) {
          options.notes = notesInput.trim();
        }
      }
    } finally {
      rl.close();
    }
  } else {
    // Default to patch in non-interactive mode without args
    targetVersion = bumpVersion(currentVersion, 'patch');
  }

  const tagName = `v${targetVersion}`;
  info(`Target Release: ${c.bold}${c.green}${tagName}${c.reset} (from v${currentVersion})`);

  // Check if tag already exists locally or remotely
  let tagAction = 'create'; // 'create' | 'retag' | 'use-existing'
  let needsForcePush = false;
  const existingLocalTag = runSilent(`git rev-parse -q --verify "refs/tags/${tagName}"`);
  const remoteTag = runSilent(`git ls-remote --tags origin refs/tags/${tagName}`);

  if (remoteTag) {
    const repoUrl = pkg.repository?.url?.replace(/\.git$/, '') || 'https://github.com/rkurniawati/apache-iceberg-explorer';
    warn(`Git tag "${tagName}" already exists on remote origin.`);
    info(`Existing release: ${repoUrl}/releases/tag/${tagName}`);

    if (options.dryRun) {
      warn(`[DRY RUN] Force re-release would overwrite tag "${tagName}" on remote.`);
      tagAction = 'retag';
      needsForcePush = true;
    } else {
      if (!options.forceTag) {
        if (isInteractive) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = (await rl.question(`Do you want to FORCE re-release and overwrite tag "${tagName}" on GitHub? [y/N]: `)).trim().toLowerCase();
          rl.close();
          if (answer !== 'y' && answer !== 'yes') {
            log(`\n${c.yellow}Release cancelled.${c.reset} To create a new release instead, run: ${c.green}npm run release patch${c.reset}\n`);
            process.exit(0);
          }
        } else {
          error(`Tag "${tagName}" already exists on remote. Use --force to overwrite.`);
          process.exit(1);
        }
      }

      warn(`Force re-release approved: "${tagName}" will be moved to current HEAD and force-pushed.`);
      tagAction = 'retag';
      needsForcePush = true;
    }
  } else if (existingLocalTag) {
    // Tag exists locally, but NOT on remote origin
    const tagCommit = runSilent(`git rev-list -n 1 refs/tags/${tagName}`) || '';
    const headCommit = runSilent('git rev-parse HEAD') || '';
    const isAtHead = tagCommit === headCommit;

    warn(`Tag "${tagName}" exists locally (${tagCommit.slice(0, 7)}) but has NOT been pushed to origin.`);

    if (options.dryRun) {
      if (!isAtHead) {
        info(`Current HEAD is at ${headCommit.slice(0, 7)}. In a real run, tag will be moved to HEAD.`);
      } else {
        info(`Tag already points to current HEAD.`);
      }
    } else {
      if (!isAtHead) {
        info(`Current HEAD is ${headCommit.slice(0, 7)} (different from tag commit ${tagCommit.slice(0, 7)}).`);
        if (isInteractive && !options.forceTag) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = (await rl.question(`Move tag "${tagName}" to current HEAD and push to origin? [Y/n]: `)).trim().toLowerCase();
          rl.close();
          if (answer === 'n' || answer === 'no') {
            warn('Release cancelled by user.');
            process.exit(0);
          }
        }
        tagAction = 'retag';
      } else {
        info(`Tag already points to current HEAD.`);
        if (isInteractive && !options.forceTag) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = (await rl.question(`Push unpushed tag "${tagName}" to origin now? [Y/n]: `)).trim().toLowerCase();
          rl.close();
          if (answer === 'n' || answer === 'no') {
            warn('Release cancelled by user.');
            process.exit(0);
          }
        }
        tagAction = 'use-existing';
      }
    }
  }

  // 4. Update Changelog preview
  let changelogContent = '';
  if (fs.existsSync(CHANGELOG_PATH)) {
    changelogContent = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
  } else {
    changelogContent = `# Change Log\n\nAll notable changes to the "iceberg-explorer" extension will be documented in this file.\n\n`;
  }

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const updatedChangelog = updateChangelog(changelogContent, targetVersion, options.notes, dateStr);

  // 5. Confirm Release Actions
  log(`\n${c.bold}Release Summary:${c.reset}`);
  log(`  • Version:        ${c.green}v${currentVersion}${c.reset} → ${c.bold}${c.green}v${targetVersion}${c.reset}`);
  log(`  • Git Tag:        ${c.bold}${tagName}${c.reset}`);
  log(`  • Files Changed:  package.json, package-lock.json, CHANGELOG.md`);
  log(`  • Run Tests:      ${options.noTest ? c.yellow('Skipped (--no-test)') : c.green('Yes (npm test)')}`);
  log(`  • Git Push:       ${options.noPush || options.dryRun ? c.yellow('No (local only)') : c.green(`git push origin ${currentBranch} && git push origin ${tagName}`)}`);
  log(`  • GitHub Action:  ${options.dryRun || options.noPush ? c.dim('Will not trigger') : c.green('Triggers .github/workflows/release.yml to build VSIX')}`);

  if (options.dryRun) {
    info(`\n${c.bold}[DRY RUN MODE]${c.reset} No changes will be written or committed.`);
    log(`\n--- CHANGELOG.md Preview for [${targetVersion}] ---\n`);
    const previewLines = updatedChangelog.split('\n').slice(0, 35).join('\n');
    console.log(previewLines);
    log(`\n${c.green}✔ Dry run completed successfully.${c.reset}\n`);
    process.exit(0);
  }

  if (isInteractive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirm = (await rl.question(`\nProceed with release ${c.bold}${tagName}${c.reset}? [y/N]: `)).trim().toLowerCase();
    rl.close();
    if (confirm !== 'y' && confirm !== 'yes') {
      warn('Release cancelled by user.');
      process.exit(0);
    }
  }

  // 6. Execute Tests
  if (!options.noTest) {
    info('\nRunning test suite (npm test)...');
    try {
      run('npm test');
      success('All test suites passed.');
    } catch (err) {
      error('Tests failed! Aborting release to keep repo intact.');
      process.exit(1);
    }
  }

  // Backup files in case of mid-flight error
  let modifiedFiles = false;
  try {
    // 7. Update package.json and package-lock.json
    if (targetVersion !== currentVersion) {
      info('\nUpdating package.json & package-lock.json...');
      run(`npm version ${targetVersion} --no-git-tag-version --allow-same-version`);
      modifiedFiles = true;
      success(`Updated package version to ${targetVersion}`);
    } else {
      info(`\nVersion is already at ${targetVersion}.`);
    }

    // 8. Update CHANGELOG.md
    if (updatedChangelog !== changelogContent) {
      info('Updating CHANGELOG.md...');
      fs.writeFileSync(CHANGELOG_PATH, updatedChangelog, 'utf-8');
      modifiedFiles = true;
      success(`Updated CHANGELOG.md with ${tagName} entry`);
    } else {
      info(`CHANGELOG.md is already up to date for ${tagName}.`);
    }

    // 9. Git commit
    const hasChanges = Boolean(runSilent('git status --porcelain package.json package-lock.json CHANGELOG.md'));
    if (hasChanges) {
      info('Committing release files...');
      run('git add package.json package-lock.json CHANGELOG.md');
      run(`git commit -m "chore(release): ${tagName}"`);
      success(`Committed release changes with message "chore(release): ${tagName}"`);
    } else {
      info('No file changes to commit (working tree already aligned).');
    }

    // 10. Git tag
    const tagMsg = options.notes ? `Release ${tagName}: ${options.notes}` : `Release ${tagName}`;
    if (tagAction === 'retag') {
      info(`Updating git tag ${tagName} to current HEAD...`);
      run(`git tag -fa ${tagName} -m "${tagMsg}"`);
      success(`Updated git tag ${tagName} to current HEAD`);
    } else if (tagAction === 'use-existing') {
      info(`Reusing existing local git tag ${tagName}...`);
    } else {
      info(`Creating annotated git tag ${tagName}...`);
      run(`git tag -a ${tagName} -m "${tagMsg}"`);
      success(`Created git tag ${tagName}`);
    }

    // 11. Git push
    if (!options.noPush) {
      info(`Pushing commit and tag to origin...`);
      run(`git push origin ${currentBranch}`);
      run(`git push origin ${tagName}${needsForcePush ? ' --force' : ''}`);
      success(`Pushed branch ${currentBranch} and tag ${tagName} to origin`);

      const repoUrl = pkg.repository?.url?.replace(/\.git$/, '') || 'https://github.com/rkurniawati/apache-iceberg-explorer';
      log(`\n${c.bold}${c.green}🎉 Release ${tagName} successfully triggered!${c.reset}`);
      log(`  • GitHub Actions Run: ${c.cyan}${repoUrl}/actions${c.reset}`);
      log(`  • GitHub Release:     ${c.cyan}${repoUrl}/releases/tag/${tagName}${c.reset}\n`);
    } else {
      success(`Release ${tagName} created locally (push skipped via --no-push)`);
      log(`To push manually when ready:\n  git push origin ${currentBranch} && git push origin ${tagName}\n`);
    }

  } catch (err) {
    error(`Release execution error: ${err.message}`);
    if (modifiedFiles && !runSilent(`git rev-parse -q --verify "refs/tags/${tagName}"`)) {
      warn('Rolling back modified unstaged files...');
      runSilent('git checkout package.json package-lock.json CHANGELOG.md');
    }
    process.exit(1);
  }
}

main().catch(err => {
  if (err.name === 'AbortError' || err.message?.includes('Ctrl+C') || err.message?.includes('SIGINT')) {
    log(`\n${c.yellow}Release cancelled.${c.reset}\n`);
    process.exit(0);
  }
  error(`Unhandled error: ${err.message}`);
  process.exit(1);
});
