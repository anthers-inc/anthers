import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api, ApiError, type User, type ATProtoAuthInitResponse } from "./api";

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginWithBluesky: (handle: string) => Promise<void>;
  linkBluesky: (handle: string) => Promise<void>;
  unlinkBluesky: () => Promise<void>;
  register: (
    username: string,
    email: string,
    password: string,
    passwordConfirm: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<User>("/api/v1/accounts/me/");
      setUser(data);
    } catch (err) {
      // 401/403 means not logged in—not an error
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setUser(null);
      } else {
        console.error("Failed to fetch user:", err);
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setIsLoading(false));
  }, [refreshUser]);

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await api.post<User>("/api/v1/accounts/login/", {
        username,
        password,
      });
      setUser(data);
    },
    [],
  );

  const register = useCallback(
    async (
      username: string,
      email: string,
      password: string,
      passwordConfirm: string,
    ) => {
      const data = await api.post<User>("/api/v1/accounts/register/", {
        username,
        email,
        password,
        password_confirm: passwordConfirm,
      });
      setUser(data);
    },
    [],
  );

  const loginWithBluesky = useCallback(async (handle: string) => {
    const data = await api.post<ATProtoAuthInitResponse>(
      "/api/v1/accounts/atproto/auth/",
      { handle, intent: "login" },
    );
    // Redirect to Bluesky authorization page
    window.location.href = data.authorization_url;
  }, []);

  const linkBluesky = useCallback(async (handle: string) => {
    const data = await api.post<ATProtoAuthInitResponse>(
      "/api/v1/accounts/atproto/auth/",
      { handle, intent: "link" },
    );
    window.location.href = data.authorization_url;
  }, []);

  const unlinkBluesky = useCallback(async () => {
    const data = await api.post<User>("/api/v1/accounts/atproto/unlink/");
    setUser(data);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/v1/accounts/logout/");
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: user !== null,
        login,
        loginWithBluesky,
        linkBluesky,
        unlinkBluesky,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
