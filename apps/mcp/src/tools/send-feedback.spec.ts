jest.mock('@dokkimi/telemetry', () => ({
  trackEvent: jest.fn(),
  isTelemetryEnabled: jest.fn(),
}));

import { trackEvent, isTelemetryEnabled } from '@dokkimi/telemetry';
import { registerSendFeedback } from './send-feedback';
import { createMockServer, parseContent } from './__helpers__/mock-server';

const mockTrackEvent = trackEvent as jest.Mock;
const mockIsTelemetryEnabled = isTelemetryEnabled as jest.Mock;

beforeEach(() => {
  mockTrackEvent.mockClear();
  mockIsTelemetryEnabled.mockReset();
});

describe('send_feedback', () => {
  it('sends feedback when telemetry is enabled', async () => {
    const { server, call } = createMockServer();
    registerSendFeedback(server);

    mockIsTelemetryEnabled.mockReturnValue(true);

    const result = await call('send_feedback', {
      category: 'gap',
      message: 'Could not figure out how to mock a service',
      origin: 'ai',
      tool_name: 'run_tests',
    });
    const data = parseContent(result);

    expect(data.status).toBe('ok');
    expect(mockTrackEvent).toHaveBeenCalledWith('mcp_ai_feedback', {
      category: 'gap',
      origin: 'ai',
      message: 'Could not figure out how to mock a service',
      tool_name: 'run_tests',
      source: 'mcp',
    });
  });

  it('skips when telemetry is disabled', async () => {
    const { server, call } = createMockServer();
    registerSendFeedback(server);

    mockIsTelemetryEnabled.mockReturnValue(false);

    const result = await call('send_feedback', {
      category: 'bug',
      message: 'Something broke',
      origin: 'user',
    });
    const data = parseContent(result);

    expect(data.status).toBe('skipped');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('truncates messages over 2000 characters', async () => {
    const { server, call } = createMockServer();
    registerSendFeedback(server);

    mockIsTelemetryEnabled.mockReturnValue(true);

    const longMessage = 'x'.repeat(3000);
    await call('send_feedback', {
      category: 'positive',
      message: longMessage,
      origin: 'ai',
    });

    const sentMessage = mockTrackEvent.mock.calls[0][1].message;
    expect(sentMessage).toHaveLength(2000);
  });

  it('sets tool_name to null when not provided', async () => {
    const { server, call } = createMockServer();
    registerSendFeedback(server);

    mockIsTelemetryEnabled.mockReturnValue(true);

    await call('send_feedback', {
      category: 'feature_request',
      message: 'Need X',
      origin: 'user',
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'mcp_ai_feedback',
      expect.objectContaining({ tool_name: null }),
    );
  });
});
