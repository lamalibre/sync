// ============================================================================
// VM Lifecycle Tools — vm_create, vm_list, vm_delete, vm_exec
// ============================================================================

import { z } from 'zod';
import * as mp from '../lib/multipass.js';
import { setVmState, removeVmState } from '../lib/state.js';
import { ALL_VMS, VM_NAME_MAP, PROFILES } from '../config.js';

export const vmCreateTool = {
  name: 'vm_create',
  description:
    'Create E2E test VMs (sync-host, sync-agent) with the specified resource profile. ' +
    'Deletes any existing VMs with the same names first. ' +
    'Returns the IPs of the created VMs.',
  inputSchema: z.object({
    profile: z
      .enum(['production', 'development', 'performance'])
      .default('development')
      .describe('Resource profile for the VMs'),
    vms: z
      .array(z.enum(['host', 'agent']))
      .default(['host', 'agent'])
      .describe('Which VMs to create (default: both)'),
  }),
  async handler({ profile, vms } = {}) {
    profile = profile || 'development';
    vms = vms || ['host', 'agent'];
    const spec = PROFILES[profile];
    const vmNames = vms.map((v) => VM_NAME_MAP[v]);

    // Delete existing VMs in parallel
    await Promise.all(vmNames.map((name) => mp.deleteVm(name)));

    // Launch VMs in parallel
    const results = await Promise.allSettled(
      vmNames.map((name) =>
        mp.launch(name, { cpus: spec.cpus, memory: spec.memory, disk: spec.disk }),
      ),
    );

    // Collect IPs and status
    const vmStatus = {};
    for (let i = 0; i < vmNames.length; i++) {
      const name = vmNames[i];
      if (results[i].status === 'fulfilled') {
        const ip = await mp.getIp(name);
        vmStatus[name] = { state: 'Running', ip, profile };
        setVmState(name, { ip, profile, state: 'Running' });
      } else {
        vmStatus[name] = { state: 'failed', error: results[i].reason?.message };
      }
    }

    const allOk = Object.values(vmStatus).every((v) => v.state === 'Running');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: allOk, profile, spec, vms: vmStatus }, null, 2),
        },
      ],
    };
  },
};

export const vmListTool = {
  name: 'vm_list',
  description: 'List all Multipass VMs, highlighting the E2E test VMs (sync-host, sync-agent).',
  inputSchema: z.object({}),
  async handler() {
    const data = await mp.list();
    const allVms = data.list || [];

    // Filter to E2E VMs
    const e2eVms = {};
    for (const vm of allVms) {
      if (ALL_VMS.includes(vm.name)) {
        e2eVms[vm.name] = {
          state: vm.state,
          ipv4: vm.ipv4?.[0] || null,
          release: vm.release,
        };
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              e2eVms,
              totalMultipassVms: allVms.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const vmDeleteTool = {
  name: 'vm_delete',
  description: 'Delete E2E test VMs. Defaults to deleting both sync-host and sync-agent.',
  inputSchema: z.object({
    vms: z
      .array(z.enum(['host', 'agent']))
      .default(['host', 'agent'])
      .describe('Which VMs to delete (default: both)'),
  }),
  async handler({ vms } = {}) {
    vms = vms || ['host', 'agent'];
    const vmNames = vms.map((v) => VM_NAME_MAP[v]);

    await Promise.all(
      vmNames.map(async (name) => {
        await mp.deleteVm(name);
        removeVmState(name);
      }),
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, deleted: vmNames }, null, 2),
        },
      ],
    };
  },
};

export const vmExecTool = {
  name: 'vm_exec',
  description:
    'Execute a command on a specific E2E VM. ' + 'Useful for debugging and inspecting VM state.',
  inputSchema: z.object({
    vm: z.enum(['host', 'agent']).describe('Target VM'),
    command: z.string().describe('Shell command to execute'),
    sudo: z.coerce.boolean().default(false).describe('Run with sudo'),
    timeout: z.coerce.number().int().default(30000).describe('Timeout in ms'),
  }),
  async handler({ vm, command, sudo, timeout } = {}) {
    const vmName = VM_NAME_MAP[vm];
    const result = await mp.exec(vmName, command, {
      sudo: sudo || false,
      allowFailure: true,
      timeout: timeout || 30_000,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              vm: vmName,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
