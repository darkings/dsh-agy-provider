export const AGY_EVENT_FIXTURES = Object.freeze({
  init: { event: 'init', init: { conversation_id: 'fixture-conversation' } },
  textDelta: { event: 'step_update', step_update: { text_delta: 'fixture text' } },
  toolActive: { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'list_dir', state: 'ACTIVE' } },
  toolError: { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'list_dir', state: 'ERROR' } },
  checkpoint: { event: 'checkpoint', checkpoint: { state: 'tool-failed' } },
  agentResponse: { event: 'agent_response', agent_response: { text: 'fallback response' } },
  permission: { event: 'permission_request', permission: { kind: 'fixture' } },
  errorMessage: { event: 'error_message', error_message: { code: 'AUTH_REQUIRED', message: 'login required' } },
  resultSuccess: { event: 'result', result: { status: 'SUCCESS', response: 'fixture response' } },
  resultQuota: { event: 'result', result: { status: 'QUOTA_EXCEEDED' } },
  unknown: { event: 'future_event', payload: { stable: true } },
})
