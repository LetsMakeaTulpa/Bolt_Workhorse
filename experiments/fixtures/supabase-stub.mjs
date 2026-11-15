// Minimal stand-in for @supabase/supabase-js so the llm-proxy handler can run under Node.
// State is published on globalThis because esbuild may inline this module into the bundle.

const state = {
  quota: { minute: Infinity, day: Infinity },
  used: { minute: 0, day: 0 },
  rpcCalls: [],
  authCalls: [],
  config: { featherless_api_key: 'test-featherless-key', default_model: 'stub/model' },
};

globalThis.__supabaseStub = state;

export function reset(overrides = {}) {
  state.quota = { minute: Infinity, day: Infinity, ...(overrides.quota ?? {}) };
  state.used = { minute: 0, day: 0 };
  state.rpcCalls = [];
  state.authCalls = [];
  state.config = { featherless_api_key: 'test-featherless-key', default_model: 'stub/model', ...(overrides.config ?? {}) };
}

/** Documents matching what PostgREST calls would return. */
function table(name) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: state.config, error: null }),
    single: async () => ({ data: state.config, error: null }),
  };
  return builder;
}

export function createClient() {
  return {
    from: (name) => table(name),
    auth: {
      getUser: async (token) => {
        state.authCalls.push(token);
        if (token === 'user-token') return { data: { user: { id: 'user-1' } }, error: null };
        return { data: { user: null }, error: { message: 'invalid JWT' } };
      },
    },
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      const scope = String(args.p_bucket).endsWith(':day') ? 'day' : 'minute';
      state.used[scope] += 1;
      const limit = args.p_limit;
      const bucket = state.quota[scope];
      const effective = Math.min(limit, bucket);
      return {
        data: [{
          allowed: state.used[scope] <= effective,
          used: state.used[scope],
          remaining: Math.max(effective - state.used[scope], 0),
          reset_at: new Date(Date.now() + 30_000).toISOString(),
        }],
        error: null,
      };
    },
  };
}
