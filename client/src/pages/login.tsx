import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { Camera, Loader2 } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSending, setForgotSending] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password, rememberMe);
    } catch (err: any) {
      setError("Invalid username or password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <LogoBackground>
      <div className="flex items-center justify-center p-4 bg-background" style={{ minHeight: "100vh" }}>
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
            <Camera className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="text-app-title">Receipt App</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to submit receipts</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                data-testid="input-username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Enter your username"
                autoComplete="username"
                autoCapitalize="none"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                data-testid="input-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember-me"
                data-testid="checkbox-remember-me"
                checked={rememberMe}
                onCheckedChange={(checked) => setRememberMe(checked === true)}
              />
              <Label
                htmlFor="remember-me"
                className="text-sm font-normal cursor-pointer select-none"
              >
                Remember me
              </Label>
            </div>
            {error && (
              <p className="text-sm text-destructive" data-testid="text-login-error">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading} data-testid="button-login">
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Sign In
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground hover:underline mt-2"
              onClick={() => setShowForgot(true)}
            >
              Forgot your login details?
            </button>
          </form>
        </CardContent>
      </Card>

      <Dialog open={showForgot} onOpenChange={setShowForgot}>
        <DialogContent>
          <DialogHeader><DialogTitle>Recover Login Details</DialogTitle></DialogHeader>
          {forgotSent ? (
            <p className="text-sm text-center py-4">If an account with that email exists, login details have been sent to your email.</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Enter the email address associated with your account. We'll send your username and a temporary password.</p>
              <Input
                type="email"
                value={forgotEmail}
                onChange={e => setForgotEmail(e.target.value)}
                placeholder="your@email.com"
              />
              <Button className="w-full" disabled={forgotSending || !forgotEmail} onClick={async () => {
                setForgotSending(true);
                try {
                  await apiRequest("POST", "/api/forgot-password", { email: forgotEmail });
                  setForgotSent(true);
                } catch {}
                finally { setForgotSending(false); }
              }}>
                {forgotSending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Send Login Details
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      </div>
    </LogoBackground>
  );
}
