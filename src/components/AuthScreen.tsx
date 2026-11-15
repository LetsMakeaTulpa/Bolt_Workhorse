import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Compass, Loader2, LogIn, UserPlus, ShieldCheck } from 'lucide-react';

type Mode = 'signin' | 'signup';

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Wrong email or password.';
  if (/email not confirmed/i.test(message)) return 'That email has not been confirmed yet — open the link in your inbox first.';
  if (/user already registered/i.test(message)) return 'That email already has an account — sign in instead.';
  if (/password should be at least/i.test(message)) return 'Use a password of at least 6 characters.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts — wait a minute and try again.';
  return message;
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setNotice('Account created. Open the confirmation link we emailed you, then sign in here.');
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (err) {
      setError(friendly(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const switching = () => {
    setMode(mode === 'signin' ? 'signup' : 'signin');
    setError('');
    setNotice('');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-elevated">
            <Compass size={20} className="text-accent" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-text-primary">Fieldwork</h1>
          <p className="text-xs text-text-muted">Research Intelligence Workstation</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-border bg-bg-surface p-5 shadow-2xl"
        >
          <h2 className="text-sm font-medium text-text-primary">
            {mode === 'signin' ? 'Sign in to your workspace' : 'Create an account'}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Conversations, sources and findings are stored per account and readable only by it.
          </p>

          <label className="mt-4 block text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-accent/50"
          />

          <label className="mt-3 block text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Password
          </label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            placeholder="••••••••"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-accent/50"
          />

          {error && (
            <div className="mt-3 rounded-lg border border-error/30 bg-error-subtle px-3 py-2 text-[11px] text-error">
              {error}
            </div>
          )}
          {notice && (
            <div className="mt-3 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[11px] text-text-secondary">
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-bg-base transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : mode === 'signin' ? (
              <LogIn size={14} />
            ) : (
              <UserPlus size={14} />
            )}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <button
            type="button"
            onClick={switching}
            className="mt-3 w-full text-center text-[11px] text-text-muted transition-colors hover:text-text-secondary"
          >
            {mode === 'signin' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
          </button>
        </form>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-[10px] text-text-muted">
          <ShieldCheck size={12} />
          Row-level security scopes every row to its owner.
        </p>
      </div>
    </div>
  );
}
