import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { setAuthToken, getAuthToken, queryClient } from "@/lib/queryClient";

const USER_KEY = "invoice_snap_user";

interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  firstName?: string;
  lastName?: string;
  mileageRate?: string;
  allowOffSite?: number;
  allowSpecialTerms?: number;
  specialTermsAmount?: string;
  homeProperty?: string;
  baseRate?: string;
  offSiteRate?: string;
  mustChangePassword?: number;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  logout: () => void;
  /** Re-fetch the signed-in user from /api/me (e.g. after a password change). */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount, check if we have a saved token and validate it
  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      return;
    }

    // Validate the saved token with the server
    fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error("Invalid token");
        return res.json();
      })
      .then((data: AuthUser) => {
        setUser(data);
      })
      .catch(() => {
        // Token is invalid or server session expired — clear it
        setAuthToken(null);
        try { localStorage.removeItem(USER_KEY); } catch {}
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const login = useCallback(async (username: string, password: string, rememberMe = false) => {
    const res = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Login failed");
    }

    const data = await res.json();
    setAuthToken(data.token, rememberMe);
    setUser(data.user);

    if (rememberMe) {
      try { localStorage.setItem(USER_KEY, JSON.stringify(data.user)); } catch {}
    }
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
    try { localStorage.removeItem(USER_KEY); } catch {}
    // Clear all cached data so the next user doesn't see stale data
    queryClient.clear();
  }, []);

  const refreshUser = useCallback(async () => {
    const token = getAuthToken();
    if (!token) return;
    const res = await fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data: AuthUser = await res.json();
    setUser(data);
    try {
      if (localStorage.getItem(USER_KEY)) localStorage.setItem(USER_KEY, JSON.stringify(data));
    } catch {}
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
