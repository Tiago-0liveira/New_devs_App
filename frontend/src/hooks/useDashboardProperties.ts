import { useState, useEffect, useCallback } from 'react';
import { SecureAPI } from '../lib/secureApi';
import { useAuth } from '../contexts/AuthContext.new';

export interface DashboardProperty {
  id: string;
  name: string;
}

interface UseDashboardPropertiesResult {
  properties: DashboardProperty[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Properties the current tenant owns. Refetches when the signed-in
 * user/tenant changes so a previous tenant's list is never shown.
 */
export function useDashboardProperties(): UseDashboardPropertiesResult {
  const { user, isAuthenticated } = useAuth();
  const tenantId = user?.tenant_id ?? null;

  const [properties, setProperties] = useState<DashboardProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setProperties([]);

    SecureAPI.getDashboardProperties()
      .then((list: DashboardProperty[]) => {
        if (!cancelled) setProperties(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[useDashboardProperties] failed to load properties', err);
        setError('Failed to load properties');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, tenantId, reloadKey]);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  return { properties, loading, error, refetch };
}
