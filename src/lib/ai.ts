import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../config/env";

// Providers do Vercel AI SDK. Use com generateText/streamText do pacote `ai`.
export const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
export const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
