import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const FEATHERLESS_API_KEY = Deno.env.get("FEATHERLESS_API_KEY") ?? "";
const FEATHERLESS_BASE = "https://api.featherless.ai/v1";
const DEFAULT_MODEL = Deno.env.get("FEATHERLESS_MODEL") ?? "Qwen/Qwen2.5-7B-Instruct";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

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
      const { model, messages, stream, temperature, max_tokens } = body;

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
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
