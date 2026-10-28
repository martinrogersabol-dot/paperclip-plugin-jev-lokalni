import {
  definePlugin,
  runWorker,
} from "@paperclipai/plugin-sdk";
import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import type { Env } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";

import {
  choice,
  noul,
  TypeSafeClient,
} from "./lib/local-sdk";
import type { Questions, ChoiceResponse, NoulResponse, Answer } from "./lib/local-sdk";

import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  ACTIONS,
  DATA_KEYS,
  MAX_DESCRIPTION_LENGTH,
  MAX_CAPABILITIES_LENGTH,
  MAX_AGENT_CANDIDATES,
  DEFAULT_MODEL,
  DEFAULT_OWNER_CONFIDENCE_THRESHOLD,
  DEFAULT_PRIORITY_CONFIDENCE_THRESHOLD,
  DEFAULT_CONTEXT_THRESHOLD,
  LOCAL_MODEL,
  LOCAL_ENDPOINT_DEFAULT,
} from "./constants";

interface AnalysisResponse {
  recommended_owner: ChoiceResponse;
  recommended_priority: ChoiceResponse;
  issue_type: ChoiceResponse;
  needs_more_context: NoulResponse;
  likely_blocked: NoulResponse;
}

type Analysis = {
  issueId: string;
  recommended_owner: string | null;
  recommended_priority: string | null;
  issue_type: string | null;
  needs_more_context: boolean;
  likely_blocked: boolean;
  owner_confidence: number;
  priority_confidence: number;
  context_confidence: number;
  context: string;
  capabilities: string;
  context_length: number;
  capabilities_length: number;
  owner_probabilities: Record<string, number>;
  priority_probabilities: Record<string, number>;
  owner_recommendation: ChoiceResponse;
  priority_recommendation: ChoiceResponse;
  context_recommendation: ChoiceResponse;
};

