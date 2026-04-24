import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, UserPlus, Users, Clock, DollarSign, Loader2, ChevronRight, X } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

interface PMContractor {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  baseRate: string | null;
  offSiteRate: string | null;
  homeProperty: string | null;
  assignedProperties: string[];
}

interface TimeReport {
  id: number;
  userId: number;
  property: string;
  date: string;
  startTime: string;
  endTime: string;
  totalHours: string;
  onSite: number;
  notes: string | null;
  createdAt: string;
}

export default function MyContractorsPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [selectedContractor, setSelectedContractor] = useState<PMContractor | null>(null);

  // Form state (off-site rate & allow off-site intentionally omitted —
  // those are admin-only toggles managed from the user edit dialog).
  const [form, setForm] = useState({
    displayName: "",
    firstName: "",
    lastName: "",
    username: "",
    email: "",
    password: "",
    baseRate: "",
    mileageRate: "0.50",
    allowMiles: false,
    homeProperty: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const { data: contractors, isLoading } = useQuery<PMContractor[]>({
    queryKey: ["/api/pm/contractors"],
  });

  // PM's own assigned properties (for home property dropdown)
  const myProps = (user as any)?.assignedProperties as string[] | undefined;

  function resetForm() {
    setForm({
      displayName: "",
      firstName: "",
      lastName: "",
      username: "",
      email: "",
      password: "",
      baseRate: "",
      mileageRate: "0.50",
      allowMiles: false,
      homeProperty: "",
    });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!form.displayName.trim() || !form.username.trim() || !form.password.trim() || !form.email.trim()) {
      toast({ title: "Name, username, email, and password are required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/pm/contractors", {
        displayName: form.displayName.trim(),
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        username: form.username.trim(),
        email: form.email.trim(),
        password: form.password,
        baseRate: form.baseRate || "0",
        // offSiteRate and allowOffSite are intentionally not set by the PM;
        // the server defaults offSiteRate to "0" and allowOffSite to 0.
        // An admin can enable these later from the user edit dialog.
        mileageRate: form.mileageRate || "0.50",
        allowMiles: form.allowMiles,
        homeProperty: form.homeProperty || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/pm/contractors"] });
      toast({ title: `Contractor ${form.displayName} created` });
      resetForm();
      setAddOpen(false);
    } catch (err: any) {
      toast({
        title: "Failed to create contractor",
        description: err.message || "Please check the details and try again",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // Fetch time reports for the selected contractor
  const { data: timeReports, isLoading: reportsLoading } = useQuery<TimeReport[]>({
    queryKey: ["/api/pm/contractors", selectedContractor?.id, "time-reports"],
    enabled: !!selectedContractor,
    queryFn: async () => {
      if (!selectedContractor) return [];
      const res = await apiRequest("GET", `/api/pm/contractors/${selectedContractor.id}/time-reports`);
      return res.json();
    },
  });

  // Calculate total hours & pay for the selected contractor
  const totals = (() => {
    if (!timeReports || !selectedContractor) return { hours: 0, pay: 0, onSiteHours: 0, offSiteHours: 0 };
    const base = parseFloat(selectedContractor.baseRate || "0");
    const off = parseFloat(selectedContractor.offSiteRate || "0");
    let hours = 0, onSiteHours = 0, offSiteHours = 0, pay = 0;
    for (const r of timeReports) {
      const h = parseFloat(r.totalHours || "0");
      hours += h;
      if (r.onSite) {
        onSiteHours += h;
        pay += h * base;
      } else {
        offSiteHours += h;
        pay += h * off;
      }
    }
    return { hours, pay, onSiteHours, offSiteHours };
  })();

  return (
    <LogoBackground>
      <div className="bg-background min-h-screen p-4 pt-6 pb-12">
        <div className="max-w-lg mx-auto space-y-4">
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-indigo-600" />
              <h1 className="text-xl font-semibold">My Contractors</h1>
            </div>
            <Button size="sm" className="gap-1 bg-indigo-600 hover:bg-indigo-700" onClick={() => setAddOpen(true)}>
              <UserPlus className="w-4 h-4" />
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Create and manage contractors for your assigned properties. Tap a contractor to view their time reports and pay totals.
          </p>

          {/* List */}
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Card key={i}><CardContent className="py-3 h-14 animate-pulse bg-muted/30" /></Card>
              ))}
            </div>
          ) : contractors && contractors.length > 0 ? (
            <div className="space-y-2">
              {contractors.map(c => (
                <Card key={c.id} className="cursor-pointer hover:bg-accent/30 transition-colors" onClick={() => setSelectedContractor(c)}>
                  <CardContent className="py-3 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
                      <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                        {c.displayName.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.displayName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {c.homeProperty || c.assignedProperties?.[0] || "No property"}
                        {c.baseRate && parseFloat(c.baseRate) > 0 && (
                          <span className="ml-2">· ${c.baseRate}/hr</span>
                        )}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No contractors yet. Tap Add to create your first one.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Add Contractor Dialog */}
      <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Contractor</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Display Name *</Label>
              <Input value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} placeholder="Full name shown in the app" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">First Name</Label>
                <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last Name</Label>
                <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Username *</Label>
              <Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="Login username (lowercase, no spaces)" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email *</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="contractor@example.com" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Temporary Password *</Label>
              <Input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="6+ chars, upper, lower, number, special" />
              <p className="text-[10px] text-muted-foreground">Contractor will be required to change this on first login.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Base Rate ($/hr)</Label>
                <Input type="number" step="0.01" value={form.baseRate} onChange={e => setForm(f => ({ ...f, baseRate: e.target.value }))} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Mileage Rate ($/mile)</Label>
                <Input type="number" step="0.01" value={form.mileageRate} onChange={e => setForm(f => ({ ...f, mileageRate: e.target.value }))} placeholder="0.50" />
              </div>
            </div>
            <div className="flex items-center space-x-2 border rounded-md p-2 bg-amber-50 dark:bg-amber-950/20">
              <Checkbox
                id="pm-allow-miles"
                checked={form.allowMiles}
                onCheckedChange={(c) => {
                  const checking = c === true;
                  if (checking) {
                    const ok = window.confirm(
                      "Have you confirmed allowing miles to this contractor with the asset manager?\n\nClick OK to confirm. Click Cancel to leave miles disabled \u2014 an admin can enable this later if needed."
                    );
                    if (!ok) return;
                  }
                  setForm((f) => ({ ...f, allowMiles: checking }));
                }}
              />
              <Label htmlFor="pm-allow-miles" className="text-xs font-normal cursor-pointer">
                Allow this contractor to log miles
              </Label>
            </div>
            {myProps && myProps.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs">Home Property</Label>
                <Select value={form.homeProperty} onValueChange={v => setForm(f => ({ ...f, homeProperty: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Assign to all my properties" />
                  </SelectTrigger>
                  <SelectContent>
                    {myProps.map(p => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Leave blank to assign the contractor to all your properties.
                </p>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setAddOpen(false)} disabled={submitting}>Cancel</Button>
              <Button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-700" disabled={submitting}>
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Contractor Detail Dialog (time reports + pay) */}
      <Dialog open={!!selectedContractor} onOpenChange={(open) => { if (!open) setSelectedContractor(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedContractor?.displayName}</DialogTitle>
          </DialogHeader>
          {selectedContractor && (
            <div className="space-y-4">
              {/* Rate info */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 rounded bg-muted/40">
                  <div className="text-muted-foreground">Base Rate</div>
                  <div className="font-semibold text-sm">${selectedContractor.baseRate || "0"}/hr</div>
                </div>
                <div className="p-2 rounded bg-muted/40">
                  <div className="text-muted-foreground">Off-Site Rate</div>
                  <div className="font-semibold text-sm">${selectedContractor.offSiteRate || "0"}/hr</div>
                </div>
              </div>

              {/* Totals */}
              <div className="p-3 rounded-lg border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50 dark:bg-indigo-950/30">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3.5 h-3.5" /> Total Hours
                  </div>
                  <div className="font-semibold text-sm">{totals.hours.toFixed(2)}</div>
                </div>
                <div className="text-[10px] text-muted-foreground mb-2">
                  On-site: {totals.onSiteHours.toFixed(2)}h · Off-site: {totals.offSiteHours.toFixed(2)}h
                </div>
                <div className="flex items-center justify-between border-t border-indigo-200/50 dark:border-indigo-900/30 pt-2">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <DollarSign className="w-3.5 h-3.5" /> Estimated Pay
                  </div>
                  <div className="font-bold text-base text-indigo-700 dark:text-indigo-300">
                    ${totals.pay.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Time reports list */}
              <div>
                <h3 className="text-sm font-medium mb-2">Time Reports</h3>
                {reportsLoading ? (
                  <div className="space-y-2">
                    {[1, 2].map(i => (
                      <Card key={i}><CardContent className="py-3 h-14 animate-pulse bg-muted/30" /></Card>
                    ))}
                  </div>
                ) : timeReports && timeReports.length > 0 ? (
                  <div className="space-y-2">
                    {timeReports.map(r => (
                      <Card key={r.id}>
                        <CardContent className="py-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium">{r.property}</div>
                              <div className="text-xs text-muted-foreground">
                                {r.date} · {r.startTime}–{r.endTime}
                                {!r.onSite && <span className="ml-1 text-amber-600">(off-site)</span>}
                              </div>
                              {r.notes && <div className="text-xs text-muted-foreground mt-1 italic truncate">{r.notes}</div>}
                            </div>
                            <div className="text-sm font-semibold whitespace-nowrap">
                              {parseFloat(r.totalHours).toFixed(2)}h
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-4">No time reports yet.</p>
                )}
              </div>

              {/* Contact info */}
              <div className="pt-2 border-t text-xs text-muted-foreground space-y-0.5">
                <div>Username: <span className="font-mono">{selectedContractor.username}</span></div>
                {selectedContractor.email && <div>Email: {selectedContractor.email}</div>}
                {selectedContractor.assignedProperties?.length > 0 && (
                  <div>Properties: {selectedContractor.assignedProperties.join(", ")}</div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </LogoBackground>
  );
}
