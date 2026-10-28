// Lokální náhrada za @typesafe-ai/sdk.
//
// Poskytuje stejný kontrakt, který spotřebitelé (worker.ts, browser.ts)
// očekávají:
//   - choice(prompt, options)   -> choice otázka
//   - noul(prompt)              -> otázka ano/ne (0/1)
//   - TypeSafeClient.systemOne({ state, questions, model })
//         -> { answers: { key: { type:"choice"/"noul", choice/confidence/
//             probabilities OR noul }, model, usage: { input_tokens,
//             output_tokens } }
//
// Volá se jediný lokální OpenAI-kompatibilní endpoint (výchoze
// http://127.0.0.1:8012/v1) s modelem ornith-1.5-35b-a3b-splash a přísným
// JSON schématem. Žádná odchozí adresa mimo localhost, žádné API klíče.

export type ChoiceQuestion = {
  type: "choice";
  prompt: string;
  options: Record<string, string>;
};
export type NoulQuestion = {
  type: "noul";
  prompt: string;
};
export type Question = ChoiceQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

export type ChoiceResponse = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type NoulResponse = {
  type: "noul";
  noul: number;
  confidence: number;
};
export type Answer = ChoiceResponse | NoulResponse;
export type SystemOneResponse = {
  answers: Record<string, Answer>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
};

function alphabet(index: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < chars.length) return chars[index];
  return String.fromCharCode(65 + Math.floor(index / chars.length)) + chars[index % chars.length];
}

function normalizeProbabilities(p: Record<string, unknown>): ChoiceResponse {
  // Schéma odpovědi: { choice: string, confidence: number, probabilities: { <key>: number } }.
  // Volba je zadaná modelem přes pole `choice`; pravděpodobnosti normalizujeme z
  // podobjektu `probabilities` tak, aby součet byl 1.
  const rawProbabilities =
    p.probabilities && typeof p.probabilities === "object"
      ? Object.fromEntries(
          Object.entries(p.probabilities as Record<string, unknown>).filter(
            ([, v]) => typeof v === "number" && Number.isFinite(v),
          ),
        )
      : {};
  const total = Object.values(rawProbabilities).reduce((s, v) => s + v, 0) || 1;
  const probabilities: Record<string, number> = {};
  let best: [string, number] | null = null;
  for (const [k, v] of Object.entries(rawProbabilities)) {
    probabilities[k] = v / total;
    if (best === null || v > best[1]) best = [k, v];
  }
  const confidence = best
    ? best[1] / total
    : typeof p.confidence === "number" && Number.isFinite(p.confidence)
      ? Math.min(Math.max(p.confidence, 0), 1)
      : 1;
  const choice =
    (typeof p.choice === "string" && p.choice) || (best ? best[0] : "");
  return { type: "choice", choice, confidence, probabilities };
}

export function choice(prompt: string, options: Record<string, string>): ChoiceQuestion {
  return { type: "choice", prompt, options };
}

export function noul(prompt: string): NoulQuestion {
  return { type: "noul", prompt };
}

export type LocalClientOptions = {
  baseURL?: string;
  defaultModel?: string;
  timeout?: number;
  logLevel?: string;
  retry?: { maxRetries?: number };
  apiKey?: string;
  fetch?: typeof fetch;
};

export class TypeSafeClient {
  private baseURL: string;
  private defaultModel: string;
  private fetchImpl: typeof fetch;

  constructor(opts: LocalClientOptions = {}) {
    this.baseURL = (opts.baseURL || "http://127.0.0.1:8012/v1").replace(/\/+$/, "");
    const model = opts.defaultModel && String(opts.defaultModel).trim()
      ? String(opts.defaultModel).trim()
      : "";
    if (!model) {
      throw new Error(
        "Jev: missing model — set the \"model\" field in the plugin config (e.g. ornith-1.5-35b-a3b-splash).",
      );
    }
    this.defaultModel = model;
    this.fetchImpl = opts.fetch || globalThis.fetch;
  }

  private localBase(url: string): string {
    let base = url;
    if (!base.endsWith("/v1")) base += "/v1";
    return base;
  }

  async systemOne(req: {
    state: unknown;
    questions: Questions;
    model?: string;
  }): Promise<SystemOneResponse> {
    const base = this.localBase(this.baseURL);
    const model = req.model || this.defaultModel;
    const answers: Record<string, Answer> = {};
    const stateText = req.state ? JSON.stringify(req.state, null, 2) : "(žádný stav)";
    const commonSys =
      "You are a routing engine. Respond with valid JSON only, no prose, no markdown fences.";

    for (const [key, q] of Object.entries(req.questions)) {
      if (q.type === "choice") {
        const list = Object.entries(q.options);
        const optionsBlock = list
          .map(([k, v], i) => `${alphabet(i)}) ${v}`)
          .join("\n");
        const choiceKeys = list.map(([k]) => k);
        const sys =
          commonSys +
          ' Respond with exactly: {"choice":"<key>","confidence":<number 0-1>,"probabilities":{"<key>":<number 0-1>}}. Distribute probability across the options by how well each matches.';
        const body = {
          model,
          messages: [
            { role: "system", content: sys },
            {
              role: "user",
              content: `${q.prompt}\n\nIssue context:\n${stateText}\n\nChoices:\n${optionsBlock}`,
            },
          ],
          temperature: 0,
          max_tokens: 2048,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "choice_answer",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  choice: { type: "string", enum: choiceKeys },
                  confidence: { type: "number" },
                  probabilities: { type: "object", additionalProperties: { type: "number" } },
                },
                required: ["choice", "confidence", "probabilities"],
              },
            },
          },
        };
        const parsed = await this.requestJSON(body);
        answers[key] = normalizeProbabilities(parsed ?? {});
      } else {
        const sys =
          commonSys +
          ' Respond with exactly: {"noul":<0 or 1>,"confidence":<number 0-1>}. 1 means YES, 0 means NO.';
        const body = {
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: `${q.prompt}\n\nIssue context:\n${stateText}\n\nRespond with 1 for YES, 0 for NO.` },
          ],
          temperature: 0,
          max_tokens: 128,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "noul_answer",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { noul: { type: "integer", enum: [0, 1] }, confidence: { type: "number" } },
                required: ["noul", "confidence"],
              },
            },
          },
        };
        const parsed = await this.requestJSON(body);
        answers[key] = {
          type: "noul",
          noul: parsed?.noul === 1 ? 1 : 0,
          confidence: Number(parsed?.confidence) || 0,
        };
      }
    }

    return { answers, model, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  private async requestJSON(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return undefined;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return parsed;
    } catch {
      return undefined;
    }
  }
}
