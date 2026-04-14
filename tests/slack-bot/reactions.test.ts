import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackReactionController } from '../../src/slack-bot/reactions';
import type { ReactionsConfig } from '../../src/types';

function makeClient() {
  const adds: Array<Record<string, unknown>> = [];
  const removes: Array<Record<string, unknown>> = [];

  return {
    adds,
    removes,
    reactions: {
      add: vi.fn(async (args: Record<string, unknown>) => {
        adds.push(args);
        return {};
      }),
      remove: vi.fn(async (args: Record<string, unknown>) => {
        removes.push(args);
        return {};
      }),
    },
  };
}

const config: ReactionsConfig = {
  enabled: true,
  removeAfterReply: true,
  emojis: {
    queued: 'eyes',
    thinking: 'brain',
    tool: 'wrench',
    coding: 'technologist',
    web: 'globe_with_meridians',
    done: 'white_check_mark',
    error: 'x',
    stallSoft: 'hourglass_flowing_sand',
    stallHard: 'turtle',
  },
  timing: {
    debounceMs: 20,
    stallSoftMs: 50,
    stallHardMs: 100,
    doneHoldMs: 30,
    errorHoldMs: 30,
  },
};

describe('SlackReactionController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies queued immediately and debounces thinking', async () => {
    const client = makeClient();
    const controller = new SlackReactionController(client as any, {
      channelId: 'C1',
      messageTs: '100.1',
    }, config);

    await controller.setQueued();
    expect(client.adds).toHaveLength(1);
    expect(client.adds[0]).toMatchObject({ name: 'eyes' });

    const pending = controller.setThinking();
    await vi.advanceTimersByTimeAsync(20);
    await pending;

    expect(client.removes[0]).toMatchObject({ name: 'eyes' });
    expect(client.adds[1]).toMatchObject({ name: 'brain' });
  });

  it('classifies tool reactions by tool name', async () => {
    const client = makeClient();
    const controller = new SlackReactionController(client as any, {
      channelId: 'C1',
      messageTs: '100.1',
    }, config);

    await controller.setQueued();

    const coding = controller.setTool('exec_command');
    await vi.advanceTimersByTimeAsync(20);
    await coding;
    expect(client.adds.at(-1)).toMatchObject({ name: 'technologist' });

    const web = controller.setTool('web_search');
    await vi.advanceTimersByTimeAsync(20);
    await web;
    expect(client.adds.at(-1)).toMatchObject({ name: 'globe_with_meridians' });
  });

  it('switches to stall reactions after inactivity', async () => {
    const client = makeClient();
    const controller = new SlackReactionController(client as any, {
      channelId: 'C1',
      messageTs: '100.1',
    }, config);

    await controller.setQueued();

    await vi.advanceTimersByTimeAsync(50);
    expect(client.adds.at(-1)).toMatchObject({ name: 'hourglass_flowing_sand' });

    await vi.advanceTimersByTimeAsync(50);
    expect(client.adds.at(-1)).toMatchObject({ name: 'turtle' });
  });

  it('holds the done reaction briefly, then clears it', async () => {
    const client = makeClient();
    const controller = new SlackReactionController(client as any, {
      channelId: 'C1',
      messageTs: '100.1',
    }, config);

    await controller.setQueued();
    await controller.setDone();

    expect(client.adds.at(-1)).toMatchObject({ name: 'white_check_mark' });

    await vi.advanceTimersByTimeAsync(30);
    expect(client.removes.at(-1)).toMatchObject({ name: 'white_check_mark' });
  });
});
