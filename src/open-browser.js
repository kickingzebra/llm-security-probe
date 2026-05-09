'use strict';

const { spawn } = require('node:child_process');

function buildOpenCommand(url, platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    case 'linux':
      return { command: 'xdg-open', args: [url] };
    default:
      throw new Error(`unsupported platform for --open: ${platform}`);
  }
}

function openBrowser(url, deps = {}) {
  const {
    spawnImpl = spawn,
    platform = process.platform
  } = deps;

  const { command, args } = buildOpenCommand(url, platform);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        detached: true,
        stdio: 'ignore'
      });
    } catch (err) {
      reject(err);
      return;
    }

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref?.();
      resolve();
    });
  });
}

module.exports = {
  openBrowser,
  buildOpenCommand
};
