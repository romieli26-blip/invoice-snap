import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { ArrowLeft, KeyRound, Loader2, Eye, EyeOff } from "lucide-react";

/**
 * Self-service Change Password screen. Reached via the key icon in the
 * dashboard header. Calls POST /api/me/password with current + new password.
 *
 * The password rules mirror the server-side validator:
 *   - 6+ characters
 *   - at least one uppercase letter
 *   - at least one lowercase letter
 *   - at least one number
 *   - at least one special character (non-alphanumeric)
 *
 * On success the current session token stays valid (server refreshes it) so
 * the user isn't kicked out on the device they used to change it. Every OTHER
 * session tied to their account is invalidated.
 */
export default function ChangePasswordPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  const rules = {
    length: next.length >= 6,
    upper: /[A-Z]/.test(next),
    lower: /[a-z]/.test(next),
    digit: /[0-9]/.test(next),
    special: /[^A-Za-z0-9]/.test(next),
    match: next.length > 0 && next === confirm,
    different: next.length > 0 && next !== current,
  };
  const allOk = Object.values(rules).every(Boolean);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allOk) {
      toast({ title: "Fix the issues below", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiRequest("POST", "/api/me/password", {
        currentPassword: current,
        newPassword: next,
      });
      toast({ title: "Password updated", description: "Your new password is now active." });
      setLocation("/");
    } catch (err: any) {
      toast({
        title: "Couldn't update password",
        description: err.message || "Try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!user) {
    // Not signed in — bounce to root (login).
    setLocation("/");
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b sticky top-0 bg-background z-10">
        <div className="max-w-lg mx-auto p-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <KeyRound className="w-5 h-5" />
              Change Password
            </h1>
            <p className="text-xs text-muted-foreground">Signed in as {user.displayName}</p>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4">
        <Card>
          <CardContent className="p-4">
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1">
                <Label className="text-xs">Current Password</Label>
                <Input
                  type={show ? "text" : "password"}
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  required
                  data-testid="input-current-password"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">New Password</Label>
                <div className="relative">
                  <Input
                    type={show ? "text" : "password"}
                    value={next}
                    onChange={e => setNext(e.target.value)}
                    autoComplete="new-password"
                    required
                    data-testid="input-new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShow(s => !s)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted-foreground"
                    aria-label={show ? "Hide passwords" : "Show passwords"}
                  >
                    {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Confirm New Password</Label>
                <Input
                  type={show ? "text" : "password"}
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  data-testid="input-confirm-password"
                />
              </div>

              {/* Live rules checklist. Each rule turns green as it's satisfied. */}
              <div className="text-xs space-y-1 border rounded-md p-3 bg-muted/30">
                <p className="font-medium text-muted-foreground mb-1">Your new password must:</p>
                <Rule ok={rules.length} label="Be at least 6 characters long" />
                <Rule ok={rules.upper} label="Include an uppercase letter (A–Z)" />
                <Rule ok={rules.lower} label="Include a lowercase letter (a–z)" />
                <Rule ok={rules.digit} label="Include a number (0–9)" />
                <Rule ok={rules.special} label="Include a special character (!@#$…)" />
                <Rule ok={rules.different} label="Differ from your current password" />
                <Rule ok={rules.match} label="Match the confirmation field" />
              </div>

              <Button type="submit" className="w-full gap-2" disabled={saving || !allOk}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Update Password
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Rule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 ${ok ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
      <span className={`inline-block w-3 h-3 rounded-full ${ok ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
      {label}
    </div>
  );
}
