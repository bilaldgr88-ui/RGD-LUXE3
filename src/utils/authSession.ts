const SESSION_TOKEN_STORAGE_KEY = 'rgd_session_token';

export function getStoredSessionToken(): string | null {
  try {
    const localToken = localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (localToken && localToken.trim()) {
      return localToken.trim();
    }
    const sessionToken = sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (sessionToken && sessionToken.trim()) {
      return sessionToken.trim();
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return null;
}

export function setStoredSessionToken(token: string | null): void {
  try {
    if (token && token.trim()) {
      const clean = token.trim();
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, clean);
      sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, clean);
    } else {
      localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
}

export function getAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getStoredSessionToken();
  if (!token) {
    return { ...extra };
  }
  return {
    ...extra,
    Authorization: `Bearer ${token}`,
  };
}
