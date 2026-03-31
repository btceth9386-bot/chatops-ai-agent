import { describe, expect, it } from 'vitest';
import { RoutingLayer } from '../../src/slack-bot/routing';
import type { LoadedConfig } from '../../src/config/manager';
import type { SlackEvent } from '../../src/types';

const config: LoadedConfig = {
  channelAllowlist: [
    { channelId: 'C1', mode: 'learning', responseMode: 'thread_reply' },
    { channelId: 'C2', mode: 'mention_based', responseMode: 'thread_reply' },
    { channelId: 'C3', mode: 'auto_investigation', responseMode: 'thread_reply' },
  ],
};

function makeEvent(overrides: Partial<SlackEvent> = {}): SlackEvent {
  return {
    type: 'message',
    messageText: 'hello',
    channelId: 'C1',
    threadTs: '123.456',
    userId: 'U1',
    timestamp: '123.456',
    ...overrides,
  };
}

describe('RoutingLayer', () => {
  it('ignores channels outside the allowlist', () => {
    const routing = new RoutingLayer(config);
    const decision = routing.decide(makeEvent({ channelId: 'OTHER' }));

    expect(decision.action).toBe('ignore');
    expect(decision.reason).toBe('channel_not_allowed');
  });

  it('routes learning channels to learning mode', () => {
    const routing = new RoutingLayer(config);
    const decision = routing.decide(makeEvent({ channelId: 'C1' }));

    expect(decision.action).toBe('learning');
  });

  it('requires mentions for mention_based channels', () => {
    const routing = new RoutingLayer(config);
    const ignored = routing.decide(makeEvent({ channelId: 'C2', type: 'message' }));
    const accepted = routing.decide(makeEvent({ channelId: 'C2', type: 'app_mention' }));

    expect(ignored.action).toBe('ignore');
    expect(ignored.reason).toBe('mention_required');
    expect(accepted.action).toBe('acp_prompt');
  });

  it('detects explicit escalation commands', () => {
    const routing = new RoutingLayer(config);
    const decision = routing.decide(makeEvent({ channelId: 'C3', messageText: 'escalate' }));

    expect(decision.action).toBe('escalate');
  });

  it.each(['escalate', '/escalate', '/architect', '<@U123BOT> escalate', '<@U123BOT>  /architect'])(
    'recognises escalation variant: %s',
    (text) => {
      const routing = new RoutingLayer(config);
      const decision = routing.decide(makeEvent({ channelId: 'C3', messageText: text }));
      expect(decision.action).toBe('escalate');
    },
  );

  it('detects explicit de-escalation commands', () => {
    const routing = new RoutingLayer(config);
    const decision = routing.decide(makeEvent({ channelId: 'C3', messageText: 'de-escalate' }));

    expect(decision.action).toBe('de_escalate');
    expect(decision.reason).toBe('explicit_human_deescalation');
  });

  it.each(['de-escalate', '/de-escalate', '/senior', '<@U123BOT> de-escalate', '<@U123BOT>  /senior'])(
    'recognises de-escalation variant: %s',
    (text) => {
      const routing = new RoutingLayer(config);
      const decision = routing.decide(makeEvent({ channelId: 'C3', messageText: text }));
      expect(decision.action).toBe('de_escalate');
    },
  );

  it('does not treat partial matches as escalation', () => {
    const routing = new RoutingLayer(config);
    const decision = routing.decide(makeEvent({ channelId: 'C3', messageText: 'please escalate the issue' }));
    expect(decision.action).toBe('acp_prompt');
  });
});
