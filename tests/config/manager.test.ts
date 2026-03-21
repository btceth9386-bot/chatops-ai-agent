import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationManager } from '../../src/config/manager';

describe('ConfigurationManager', () => {
  async function setupFiles() {
    const dir = await mkdtemp(join(tmpdir(), 'chatops-config-'));
    const channelsPath = join(dir, 'channels.json');
    const mcpPath = join(dir, 'mcp-services.json');

    await writeFile(
      channelsPath,
      JSON.stringify([{ channelId: 'C1', mode: 'mention_based', responseMode: 'thread_reply' }]),
      'utf8'
    );
    await writeFile(mcpPath, JSON.stringify({ logs: { allowedServices: ['a'] } }), 'utf8');

    return { channelsPath, mcpPath };
  }

  it('loads and validates config', async () => {
    const { channelsPath, mcpPath } = await setupFiles();
    const mgr = new ConfigurationManager({ channelsPath, mcpServicesPath: mcpPath });
    const loaded = await mgr.load();

    expect(loaded.channelAllowlist).toHaveLength(1);
    expect(mgr.getLastValidConfig()).not.toBeNull();
  });

  it('rejects invalid channel mode', async () => {
    const { channelsPath, mcpPath } = await setupFiles();
    await writeFile(channelsPath, JSON.stringify([{ channelId: 'C1', mode: 'bad-mode' }]), 'utf8');

    const mgr = new ConfigurationManager({ channelsPath, mcpServicesPath: mcpPath });
    await expect(mgr.load()).rejects.toThrow('invalid channel mode');
  });

  it('retains last valid config after invalid reload attempt', async () => {
    const { channelsPath, mcpPath } = await setupFiles();
    const mgr = new ConfigurationManager({ channelsPath, mcpServicesPath: mcpPath });

    const first = await mgr.load();
    expect(first.channelAllowlist[0].channelId).toBe('C1');

    await writeFile(channelsPath, JSON.stringify([{ channelId: 'C1', mode: 'invalid' }]), 'utf8');
    await expect(mgr.load()).rejects.toThrow();

    const last = mgr.getLastValidConfig();
    expect(last?.channelAllowlist[0].mode).toBe('mention_based');
  });

  it('hot-reloads valid updates via watch()', async () => {
    const { channelsPath, mcpPath } = await setupFiles();
    const mgr = new ConfigurationManager({ channelsPath, mcpServicesPath: mcpPath });
    await mgr.load();

    const reloaded = new Promise<boolean>((resolve) => {
      mgr.watch((cfg) => {
        resolve(cfg.channelAllowlist[0]?.channelId === 'C2');
      });
    });

    await writeFile(
      channelsPath,
      JSON.stringify([{ channelId: 'C2', mode: 'auto_investigation', responseMode: 'thread_reply' }]),
      'utf8'
    );

    await expect(reloaded).resolves.toBe(true);
  });
});
