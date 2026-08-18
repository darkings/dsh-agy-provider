/**
 * Sanitized shape fixture sampled from local AGY 1.1.14.
 *
 * All free-form strings, paths, conversation identifiers, tool names, and
 * token values are placeholders. The fixture is for parser/protocol shape
 * regression only; it is not a transcript and must never be replaced with
 * raw AGY output.
 */
export const AGY_STREAM_JSON_REAL_FIXTURE = Object.freeze([
  {
    event: 'init',
    conversation_id: '<string:36>',
    init: {
      model: '<string:19>',
      cwd: '<string:38>',
      agent: '<string:14>',
      tools: [
        '<string:14>', '<string:12>', '<string:21>', '<string:27>',
        '<string:15>', '<string:27>', '<string:13>', '<string:29>',
        '<string:18>', '<string:16>', '<string:18>', '<string:17>',
        '<string:20>', '<string:21>', '<string:14>', '<string:18>',
        '<string:21>', '<string:16>', '<string:13>', '<string:28>',
        '<string:26>', '<string:19>', '<string:14>', '<string:15>',
        '<string:16>', '<string:26>', '<string:12>', '<string:6>',
        '<string:14>', '<string:11>', '<string:15>', '<string:18>',
      ],
      permission_mode: '<string:14>',
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '<string:36>',
      step_index: 0,
      state: 'DONE',
      step_type: 'user_input',
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '<string:36>',
      step_index: 0,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: '<string:12>',
      duration_seconds: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
      },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '<string:36>',
      step_index: 0,
      state: 'DONE',
      step_type: 'checkpoint',
      duration_seconds: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
      },
    },
  },
  {
    event: 'result',
    result: {
      conversation_id: '<string:36>',
      status: 'SUCCESS',
      response: '<string:12>',
      duration_seconds: 0,
      num_turns: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
      },
    },
  },
])
