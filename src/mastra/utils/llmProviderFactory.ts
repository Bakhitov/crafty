import { createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { vertex } from "@ai-sdk/google-vertex";
import { groq } from "@ai-sdk/groq";
import { mistral } from "@ai-sdk/mistral";
import { deepseek } from "@ai-sdk/deepseek";
import { cerebras } from "@ai-sdk/cerebras";
import { xai } from "@ai-sdk/xai";

/**
 * Unified LLM provider resolver for Vercel AI SDK providers.
 * Supports provider strings defined in user LLM config and falls back to env vars per provider.
 */
export type SupportedProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "groq"
  | "mistral"
  | "deepseek"
  | "cerebras"
  | "xai";

export interface LlmConfigInput {
  provider: string | null;
  model: string | null;
  apiKey: string | null;
}

/**
 * Resolves a model instance callable by AI SDK from a provider/model/apiKey tuple.
 * Throws explicit errors for missing data to avoid silent fallbacks.
 */
export function resolveLlmModel(config: LlmConfigInput): any {
  const provider = (config.provider || "").toLowerCase() as SupportedProvider;
  const model = config.model || "";

  if (!provider) throw new Error("LLM provider is not set in user profile");
  if (!model) throw new Error("LLM model is not set in user profile");

  // Prefer user-provided key; otherwise read from environment per provider
  const key = getApiKeyForProvider(provider, config.apiKey || undefined);

  switch (provider) {
    case "openai": {
      const client = createOpenAI({ apiKey: key });
      return client(model) as any;
    }
    case "anthropic":
      return anthropic(model) as any;
    case "google":
      return google(model) as any;
    case "google-vertex":
      // Vertex typically uses ADC/service account; we still expose basic instance
      return vertex(model) as any;
    case "groq":
      return groq(model) as any;
    case "mistral":
      return mistral(model) as any;
    case "deepseek":
      return deepseek(model) as any;
    case "cerebras":
      return cerebras(model) as any;
    case "xai":
      return xai(model) as any;
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

function getApiKeyForProvider(provider: SupportedProvider, userKey?: string): string | undefined {
  if (userKey && userKey.trim()) return userKey;

  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "google-vertex":
      // Vertex usually authenticates via GOOGLE_APPLICATION_CREDENTIALS etc.
      return process.env.GOOGLE_VERTEX_API_KEY; // optional, only if configured as proxy
    case "groq":
      return process.env.GROQ_API_KEY;
    case "mistral":
      return process.env.MISTRAL_API_KEY;
    case "deepseek":
      return process.env.DEEPSEEK_API_KEY;
    case "cerebras":
      return process.env.CEREBRAS_API_KEY;
    case "xai":
      return process.env.XAI_API_KEY;
    default:
      return undefined;
  }
}

