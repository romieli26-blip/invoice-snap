import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { apiRequest } from "./queryClient";

interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Store token in memory (not localStorage — sandboxed)
let memoryToken: string | null = null;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiRequest("POST", "/api/login", { username, password });
    const data = await res.json();
    memoryToken = data.token;
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    if (memoryToken) {
      fetch("/api/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${memoryToken}` },
      }).catch(() => {});
    }
    memoryToken = null;
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token: memoryToken, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function getAuthHeaders(): Record<string, string> {
  if (memoryToken) {
    return { Authorization: `Bearer ${memoryToken}` };
  }
  return {};
}

// Override apiRequest to include auth headers
const originalFetch = window.fetch;
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  if (memoryToken && url.startsWith(`${API_BASE}/api`)) {
    headers.set("Authorization", `Bearer ${memoryToken}`);
  }
  return originalFetch(url, { ...options, headers });
}
