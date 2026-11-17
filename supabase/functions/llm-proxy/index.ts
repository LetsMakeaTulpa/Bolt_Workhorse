import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  LIMITS, RATE_LIMITED_MARKER, bucketKey, clientIp, rateLimitedMessage, retryAfterSeconds,
  type Caller, type LimitPair,
} from "./rateLimit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
  "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Scope",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FEATHERLESS_BASE = "https://api.featherless.ai/v1";

type AdminClient = ReturnType<typeof createClient>;

async function getApiKey(client: AdminClient): Promise<{ key: string; model: string }> {
  const { data, error } = await client
    .from("app_config")
    .select("featherless_api_key, default_model")
    .eq("id", 1)
    .maybeSingle();

  if (error || !data) {
    return { key: "", model: "Qwen/Qwen2.5-7B-Instruct" };
  }
  return { key: data.featherless_api_key ?? "", model: data.default_model ?? "Qwen/Qwen2.5-7B-Instruct" };
}

/** A verified session is an account; anything else is a public anon-key caller. */
async function identify(client: AdminClient, req: Request): Promise<Caller> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token) {
    try {
      const { data, error } = await client.auth.getUser(token);
      if (!error && data?.user?.id) return { kind: "user", id: data.user.id };
    } catch (err) {
      console.error("token check failed, treating caller as anonymous", (err as Error).message);
    }
  }
  return { kind: "anonymous", id: clientIp(req.headers) };
}

const WINDOWS: { scope: string; seconds: number; limit: (limits: LimitPair) => number }[] = [
  { scope: "minute", seconds: 60, limit: (l) => l.perMinute },
  { scope: "day", seconds: 86_400, limit: (l) => l.perDay },
];

type Verdict =
  | { ok: true }
  | { ok: false; scope: string; limit: number; used: number; resetAt: string };

/**
 * Spend one hit in every window before the request is forwarded. The SQL upsert is atomic, so
 * concurrent requests cannot both slip in under the limit. If the counter itself is unavailable
 * the request is allowed (availability over a self-inflicted outage) but logged loudly.
 */
async function checkLimits(client: AdminClient, caller: Caller): Promise<Verdict> {
  const limits = LIMITS[caller.kind];
  const bucket = await bucketKey(caller);

  for (const window of WINDOWS) {
    const limit = window.limit(limits);
    const { data, error } = await client.rpc("consume_rate_limit", {
      p_bucket: `${bucket}:${window.scope}`,
      p_window_seconds: window.seconds,
      p_limit: limit,
    });

    if (error) {
      console.error("rate limit check failed, allowing request", error.message);
      return { ok: true };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: true };
    if (!row.allowed) {
      return { ok: false, scope: window.scope, limit, used: row.used, resetAt: row.reset_at };
    }
  }

  return { ok: true };
}

function rateLimitedResponse(caller: Caller, verdict: Extract<Verdict, { ok: false }>): Response {
  const retryAfter = retryAfterSeconds(verdict.resetAt);
  console.warn(`rate limited: ${caller.kind} ${verdict.scope} ${verdict.used}/${verdict.limit}`);
  return new Response(
    JSON.stringify({
      error: RATE_LIMITED_MARKER,
      message: rateLimitedMessage(caller, retryAfter),
      tier: caller.kind,
      scope: verdict.scope,
      limit: verdict.limit,
      used: verdict.used,
      retry_after: retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(verdict.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Scope": verdict.scope,
      },
    }
  );
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Cheap gate first: nothing is forwarded, and no key is read, for a caller over budget.
    const caller = await identify(client, req);
    const verdict = await checkLimits(client, caller);
    if (!verdict.ok) return rateLimitedResponse(caller, verdict);

    const { key: FEATHERLESS_API_KEY, model: DEFAULT_MODEL } = await getApiKey(client);

    if (!FEATHERLESS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Featherless API key not configured. Set it in Settings." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // GET /llm-proxy/models — list available models
    if (url.pathname.endsWith("/models")) {
      const resp = await fetch(`${FEATHERLESS_BASE}/models`, {
        headers: { Authorization: `Bearer ${FEATHERLESS_API_KEY}` },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(
          JSON.stringify({ error: `Featherless API error: ${resp.status}`, details: errText }),
          { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await resp.json();
      const models = (data.data ?? []).map((m: Record<string, unknown>) => ({
        id: m.id as string,
        name: (m.name as string) ?? (m.id as string),
        context_length: (m.context_length as number) ?? 8192,
        max_completion_tokens: (m.max_completion_tokens as number) ?? 4096,
      }));

      return new Response(
        JSON.stringify({ models, default_model: DEFAULT_MODEL }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // POST /llm-proxy/chat — chat completion with streaming
    if (url.pathname.endsWith("/chat")) {
      const body = await req.json();
      const { model, messages, stream, temperature, max_tokens, tools, tool_choice } = body;

      if (!messages || !Array.isArray(messages)) {
        return new Response(
          JSON.stringify({ error: "Missing required field: messages" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const useModel = model || DEFAULT_MODEL;

      const payload: Record<string, unknown> = {
        model: useModel,
        messages,
        stream: stream ?? false,
      };
      if (temperature !== undefined) payload.temperature = temperature;
      if (max_tokens !== undefined) payload.max_tokens = max_tokens;
      // tool calls are generated by the provider, so the definitions have to reach it: the client
      // sends search_web and then answers each call the model makes
      if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
      if (tool_choice !== undefined) payload.tool_choice = tool_choice;

      const resp = await fetch(`${FEATHERLESS_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(
          JSON.stringify({ error: `Featherless API error: ${resp.status}`, details: errText }),
          { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (stream) {
        return new Response(resp.body, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      const data = await resp.json();
      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Use /llm-proxy/models or /llm-proxy/chat" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

Deno.serve(handleRequest);
