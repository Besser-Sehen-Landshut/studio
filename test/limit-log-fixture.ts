/**
 * The log of a crew run that ended at once at the weekly usage limit, in the shape Claude Code
 * (headless, stream-json) wrote it on the first live crew run: a rejected `rate_limit_event`, a
 * synthetic assistant API error message and a failed `result`. Anonymized: ids, paths and the
 * request are made up; field names and structure are as logged. The limit text gives the reset only
 * as a local phrase; the structured fields carry it as an epoch (`resetsAt`, seconds).
 */
export function weeklyLimitLog(resetsAt: number): string[] {
  const session = '00000000-0000-4000-8000-000000000001';
  const info = {
    status: 'rejected',
    resetsAt,
    rateLimitType: 'seven_day',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  };
  const text = "You've hit your weekly limit · resets Nov 3 at 7pm (Europe/Berlin)";
  return [
    {
      type: 'system',
      subtype: 'init',
      cwd: '/tmp/clone',
      session_id: session,
      tools: ['Bash', 'Read'],
      mcp_servers: [],
      model: 'claude-model',
      permissionMode: 'bypassPermissions',
    },
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        ...info,
        unifiedWindows: {
          seven_day: { utilization: 1, resetsAt, status: 'rejected', surpassedThreshold: 1 },
        },
      },
      uuid: '00000000-0000-4000-8000-000000000002',
      session_id: session,
    },
    {
      type: 'assistant',
      message: {
        id: '00000000-0000-4000-8000-000000000003',
        model: '<synthetic>',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        type: 'message',
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      session_id: session,
      uuid: '00000000-0000-4000-8000-000000000004',
      timestamp: '2026-11-01T10:00:00.000Z',
      error: 'rate_limit',
      request_id: 'req_0000000000000000000000',
      is_api_error_message: true,
      api_error_status: 429,
      api_error: 'usage_limit_reached',
      api_error_params: { rate_limit_info: info },
      api_error_origin: 'first_party',
    },
    {
      duration_api_ms: 0,
      stop_reason: 'stop_sequence',
      session_id: session,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: 'api_error',
      is_error: true,
      num_turns: 1,
      subtype: 'success',
      api_error_status: 429,
      api_error_origin: 'first_party',
      api_error: 'usage_limit_reached',
      result: text,
      type: 'result',
      duration_ms: 421,
      uuid: '00000000-0000-4000-8000-000000000005',
    },
  ].map((ev) => JSON.stringify(ev));
}
