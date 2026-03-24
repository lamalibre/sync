// ============================================================================
// Snapshot Tools — snapshot_create, snapshot_restore, snapshot_list
// ============================================================================

import { z } from 'zod';
import * as mp from '../lib/multipass.js';
import { ALL_VMS, VM_NAME_MAP, CHECKPOINTS } from '../config.js';

export const snapshotCreateTool = {
  name: 'snapshot_create',
  description:
    'Create a named snapshot of one or all E2E VMs. ' +
    'VMs must be stopped first (this tool stops and restarts them). ' +
    'Use checkpoints like "post-create" or "post-setup" for standard save-points.',
  inputSchema: z.object({
    name: z.string().describe('Snapshot name (e.g. "post-setup", "before-test-5")'),
    vms: z
      .array(z.enum(['host', 'agent']))
      .default(['host', 'agent'])
      .describe('Which VMs to snapshot (default: both)'),
  }),
  async handler({ name, vms } = {}) {
    vms = vms || ['host', 'agent'];
    const vmNames = vms.map((v) => VM_NAME_MAP[v]);

    // Stop VMs (required for multipass snapshots)
    await Promise.all(vmNames.map((vm) => mp.run(['stop', vm], { allowFailure: true })));

    // Create snapshots
    const results = {};
    for (const vm of vmNames) {
      try {
        await mp.snapshot(vm, name);
        results[vm] = 'created';
      } catch (err) {
        results[vm] = `failed: ${err.message}`;
      }
    }

    // Restart VMs
    await Promise.all(vmNames.map((vm) => mp.run(['start', vm], { allowFailure: true })));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, snapshot: name, results }, null, 2),
        },
      ],
    };
  },
};

export const snapshotRestoreTool = {
  name: 'snapshot_restore',
  description:
    'Restore one or all E2E VMs to a named snapshot. ' +
    'Destructive: all changes since the snapshot are lost. ' +
    'Much faster than reprovisioning.',
  inputSchema: z.object({
    name: z.string().describe('Snapshot name to restore'),
    vms: z
      .array(z.enum(['host', 'agent']))
      .default(['host', 'agent'])
      .describe('Which VMs to restore (default: both)'),
  }),
  async handler({ name, vms } = {}) {
    vms = vms || ['host', 'agent'];
    const vmNames = vms.map((v) => VM_NAME_MAP[v]);

    // Stop VMs
    await Promise.all(vmNames.map((vm) => mp.run(['stop', vm], { allowFailure: true })));

    // Restore snapshots
    const results = {};
    for (const vm of vmNames) {
      try {
        await mp.restore(vm, name);
        results[vm] = 'restored';
      } catch (err) {
        results[vm] = `failed: ${err.message}`;
      }
    }

    // Restart VMs
    await Promise.all(vmNames.map((vm) => mp.run(['start', vm], { allowFailure: true })));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, snapshot: name, results }, null, 2),
        },
      ],
    };
  },
};

export const snapshotListTool = {
  name: 'snapshot_list',
  description: 'List available snapshots for the E2E VMs.',
  inputSchema: z.object({}),
  async handler() {
    const snapshots = {};
    for (const vm of ALL_VMS) {
      const snaps = await mp.listSnapshots(vm);
      if (snaps.length > 0) {
        snapshots[vm] = snaps;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              snapshots,
              checkpoints: CHECKPOINTS,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
