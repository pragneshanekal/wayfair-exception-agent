import OpenAI from "openai";

export const SUBCONSCIOUS_MODEL = "subconscious/tim-qwen3.6-27b";
export const SUBCONSCIOUS_BASE_URL = "https://api.subconscious.dev/v1";

export interface CreateOpenAIOptions {
  apiKey: string;
  /** Subconscious defaults thinking ON — we default to false unless overridden per client. */
  enableThinking?: boolean;
  /** When stream: true, merge stream_options.include_usage (default true). */
  includeUsageOnStream?: boolean;
}

type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatCompletionCreateParamsWithoutModel = Omit<ChatCompletionCreateParams, "model">;
type NonStreamingChatParams = ChatCompletionCreateParamsWithoutModel & { stream?: false };

function isChatCompletionsRequest(url: string, init?: RequestInit): boolean {
  if (!url.includes("/chat/completions")) return false;
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "POST";
}

function injectSubconsciousDefaults(
  init: RequestInit | undefined,
  options: { enableThinking: boolean; includeUsageOnStream: boolean },
): RequestInit | undefined {
  if (!init?.body || typeof init.body !== "string") {
    return init;
  }

  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const existingKwargs =
      typeof body.chat_template_kwargs === "object" && body.chat_template_kwargs !== null
        ? (body.chat_template_kwargs as Record<string, unknown>)
        : {};

    body.chat_template_kwargs = {
      ...existingKwargs,
      enable_thinking: existingKwargs.enable_thinking ?? options.enableThinking,
      enable_auto_compaction: existingKwargs.enable_auto_compaction ?? false,
    };

    if (body.stream === true && options.includeUsageOnStream) {
      const existingStreamOptions =
        typeof body.stream_options === "object" && body.stream_options !== null
          ? (body.stream_options as Record<string, unknown>)
          : {};

      body.stream_options = {
        ...existingStreamOptions,
        include_usage: existingStreamOptions.include_usage ?? true,
      };
    }

    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

/**
 * OpenAI SDK pointed at Subconscious chat completions (`/v1/chat/completions`).
 *
 * Injects `chat_template_kwargs.enable_thinking` on every chat/completions POST
 * because the OpenAI SDK has no direct param for this Subconscious extension.
 * Subconscious defaults thinking ON — we default it OFF for cleaner, faster output.
 */
export function createOpenAI(options: CreateOpenAIOptions): OpenAI {
  const enableThinking = options.enableThinking ?? false;
  const includeUsageOnStream = options.includeUsageOnStream ?? true;

  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: SUBCONSCIOUS_BASE_URL,
    fetch: async (url, init) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const nextInit = isChatCompletionsRequest(urlStr, init)
        ? injectSubconsciousDefaults(init, { enableThinking, includeUsageOnStream })
        : init;
      return fetch(url, nextInit);
    },
  });
}

export interface SubconsciousChat {
  completions: {
    create(
      params: NonStreamingChatParams,
      options?: OpenAI.RequestOptions,
    ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  };
}

export interface Subconscious {
  /**
   * Chat completions at `/v1/chat/completions`.
   * Use this — not a top-level `responses` call (`/v1/responses` is unsupported).
   */
  chat(modelId: string): SubconsciousChat;
}

export function createSubconscious(
  apiKey: string,
  options: Omit<CreateOpenAIOptions, "apiKey"> = {},
): Subconscious {
  const client = createOpenAI({ apiKey, ...options });

  return {
    chat(modelId: string): SubconsciousChat {
      return {
        completions: {
          create(params, requestOptions) {
            return client.chat.completions.create(
              { ...params, model: modelId },
              requestOptions,
            ) as Promise<OpenAI.Chat.Completions.ChatCompletion>;
          },
        },
      };
    },
  };
}

/** @deprecated Use createSubconscious() and subconscious.chat(modelId) instead. */
export function createSubconsciousClient(apiKey: string): OpenAI {
  return createOpenAI({ apiKey });
}