type AnalysisInput = {
  [key: string]: unknown;
  id?: string;
  title?: string;
  description?: string;
  capabilities?: string;
  agentCandidates?: {
    [key: string]: {
      [key: string]: unknown;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function configNumber(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, bounds.min), bounds.max);
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return isRecord(value) && value["env-ref-type"] === "secret-ref";
}

async function analyzeIssue(ctx: PluginContext): Promise<{
  content: string;
  data: Analysis;
}> {
  const runCtx = ctx.sessionContext;
  if (!runCtx) throw new Error("Missing run context for analyze-issue.");

  const config = await getConfig(ctx, runCtx.companyId);

  const client = new TypeSafeClient({
    baseURL: config.localEndpoint,
    defaultModel: config.model,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => ctx.http.fetch(input, init),
  });

  const issues: AnalysisInput[] = Array.isArray(ctx.data.get(DATA_KEYS.issueContext))
    ? (ctx.data.get(DATA_KEYS.issueContext) as unknown[])
    : [];
  const analysis: Analysis[] = [];
  const issueContextKey = runCtx.issue?.context?.key ?? null;

  const agentCandidates = [...(ctx.data.get(
    "agentCandidates" as string,
  ) ?? [])].slice(0, MAX_AGENT_CANDIDATES);

  const analysisPromises = issues.map(async (issue) => {
    if (!issue.id || !issue.title || !issue.description) {
      if (ctx.logger)
        ctx.logger.warn("Skipping incomplete issue", {
          runId: runCtx.runId,
          companyId: runCtx.companyId,
          issueId: issue.id,
        });
      return null;
    }

    const questions: Questions = {
      recommended_owner: choice(
        "Which agent candidate should handle this issue best, given each agent's role and capabilities? Consider only feasibility and fit. Do not consider cost, expertise balance, or current workload.",
        Object.fromEntries(
          agentCandidates
            .map((candidate) => {
              const name = candidate.name as string;
              const role = candidate.role as string;
              const description = candidate.description as string;
              const id = candidate.id as string;
              return [
                id,
                `${name} - ${role} - ${boundedString(description, MAX_DESCRIPTION_LENGTH)}`,
              ];
            })
            .filter(([_, label]) => label.trim().length > 0),
        ),
      ),
      recommended_priority: choice(
        "Which priority best fits this issue? Consider the severity and business impact of the issue and any explicit urgency from the user, but not agent availability.",
        {
          critical: "Urgent, must be done today",
          high: "Very important and time-sensitive",
          medium: "Should be done soon, no urgent deadline",
          low: "Can wait, low urgency",
        },
      ),
      issue_type: choice(
        "Which category best fits this issue?",
        {
          bug: "Something is broken or not working as expected",
          feature: "A request for new functionality",
          chore: "Routine maintenance or housekeeping",
          question: "An inquiry seeking clarification",
          other: "None of the above",
        },
      ),
      needs_more_context: noul(
        "Does this issue have enough context to analyze fully (e.g., clear reproduction steps for a bug, specific expected behavior, or a precise feature request)? Answer 1 if more context is needed, otherwise 0.",
      ),
      likely_blocked: noul(
        "Is this issue likely to be blocked or depend on external factors outside the team's control? Answer 1 if it appears blocked, otherwise 0.",
      ),
    };

    const state = {
      id: issue.id,
      title: issue.title,
      description: issue.description,
      capabilities:
        typeof issue.capabilities === "string"
          ? issue.capabilities
          : "Unknown",
    };

    const response = (await client.systemOne({ state, questions, model: config.model })) as {
      answers: Record<string, unknown>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    return responseAnalysis(issue, response);
  });

  const results = await Promise.all(analysisPromises);
  for (const result of results) {
    if (result) analysis.push(result);
  }

  const latestAnalysis = analysis[0];
  if (!latestAnalysis) {
    return {
      content: "No valid issues were provided for analysis.",
      data: {
        issueId: "",
        recommended_owner: null,
        recommended_priority: null,
        issue_type: null,
        needs_more_context: false,
        likely_blocked: false,
        owner_confidence: 0,
        priority_confidence: 0,
        context_confidence: 0,
        context: "",
        capabilities: "",
        context_length: 0,
        capabilities_length: 0,
        owner_probabilities: {},
        priority_probabilities: {},
        owner_recommendation: { type: "choice", choice: "", confidence: 0, probabilities: {} },
        priority_recommendation: { type: "choice", choice: "", confidence: 0, probabilities: {} },
        context_recommendation: { type: "choice", choice: "", confidence: 0, probabilities: {} },
      },
    };
  }

  if (issueContextKey) {
    await ctx.data.set(DATA_KEYS.latestAnalysis, {
      issueContextKey,
      analysis,
    });
  }

  return {
    content: `Issue analyzed. Recommended owner: ${latestAnalysis.recommended_owner} (confidence ${latestAnalysis.owner_confidence.toFixed(2)}), priority: ${latestAnalysis.recommended_priority} (confidence ${latestAnalysis.priority_confidence.toFixed(2)}), type: ${latestAnalysis.issue_type}. Needs more context: ${latestAnalysis.needs_more_context ? "yes" : "no"}. Likely blocked: ${latestAnalysis.likely_blocked ? "yes" : "no"}.`,
    data: latestAnalysis,
  };
}

function responseAnalysis(
  issue: AnalysisInput,
  response: {
    answers: Record<string, unknown>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  },
): Analysis | null {
  const ownerAnalysis = choiceAnswer(response.answers.recommended_owner, "owner");
  const priorityAnalysis = choiceAnswer(response.answers.recommended_priority, "priority");
  const typeAnalysis = choiceAnswer(response.answers.issue_type, "issue type");

  const moreContext = noulAnswer(response.answers.needs_more_context, "more context");
  const blocked = noulAnswer(response.answers.likely_blocked, "blocked");

  const contextLength = boundedString(String(issue.description ?? ""), MAX_DESCRIPTION_LENGTH).length;
  const capabilitiesLength = boundedString(
    String(issue.capabilities ?? ""),
    MAX_CAPABILITIES_LENGTH,
  ).length;

  return {
    issueId: issue.id as string,
    recommended_owner: ownerAnalysis.choice,
    recommended_priority: priorityAnalysis.choice,
    issue_type: typeAnalysis.choice,
    needs_more_context: moreContext.noul === 1,
    likely_blocked: blocked.noul === 1,
    owner_confidence: ownerAnalysis.confidence,
    priority_confidence: priorityAnalysis.confidence,
    context_confidence: typeAnalysis.confidence,
    context: boundedString(String(issue.description ?? ""), MAX_DESCRIPTION_LENGTH),
    capabilities: boundedString(String(issue.capabilities ?? ""), MAX_CAPABILITIES_LENGTH),
    context_length: contextLength,
    capabilities_length: capabilitiesLength,
    owner_probabilities: ownerAnalysis.probabilities,
    priority_probabilities: priorityAnalysis.probabilities,
    owner_recommendation: ownerAnalysis,
    priority_recommendation: priorityAnalysis,
    context_recommendation: typeAnalysis,
  };
}

function isChoice(value: unknown): value is ChoiceResponse {
  return isRecord(value) && value.type === "choice";
}

function isNoul(value: unknown): value is NoulResponse {
  return isRecord(value) && value.type === "noul";
}

function choiceAnswer(value: unknown, name: string): ChoiceResponse {
  if (!isChoice(value)) throw new Error(`Unexpected Jev ${name} response shape`);
  return value;
}

function noulAnswer(value: unknown, name: string): NoulResponse {
  if (!isNoul(value)) throw new Error(`Unexpected Jev ${name} response shape`);
  return value;
}

async function getConfig(ctx: PluginContext, companyId?: string): Promise<PluginConfig> {
  const raw = (await ctx.config.get("config", { companyId })) as unknown;

  const pluginConfig = (raw?.plugin as Record<string, unknown> | undefined) ?? {};
  const defaultConfig = (raw?.default as Record<string, unknown> | undefined) ?? {};
  const values: Record<string, unknown> = {
    ...defaultConfig,
    ...pluginConfig,
  };

  const localEndpoint = String(
    values.localEndpoint ?? "",
  ).trim() || LOCAL_ENDPOINT_DEFAULT;
  const model = String(values.model ?? "").trim() || DEFAULT_MODEL;

  return {
    localEndpoint,
    model,
  };
}

type PluginConfig = {
  localEndpoint: string;
  model: string;
};

async function runIssueAnalysis(ctx: PluginContext): Promise<void> {
  const runCtx = ctx.sessionContext;
  if (!runCtx?.issue) {
    if (ctx.logger)
      ctx.logger.warn("analyze-issue ran without issue context", {
        runId: runCtx?.runId,
      });
    return;
  }

  if (ctx.logger)
    ctx.logger.info("Analyze issue action running", {
      runId: runCtx.runId,
      companyId: runCtx.companyId,
      issueId: runCtx.issue.id,
    });

  try {
    const { content, data } = await analyzeIssue(ctx);
    await ctx.data.set(DATA_KEYS.latestAnalysis, {
      issueContextKey: runCtx.issue.context?.key ?? null,
      analysis: [data],
    });
    await ctx.activity.log({
      companyId: runCtx.companyId,
      entityType: "project",
      entityId: runCtx.projectId,
      message: "Jev analysis completed",
      metadata: {
        runId: runCtx.runId,
        agentId: runCtx.agentId,
        issueId: runCtx.issue.id,
        recommendedOwner: data.recommended_owner,
        recommendedPriority: data.recommended_priority,
        ownerConfidence: data.owner_confidence,
        priorityConfidence: data.priority_confidence,
      },
    });
  } catch (error) {
    ctx.logger.warn("Jev issue analysis request failed", {
      runId: runCtx.runId,
      companyId: runCtx.companyId,
      issueId: runCtx.issue.id,
      errorType: error instanceof Error ? error.constructor.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function isRecordType(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export {
  analyzeIssue,
  isRecordType,
  isSecretRef,
  PluginConfig,
  runIssueAnalysis,
};
