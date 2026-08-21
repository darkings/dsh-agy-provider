import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const conversationId = randomUUID();
const init = {
  event: "init",
  conversation_id: conversationId,
  init: {
    model: "gemini-3.1-pro-high",
    cwd: process.cwd(),
    agent: "deepseek-proxy",
    tools: ["read_file","write_file"],
    permission_mode: "request-review"
  }
};
process.stdout.write(JSON.stringify(init) + "\n");

const children = new Set();
function emit(obj){ process.stdout.write(JSON.stringify(obj) + "\n"); }

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
input.on("line", line => {
  let msg;
  try { msg = JSON.parse(line.trim()); } catch { process.exit(21); }
  if (!msg || msg.event !== "user" || !msg.message) {
    // For shutdown, stdin end will close
    return;
  }
  const mode = String(msg.message.content?.[0]?.text ?? "");
  const text = mode;
  turn += 1;
  // Simulate modes for fault tests
  if (text.includes("mode:crash")) { process.exit(23); }
  if (text.includes("mode:wrong-conversation")) {
    emit({ event: "step_update", step_update: { conversation_id: "wrong-id", step_index: turn*2, state: "DONE", step_type: "user_input" } });
    return;
  }
  if (text.includes("mode:burst")) {
    for(let i=0;i<20;i++){
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2+i, state: "DONE", step_type: "agent_response", text_delta: "x".repeat(128), usage: { input_tokens: 100, output_tokens: 100 } } });
    }
    emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "burst", duration_seconds: 1, num_turns: turn, usage: { input_tokens: 1000, output_tokens: 1000 } } });
    return;
  }
  if (text.includes("mode:tree")) {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { stdio: ["ignore","ignore","ignore"] });
    children.add(child);
    child.once("close", ()=> children.delete(child));
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2, state: "DONE", step_type: "user_input" } });
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2+1, state: "DONE", step_type: "agent_response", text_delta: "", usage: { input_tokens: 10, output_tokens: 10 } } });
    // Emit childPid in a step_update for tree test
    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2+2, state: "DONE", step_type: "agent_response", text_delta: JSON.stringify({ childPid: child.pid }), usage: { input_tokens: 10, output_tokens: 10 } } });
    setTimeout(()=>{
      emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "tree", duration_seconds: 1, num_turns: turn, usage: { input_tokens: 10, output_tokens: 10 } } });
    }, 10000);
    return;
  }
  if (text.includes("mode:delay")) {
    const delayMs = Number(text.match(/delayMs:(\d+)/)?.[1] ?? 100);
    setTimeout(()=>{
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2, state: "DONE", step_type: "user_input" } });
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2+1, state: "DONE", step_type: "agent_response", text_delta: text, usage: { input_tokens: 100, output_tokens: 50 } } });
      emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: text, duration_seconds: 1, num_turns: turn, usage: { input_tokens: 100, output_tokens: 50 } } });
    }, delayMs);
    return;
  }
  if (text.includes("mode:malformed")) {
    process.stdout.write("not-json\n");
    return;
  }
  // Normal
  const payloadText = text.includes("TURN") ? text.match(/TURN\d+/)?.[0] ?? text : `${conversationId}:${text}:${turn}`;
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2, state: "DONE", step_type: "user_input" } });
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turn*2+1, state: "DONE", step_type: "agent_response", text_delta: payloadText + "\n", usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 150 } } });
  emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: payloadText + "\n", duration_seconds: 1, num_turns: turn, usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 150 } } });
});

input.on("close", ()=>{
  for(const c of children) c.kill();
  process.exit(0);
});
