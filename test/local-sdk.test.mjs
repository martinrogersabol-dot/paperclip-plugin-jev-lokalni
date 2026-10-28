import test from "node:test";
import assert from "node:assert/strict";
import { choice, TypeSafeClient } from "../src/lib/local-sdk.ts";

// Testy lokálního Jev portu. Spouštěno: node --test test/
// Node 25 stripuje typy přímo, takže testy importují přímo TS zdroj.

test("rozhodovací otazka obsahuje volby z dodanych mozitosti", () => {
  const q = choice("ktera priorita?", { high: "Very important", low: "Can wait" });
  assert.equal(q.type, "choice");
  assert.deepEqual(q.options, { high: "Very important", low: "Can wait" });
});

test("systemOne vrati volbu z dodanych mozitosti a jistotu v rozmezi 0-1", async () => {
  const options = { critical: "Urgent", high: "Important", medium: "Soon" };
  const fetchStub = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        { message: { content: JSON.stringify({ choice: "high", confidence: 0.82, probabilities: { critical: 0.1, high: 0.82, medium: 0.08 } }) } },
      ],
    }),
  });

  const client = new TypeSafeClient({
    baseURL: "http://127.0.0.1:8012/v1",
    defaultModel: "test-model",
    fetch: fetchStub,
  });

  const resp = await client.systemOne({
    state: { id: "1", title: "Crash on save" },
    questions: { priority: choice("priorita?", options) },
    model: "test-model",
  });

  // systemOne vrací answers jako objekt { key: { type:"choice", choice, confidence, probabilities } }.
  const answer = resp.answers.priority;
  assert.equal(answer.type, "choice");
  assert.ok(
    Object.prototype.hasOwnProperty.call(options, answer.choice),
    `choice "${answer.choice}" must be one of the provided options ${Object.keys(options).join(", ")}`,
  );
  assert.ok(
    answer.confidence >= 0 && answer.confidence <= 1,
    `confidence ${answer.confidence} must be within [0,1]`,
  );
});

test("chybejeci model vrazi srozumitou chybu", () => {
  assert.throws(
    () => new TypeSafeClient({ defaultModel: "" }),
    /model/i,
  );
});
