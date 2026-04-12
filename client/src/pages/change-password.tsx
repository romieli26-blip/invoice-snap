import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LogoBackground } from "@/components/LogoBackground";

export default function ChangePasswordPage() {
  const { user, login } = useAuth();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState(user?.firstName || "");
  const [lastName, setLastName] = useState(user?.lastName || "");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (!firstName.trim() || !lastName.trim()) {
      toast({ title: "Please enter your first and last name", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const pwRes = await apiRequest("POST", "/api/change-password", { currentPassword, newPassword });
      const pwData = await pwRes.json();
      if (!pwData.ok) throw new Error(pwData.error);

      const capFirst = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
      const capLast = lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();
      await apiRequest("POST", "/api/update-profile", { firstName: capFirst, lastName: capLast });

      toast({ title: "Account setup complete" });
      await login(user!.username, newPassword, true);
      window.location.reload();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <LogoBackground>
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center pb-2">
            <div className="mx-auto w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
              <Lock className="w-7 h-7 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">Set Up Your Account</h1>
            <p className="text-sm text-muted-foreground mt-1">Please set your name and create a secure password</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>First Name</Label>
                  <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="John" />
                </div>
                <div className="space-y-1">
                  <Label>Last Name</Label>
                  <Input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Smith" />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Current Password</Label>
                <Input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Temporary password" />
              </div>
              <div className="space-y-1">
                <Label>New Password</Label>
                <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Min 6 chars, uppercase, number, symbol" />
                <p className="text-[10px] text-muted-foreground">Must have: 6+ chars, uppercase, lowercase, number, special (!@#$%^&*)</p>
              </div>
              <div className="space-y-1">
                <Label>Confirm New Password</Label>
                <Input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Complete Setup
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </LogoBackground>
  );
}
