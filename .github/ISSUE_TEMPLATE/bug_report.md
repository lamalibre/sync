---
name: Bug report
about: Something is broken
labels: bug
---

## Describe the bug

<!-- What happened? What did you expect? -->

## Component

- [ ] Server (`sync-server`)
- [ ] Agent (`sync-agent`)
- [ ] CLI (`sync-cli`)
- [ ] Desktop (`sync-desktop`)
- [ ] Installer (`create-sync`)

## Environment

- OS and version:
- Node.js version (`node --version`):
- rclone version (`rclone version`):
- Sync version:
- Storage provider:
- Sync direction (push/pull/bisync):

## Steps to reproduce

1.
2.
3.

## Error output

```
paste error here
```

## Relevant logs

```bash
# Check agent logs:
cat ~/.sync-agent/sync-agent.log | tail -50

# Check server logs:
cat ~/.sync/sync-server.log | tail -50

# Check rclone output:
rclone version
rclone listremotes
```
