## What does this PR do?

<!-- Brief description of the change -->

## Type of change

- [ ] New feature
- [ ] Bug fix
- [ ] Storage provider support
- [ ] Security hardening
- [ ] Documentation

## Testing done

- [ ] Build passes: `pnpm build`
- [ ] Lint passes: `pnpm lint`
- [ ] Sync operations tested (push/pull/bisync)
- [ ] Provider configuration tested (if applicable)
- [ ] Archive/restore tested (if applicable)
- [ ] E2E tests pass: `bash tests/e2e/run-all.sh`

## Security checklist

- [ ] No storage credentials in logs, error messages, or process arguments
- [ ] Shell commands use `execa` with array args (no string interpolation)
- [ ] New API inputs validated with Zod
- [ ] rclone.conf created with mode 0600
- [ ] Path validation applied to user-supplied paths (no null bytes, no `..`, max 4096)

## Notes for reviewers

<!-- Anything specific to look at, tricky logic, decisions made -->
