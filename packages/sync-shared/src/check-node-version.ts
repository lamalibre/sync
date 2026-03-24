const MINIMUM_NODE_VERSION = 22;

export function checkNodeVersion(): void {
  const current = process.versions.node;
  const major = Number.parseInt(current.split('.')[0] ?? '0', 10);

  if (major < MINIMUM_NODE_VERSION) {
    process.stderr.write(
      `\nError: Node.js ${MINIMUM_NODE_VERSION}+ is required (current: ${current}).\n` +
        `Download the latest version at https://nodejs.org/\n\n`,
    );
    process.exit(1);
  }
}
