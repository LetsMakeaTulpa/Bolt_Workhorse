import { useCallback, useEffect, useState } from 'react';
import { fetchConfiguredSecrets } from '../lib/api';
import { supabase } from '../lib/supabase';

/**
 * The secret *names* this account has stored, never their values.
 *
 * Only names are selected: the composer needs to know that EXA_API_KEY exists, not what it is,
 * and a `select('name')` keeps the values out of the browser entirely.
 */
export function useEngineKeys(userId: string | undefined) {
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  /** the table may not exist yet in a project that has not applied the migration */
  const [unavailable, setUnavailable] = useState(false);
  /** secret names the deployed function holds; null when it cannot say (older build, offline) */
  const [deployment, setDeployment] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    // the deployment's own secrets are asked for even signed out: they do not depend on an account
    const configured = fetchConfiguredSecrets();
    if (!userId) {
      setNames([]);
      setUnavailable(false);
      setDeployment(await configured);
      return;
    }
    setLoading(true);
    const [{ data, error }, secrets] = await Promise.all([
      supabase.from('user_engine_keys').select('name'),
      configured,
    ]);
    setLoading(false);
    setDeployment(secrets);
    if (error) {
      // a missing table is a setup state, not an error worth shouting about in the composer
      setUnavailable(/does not exist|user_engine_keys/i.test(error.message));
      setNames([]);
      return;
    }
    setUnavailable(false);
    setNames((data ?? []).map((row) => String(row.name)));
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { names, loading, unavailable, deployment, refresh };
}
