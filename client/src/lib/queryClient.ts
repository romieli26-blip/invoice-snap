import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Token stored in memory (and optionally persisted to localStorage)
let authToken: string | null = null;

const TOKEN_KEY = "invoice_snap_token";

export function setAuthToken(token: string | null, persist = false) {
  authToken = token;
  if (persist && token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  }
  if (!token) {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }
}

export function getAuthToken() {
  return authToken;
}

// Restore token from localStorage on startup
try {
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) authToken = saved;
} catch {}

function getAuthHeaders(): Record<string, string> {
  if (authToken) return { Authorization: `Bearer ${authToken}` };
  return {};
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (data) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

export async function apiUpload(url: string, formData: FormData): Promise<Response> {
  const headers: Record<string, string> = { ...getAuthHeaders() };

  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers,
    body: formData,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const headers: Record<string, string> = { ...getAuthHeaders() };
    const res = await fetch(`${API_BASE}${queryKey[0]}`, { headers });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
