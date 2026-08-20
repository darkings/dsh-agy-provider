import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ExperimentalAgyTransport,
  PersistentTransportError,
} from "../lib/agy/persistent-transport.js";

const fixture = fileURLToPath(new URL("./fixtures/persistent-worker-real.mjs", import.meta.url));

function transport(overrides = {}) {
  return new ExperimentalAgyTransport({
    executable: process.execPath,
    args: [fixture],
    maxWorkers: 8,
    maxFrameBytes: 32 * 1024,
    maxOutputBytes: 256 * 1024,
    maxStderrBytes: 8 * 1024,
    idleTtlMs: 5_000,
    readyTimeoutMs: 2_000,
    shutdownTimeoutMs: 500,
    defaultRequestTimeoutMs: 2_000,
    ...overrides,
  });
}

function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function waitForWorkers(tv, expected, attempts=40){
  for(let i=0;i<attempts;i++){
    if(tv.getStats().totalWorkers===expected) return;
    await wait(25);
  }
  assert.equal(tv.getStats().totalWorkers, expected);
}

test("persistent-transport real: 100 sequential same session reuses one worker", async () => {
  const v = transport();
  try{
    for(let i=0;i<100;i++){
      const r = await v.request({ sessionId: "serial-session", text: `message-${i}` });
      assert.equal(r.events.length, 3); // user_input, agent_response, result (init not counted per turn)
      assert.equal(typeof r.firstEventMs, "number");
      assert.equal(r.sessionId, "serial-session");
    }
    assert.deepEqual(v.getStats(), {
      totalWorkers: 1,
      startingWorkers: 0,
      idleWorkers: 1,
      busyWorkers: 0,
      stoppingWorkers: 0,
      maxWorkers: 8,
      disposed: false,
    });
  } finally { await v.dispose(); }
  assert.equal(v.getStats().totalWorkers, 0);
});

test("persistent-transport real: 8 concurrent sessions and max workers", async () => {
  const v = transport({ maxWorkers: 8 });
  try{
    const sessions = Array.from({length:8}, (_,i)=>`session-${i}`);
    const results = await Promise.all(sessions.map(sid=> v.request({ sessionId: sid, text: sid })));
    assert.deepEqual(results.map(r=>r.sessionId).sort(), sessions.sort());
    assert.equal(v.getStats().totalWorkers, 8);
  } finally { await v.dispose(); }

  const limited = transport({ maxWorkers: 2 });
  try{
    const first = limited.request({ sessionId: "limited-a", text: "mode:delay delayMs:100" });
    const second = limited.request({ sessionId: "limited-b", text: "mode:delay delayMs:100" });
    await wait(25);
    await assert.rejects(
      limited.request({ sessionId: "limited-c", text: "normal" }),
      e=> e.code==="WORKER_LIMIT"
    );
    await Promise.all([first, second]);
  } finally { await limited.dispose(); }
});

test("persistent-transport real: idle TTL and crash recovery", async () => {
  const v = transport({ idleTtlMs: 40 });
  try{
    await v.request({ sessionId: "idle-session", text: "normal" });
    await waitForWorkers(v, 1);
    await waitForWorkers(v, 0, 40);
    await assert.rejects(
      v.request({ sessionId: "crash-session", text: "mode:crash" }),
      e=> e.code==="WORKER_CRASHED"
    );
    await waitForWorkers(v, 0);
    const rec = await v.request({ sessionId: "crash-session", text: "recovered" });
    assert.match(rec.events.find(e=>e.event==="result")?.result?.response ?? "", /recovered/);
  } finally { await v.dispose(); }
});

test("persistent-transport real: abort/timeout/output-limit/malformed reset", async () => {
  const v = transport({ idleTtlMs: 5_000 });
  const sid="fault-session";
  try{
    const ac=new AbortController();
    const aborted=v.request({ sessionId: sid, text: "mode:delay delayMs:500", signal: ac.signal });
    setTimeout(()=>ac.abort(),25);
    await assert.rejects(aborted, e=> e.code==="ABORTED");
    await waitForWorkers(v,0);
    const afterAbort=await v.request({ sessionId: sid, text: "after-abort" });
    assert.match(afterAbort.events.find(e=>e.event==="result")?.result?.response ?? "", /after-abort/);

    await assert.rejects(
      v.request({ sessionId: sid, text: "mode:delay delayMs:500", timeoutMs: 25 }),
      e=> e.code==="TIMEOUT"
    );
    await waitForWorkers(v,0);
    const afterTimeout=await v.request({ sessionId: sid, text: "after-timeout" });
    assert.match(afterTimeout.events.find(e=>e.event==="result")?.result?.response ?? "", /after-timeout/);

    await assert.rejects(
      v.request({ sessionId: sid, text: "mode:burst", maxOutputBytes: 256 }),
      e=> e.code==="OUTPUT_LIMIT"
    );
    await waitForWorkers(v,0);
    const afterLimit=await v.request({ sessionId: sid, text: "after-limit" });
    assert.match(afterLimit.events.find(e=>e.event==="result")?.result?.response ?? "", /after-limit/);

    await assert.rejects(
      v.request({ sessionId: sid, text: "mode:malformed" }),
      e=> e.code==="PROTOCOL_ERROR"
    );
    await waitForWorkers(v,0);
    const afterMalformed=await v.request({ sessionId: sid, text: "after-malformed" });
    assert.match(afterMalformed.events.find(e=>e.event==="result")?.result?.response ?? "", /after-malformed/);
  } finally { await v.dispose(); }
});
