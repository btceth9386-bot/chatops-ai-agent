import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackStreamController } from '../../src/slack-bot/stream-controller';
import type { SlackClientLike, SlackStreamTarget } from '../../src/slack-bot/stream-controller';

function makeClient(): SlackClientLike & {
  posts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let postCounter = 0;
  return {
    posts,
    updates,
    chat: {
      postMessage: vi.fn(async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: `msg-${++postCounter}` };
      }),
      update: vi.fn(async (args: Record<string, unknown>) => {
        updates.push(args);
        return { ts: args.ts as string };
      }),
    },
  };
}

const target: SlackStreamTarget = {
  channelId: 'C1',
  threadTs: '100.1',
  responseMode: 'thread_reply',
};

describe('SlackStreamController', () => {
  let client: ReturnType<typeof makeClient>;
  let ctrl: SlackStreamController;

  beforeEach(() => {
    client = makeClient();
    ctrl = new SlackStreamController(client);
  });

  it('ensurePlaceholder posts a message and returns ts', async () => {
    const ts = await ctrl.ensurePlaceholder(target);
    expect(ts).toBe('msg-1');
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]).toMatchObject({ channel: 'C1', thread_ts: '100.1' });
  });

  it('ensurePlaceholder reuses existing ts', async () => {
    const ts = await ctrl.ensurePlaceholder(target, 'existing-ts');
    expect(ts).toBe('existing-ts');
    expect(client.posts).toHaveLength(0);
  });

  it('complete updates placeholder with final text', async () => {
    await ctrl.complete(target, 'ph-1', 'Final answer');
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toMatchObject({ ts: 'ph-1', text: 'Final answer' });
  });

  it('complete splits long text into multiple messages', async () => {
    const longText = 'A'.repeat(4000) + '\n\n' + 'B'.repeat(2000);
    await ctrl.complete(target, 'ph-1', longText);

    // First part updates the placeholder
    expect(client.updates).toHaveLength(1);
    expect((client.updates[0].text as string).length).toBeLessThanOrEqual(3900);

    // Remaining parts posted as follow-up
    expect(client.posts.length).toBeGreaterThanOrEqual(1);
    expect(client.posts[0]).toMatchObject({ channel: 'C1', thread_ts: '100.1' });
  });

  it('complete uses "Done." for empty text', async () => {
    await ctrl.complete(target, 'ph-1', '   ');
    expect(client.updates[0].text).toBe('Done.');
  });

  it('pushDelta truncates text exceeding Slack limit', async () => {
    const huge = 'X'.repeat(5000);
    await ctrl.pushDelta(target, 'ph-1', huge);

    // Wait for throttled flush
    await new Promise((r) => setTimeout(r, 1100));

    expect(client.updates).toHaveLength(1);
    const flushed = client.updates[0].text as string;
    expect(flushed.length).toBeLessThanOrEqual(3920); // 3900 + "…(streaming)"
    expect(flushed).toContain('…(streaming)');
  });

  it('fail strips stack traces and truncates', async () => {
    const error = 'Something broke\n    at Object.<anonymous> (/app/src/index.ts:42:5)\n    at Module._compile';
    await ctrl.fail(target, 'ph-1', error);
    expect(client.updates).toHaveLength(1);
    const text = client.updates[0].text as string;
    expect(text).toBe('⚠️ Request failed: Something broke');
    expect(text).not.toContain('at Object');
  });

  it('fail truncates long single-line errors to 200 chars', async () => {
    const error = 'E'.repeat(300);
    await ctrl.fail(target, 'ph-1', error);
    const text = client.updates[0].text as string;
    expect(text).toContain('…');
    // "⚠️ Request failed: " prefix + 200 chars + "…"
    expect(text.length).toBeLessThan(230);
  });

  it('complete splits multi-byte (CJK) text by byte length', async () => {
    // 2000 Chinese chars = 6000 bytes, exceeds 3900-byte limit
    const cjkText = '中'.repeat(2000);
    await ctrl.complete(target, 'ph-1', cjkText);

    expect(client.updates).toHaveLength(1);
    expect(Buffer.byteLength(client.updates[0].text as string, 'utf8')).toBeLessThanOrEqual(3900);

    // Should have at least one follow-up message
    expect(client.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('pushDelta truncates multi-byte text by byte length', async () => {
    // 2000 Chinese chars = 6000 bytes, well over 3900
    const cjkText = '中'.repeat(2000);
    await ctrl.pushDelta(target, 'ph-1', cjkText);

    await new Promise((r) => setTimeout(r, 1100));

    expect(client.updates).toHaveLength(1);
    const flushed = client.updates[0].text as string;
    expect(Buffer.byteLength(flushed, 'utf8')).toBeLessThanOrEqual(3900);
    expect(flushed).toContain('…(streaming)');
  });

  it('resolves publish_channel target correctly', async () => {
    const pubTarget: SlackStreamTarget = {
      channelId: 'C1',
      threadTs: '100.1',
      responseMode: 'publish_channel',
      publishChannelId: 'C-PUB',
    };
    await ctrl.complete(pubTarget, 'ph-1', 'Published');
    expect(client.updates[0].channel).toBe('C-PUB');
  });
});
