import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { apiRequest, queryClient, setAuthToken, getAuthToken } from "@/lib/queryClient";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2, UserCircle, Shield, Loader2, Building2, Settings, Pencil, LogIn, Clock, Archive, ArchiveRestore, BookOpen, Upload, Download, FileText, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

interface UserItem {
  id: number;
  username: string;
  displayName: string;
  role: string;
  email?: string;
  dailyTimeReport?: number;
  dailyTransactionReport?: number;
  reconciliationReport?: number;
  assignedProperties: string[];
  archived?: number;
}

interface PropertyItem {
  id: number;
  name: string;
  sheetsTabId: number | null;
}

export default function AdminPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // User form state
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState("manager");
  const [newEmail, setNewEmail] = useState("");
  const [newDailyTimeReport, setNewDailyTimeReport] = useState(false);
  const [newDailyTxReport, setNewDailyTxReport] = useState(false);
  const [newReconReport, setNewReconReport] = useState(false);
  const [newHomeProperty, setNewHomeProperty] = useState("");

  const [newUserPropertyIds, setNewUserPropertyIds] = useState<number[]>([]);

  // Edit user state
  const [editingUser, setEditingUser] = useState<any>(null);
  const [editUserName, setEditUserName] = useState("");
  const [editUserEmail, setEditUserEmail] = useState("");
  const [editUserPassword, setEditUserPassword] = useState("");
  const [editUserRole, setEditUserRole] = useState("manager");
  const [editUserDailyTimeReport, setEditUserDailyTimeReport] = useState(false);
  const [editUserDailyTxReport, setEditUserDailyTxReport] = useState(false);
  const [editUserReconReport, setEditUserReconReport] = useState(false);
  const [editUserFirstName, setEditUserFirstName] = useState("");
  const [editUserLastName, setEditUserLastName] = useState("");
  const [editUserBaseRate, setEditUserBaseRate] = useState("");
  const [editUserOffSiteRate, setEditUserOffSiteRate] = useState("");
  // Multi-position pay (item 2). Each entry { name, rate }. Empty array = legacy single-rate mode.
  const [editUserPositions, setEditUserPositions] = useState<{ name: string; rate: string }[]>([]);
  const [editUserHomeProperty, setEditUserHomeProperty] = useState("");
  const [editUserAllowOffSite, setEditUserAllowOffSite] = useState(false);
  const [editUserMileageRate, setEditUserMileageRate] = useState("0.50");
  const [editUserAllowSpecialTerms, setEditUserAllowSpecialTerms] = useState(false);
  const [editUserSpecialTermsAmount, setEditUserSpecialTermsAmount] = useState("");
  const [editUserW9OrW4, setEditUserW9OrW4] = useState("");
  const [editUserDocsComplete, setEditUserDocsComplete] = useState(false);
  const [editUserRequireFinancialConfirm, setEditUserRequireFinancialConfirm] = useState(false);
  const [editUserAllowPastDates, setEditUserAllowPastDates] = useState(false);
  const [editUserReceiveTransactionEmails, setEditUserReceiveTransactionEmails] = useState(false);
  const [editUserAllowWorkCredits, setEditUserAllowWorkCredits] = useState(false);
  const [editUserWorkCreditReport, setEditUserWorkCreditReport] = useState(false);
  const [editUserDocumentUploadReport, setEditUserDocumentUploadReport] = useState(false);
  const [editUserDocReminderEnabled, setEditUserDocReminderEnabled] = useState(false);
  const [editUserDocReminderDays, setEditUserDocReminderDays] = useState(3);
  const [editUserAllowContractorDocs, setEditUserAllowContractorDocs] = useState(false);
  const [editUserAllowCreatingContractors, setEditUserAllowCreatingContractors] = useState(false);
  const [editUserAllowMiles, setEditUserAllowMiles] = useState(true);
  const [editUserDailyReminderEnabled, setEditUserDailyReminderEnabled] = useState(false);
  const [editUserAllowFlatRate, setEditUserAllowFlatRate] = useState(false);
  const [editUserShowWorkReport, setEditUserShowWorkReport] = useState(false);
  const [editUserShowMyDocuments, setEditUserShowMyDocuments] = useState(false);
  const [editUserShowWorkCredit, setEditUserShowWorkCredit] = useState(false);
  const [editUserShowMyContractors, setEditUserShowMyContractors] = useState(false);
  const [editUserSaving, setEditUserSaving] = useState(false);

  // Edit properties assignment state
  const [editPropsUserId, setEditPropsUserId] = useState<number | null>(null);
  const [editPropsSelected, setEditPropsSelected] = useState<number[]>([]);

  // Workforce report state
  const [wfUserId, setWfUserId] = useState("");
  const [wfStartDate, setWfStartDate] = useState("");
  const [wfEndDate, setWfEndDate] = useState("");
  const [wfLoading, setWfLoading] = useState(false);
  const [wfResult, setWfResult] = useState<any>(null);

  // Property form state
  const [propDialogOpen, setPropDialogOpen] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");

  // ---- Users queries/mutations ----
  // useState for showArchived is hoisted so it can drive the query key.
  const [showArchivedToggle, setShowArchivedToggle] = useState(false);
  const { data: users, isLoading: usersLoading } = useQuery<UserItem[]>({
    queryKey: ["/api/users", showArchivedToggle ? "with-archived" : "active-only"],
    queryFn: async () => {
      const url = showArchivedToggle ? "/api/users?includeArchived=1" : "/api/users";
      const res = await apiRequest("GET", url);
      return res.json();
    },
  });

  const createUserMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users", {
        username: newUsername,
        password: newPassword,
        displayName: newDisplayName,
        role: newRole,
        email: newEmail || undefined,
        dailyTimeReport: newDailyTimeReport,
        dailyTransactionReport: newDailyTxReport,
        reconciliationReport: newReconReport,
        homeProperty: newHomeProperty || undefined,
      });
      const newUser = await res.json();
      if (newRole === "manager" && newUserPropertyIds.length > 0) {
        await apiRequest("PUT", `/api/users/${newUser.id}/properties`, { propertyIds: newUserPropertyIds });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setNewUsername("");
      setNewPassword("");
      setNewDisplayName("");
      setNewRole("manager");
      setNewEmail("");
      setNewDailyTimeReport(false);
      setNewDailyTxReport(false);
      setNewReconReport(false);
      setNewHomeProperty("");
      setNewUserPropertyIds([]);
      setUserDialogOpen(false);
      toast({ title: "User created" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/users/${id}`);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: "User deleted",
        description: data?.tabRemoved
          ? `Their tab was removed from the time-tracking spreadsheet. Cash, receipts, and work credits are kept.`
          : `Their cash, receipts, and work credits are kept.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const archiveUserMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/users/${id}/archive`);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: "User archived",
        description: data?.tabHidden
          ? `They no longer appear in the user list and their spreadsheet tab has been hidden. All historical data is preserved.`
          : `They no longer appear in the user list. All historical data is preserved.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const unarchiveUserMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/users/${id}/unarchive`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User restored" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });



  const saveUserPropsMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("PUT", `/api/users/${editPropsUserId}/properties`, {
        propertyIds: editPropsSelected,
      });
    },
    onSuccess: () => {
      setEditPropsUserId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "Properties updated" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function openEditProps(userId: number) {
    setEditPropsUserId(userId);
    try {
      const res = await apiRequest("GET", `/api/users/${userId}/properties`);
      const ids: number[] = await res.json();
      setEditPropsSelected(ids);
    } catch {
      setEditPropsSelected([]);
    }
  }

  // ---- Properties queries/mutations ----
  const { data: propertiesList, isLoading: propsLoading } = useQuery<PropertyItem[]>({
    queryKey: ["/api/properties"],
  });

  const createPropMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/properties", { name: newPropertyName });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties"] });
      setNewPropertyName("");
      setPropDialogOpen(false);
      toast({ title: "Property added", description: "Google Sheets tab created automatically." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deletePropMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/properties/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties"] });
      toast({ title: "Property removed" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (user?.role !== "admin" && user?.role !== "super_admin") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <p className="text-muted-foreground">Admin access required.</p>
      </div>
    );
  }

  return (
    <LogoBackground>
      <div className="bg-background p-4 pt-6 pb-12 min-h-screen">
      <div className="max-w-lg mx-auto space-y-6">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <h1 className="text-xl font-semibold" data-testid="text-admin-title">Admin Panel</h1>

        {/* Re-sync / Sync buttons removed — these run automatically on every
           create, edit and delete now, so the manual triggers were redundant. */}
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={async () => {
            try {
              const res = await apiRequest("POST", "/api/admin/daily-report", { date: new Date().toISOString().split("T")[0] });
              const data = await res.json();
              toast({ title: "Daily report sent", description: `${data.receipts} receipts, ${data.cashTx} cash transactions. Sent to: ${data.sentTo.join(", ") || "No subscribers"}` });
            } catch (e: any) {
              toast({ title: "Report failed", description: e.message || "Error", variant: "destructive" });
            }
          }}
        >
          Send Daily Report
        </Button>

        <SyncStatusPanel />

        {/* ---- WORKFORCE REPORT SECTION ---- */}
        <section className="space-y-3 border rounded-lg p-3">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-600" />
            Workforce Report
          </h2>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">Employee</Label>
              <Select value={wfUserId} onValueChange={setWfUserId}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {users?.filter(u => u.role === "contractor" || u.role === "manager").map(u => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Start Date</Label>
                <Input type="date" value={wfStartDate} onChange={e => setWfStartDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">End Date</Label>
                <Input type="date" value={wfEndDate} onChange={e => setWfEndDate(e.target.value)} />
              </div>
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={wfLoading || !wfUserId || !wfStartDate || !wfEndDate}
              onClick={async () => {
                setWfLoading(true);
                setWfResult(null);
                try {
                  const res = await apiRequest("GET", `/api/admin/workforce-report?userId=${wfUserId}&startDate=${wfStartDate}&endDate=${wfEndDate}`);
                  const data = await res.json();
                  setWfResult(data);
                } catch (e: any) {
                  toast({ title: "Failed to generate report", description: e.message, variant: "destructive" });
                } finally {
                  setWfLoading(false);
                }
              }}
            >
              {wfLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Generate Report
            </Button>
          </div>
          {wfResult && (
            <div className="border rounded-md p-3 space-y-3 bg-muted/30">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  {wfResult.user.firstName && wfResult.user.lastName
                    ? `${wfResult.user.firstName} ${wfResult.user.lastName}`
                    : wfResult.user.displayName}
                </p>
                <span className="text-xs text-muted-foreground">
                  {wfResult.period.startDate} to {wfResult.period.endDate}
                </span>
              </div>

              {/* Financial Summary */}
              <div className="bg-blue-50 dark:bg-blue-950/30 rounded-md p-3 space-y-1">
                <p className="text-xs font-semibold text-blue-800 dark:text-blue-300 mb-2">Pay Summary</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div className="text-muted-foreground">Days Worked</div>
                  <div className="text-right font-medium">{wfResult.summary.daysWorked}</div>
                  <div className="text-muted-foreground">Total Hours</div>
                  <div className="text-right font-medium">{wfResult.summary.totalHours} hrs</div>
                  {/* Rate breakdown — splits labor by rate when multiple
                      rates were used (e.g. two positions, or on-site mixed
                      with off-site). Single-rate reports render the classic
                      Rate + Labor pair. */}
                  {(() => {
                    const byRate = new Map<number, number>();
                    for (const r of (wfResult.reports || []) as any[]) {
                      const rate = Number(r.rate || 0);
                      if (!rate) continue;
                      const hrs = Number(r.calculatedHours ?? r.hours ?? 0);
                      byRate.set(rate, (byRate.get(rate) || 0) + hrs);
                    }
                    const rateGroups = Array.from(byRate.entries())
                      .sort((a, b) => b[0] - a[0]);
                    if (rateGroups.length <= 1) {
                      const rate = rateGroups[0]?.[0] ?? Number(wfResult.summary.baseRate);
                      return (
                        <>
                          <div className="text-muted-foreground">Rate</div>
                          <div className="text-right font-medium">${rate}/hr</div>
                          <div className="text-muted-foreground">
                            Labor ({wfResult.summary.totalHours}h × ${rate})
                          </div>
                          <div className="text-right font-semibold">${wfResult.summary.laborCost?.toFixed(2)}</div>
                        </>
                      );
                    }
                    return (
                      <>
                        {rateGroups.map(([rate, hrs]) => (
                          <div key={rate} className="col-span-2 grid grid-cols-2 gap-x-4">
                            <div className="text-muted-foreground">
                              Labor ({hrs.toFixed(1)}h × ${rate})
                            </div>
                            <div className="text-right">${(hrs * rate).toFixed(2)}</div>
                          </div>
                        ))}
                        <div className="text-muted-foreground font-medium">Labor Subtotal</div>
                        <div className="text-right font-semibold">${wfResult.summary.laborCost?.toFixed(2)}</div>
                      </>
                    );
                  })()}
                  <div className="text-muted-foreground">Mileage ({wfResult.summary.totalMiles} mi)</div>
                  <div className="text-right">${wfResult.summary.totalMileagePay?.toFixed(2)}</div>
                  <div className="text-muted-foreground">Special Terms / Travel</div>
                  <div className="text-right">${wfResult.summary.totalSpecialTerms?.toFixed(2)}</div>
                  {wfResult.summary.flatRateCount > 0 && (
                    <>
                      <div className="text-muted-foreground">Flat Rate ({wfResult.summary.flatRateCount} {wfResult.summary.flatRateCount === 1 ? "entry" : "entries"})</div>
                      <div className="text-right">${wfResult.summary.totalFlatRate?.toFixed(2)}</div>
                    </>
                  )}
                </div>
                <div className="border-t border-blue-200 dark:border-blue-800 mt-2 pt-2 flex justify-between items-center">
                  <span className="font-bold text-sm">Total Pay</span>
                  <span className="font-bold text-lg text-blue-700 dark:text-blue-300">${wfResult.summary.grandTotal?.toFixed(2)}</span>
                </div>
              </div>

              {/* Flat-Rate Entries (when present) — mirrors the contractor-side WorkforceReport */}
              {wfResult.flatRates && wfResult.flatRates.length > 0 && (
                <div className="space-y-1 mt-2">
                  <p className="text-xs font-medium text-muted-foreground">Flat-Rate Entries ({wfResult.flatRates.length})</p>
                  {wfResult.flatRates.map((fr: any) => (
                    <details key={fr.id} className="text-xs bg-background rounded border">
                      <summary className="p-2 cursor-pointer hover:bg-muted/50 flex justify-between items-center">
                        <span><span className="font-medium">{fr.date}</span> — {fr.property}</span>
                        <span className="font-semibold text-pink-700 dark:text-pink-400">${fr.rate.toFixed(2)}</span>
                      </summary>
                      <div className="p-2 pt-0 border-t space-y-1">
                        {fr.accomplishmentsList?.length > 0 && (
                          <div>
                            <span className="text-muted-foreground">Accomplishments:</span>
                            <ul className="list-disc list-inside ml-1">
                              {fr.accomplishmentsList.map((a: string, i: number) => (
                                <li key={i}>{a}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {fr.notes && <p className="text-muted-foreground">Notes: {fr.notes}</p>}
                      </div>
                    </details>
                  ))}
                </div>
              )}

              {/* Collapsible Entries */}
              {wfResult.reports.length > 0 && (
                <div className="space-y-1 mt-2">
                  <p className="text-xs font-medium text-muted-foreground">Entries ({wfResult.reports.length} reports) — tap to expand</p>
                  {wfResult.reports.map((r: any) => {
                    const timeDisplay = (() => {
                      try {
                        const blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : [];
                        if (blocks.length > 0) return blocks.map((b: any) => `${b.start}–${b.end}`).join(", ");
                      } catch {}
                      return `${r.startTime}–${r.endTime}`;
                    })();
                    return (
                      <details key={r.id} className="text-xs bg-background rounded border">
                        <summary className="p-2 cursor-pointer hover:bg-muted/50 flex justify-between items-center">
                          <span><span className="font-medium">{r.date}</span> — {r.property} — {r.calculatedHours}h</span>
                          <span className="font-semibold text-blue-700">${r.entryTotal?.toFixed(2)}</span>
                        </summary>
                        <div className="p-2 pt-0 border-t space-y-1">
                          <div className="grid grid-cols-2 gap-1">
                            <span className="text-muted-foreground">Time</span>
                            <span className="text-right">{timeDisplay}</span>
                            <span className="text-muted-foreground">Hours</span>
                            <span className="text-right">{r.calculatedHours}h</span>
                            <span className="text-muted-foreground">Rate</span>
                            <span className="text-right">${r.rate}/hr{r.isOffSite ? " (off-site)" : ""}</span>
                            <span className="text-muted-foreground">Labor</span>
                            <span className="text-right font-medium">${r.laborCost?.toFixed(2)}</span>
                            <span className="text-muted-foreground">Miles</span>
                            <span className="text-right">{r.miles || "0"} (${r.mileageAmount?.toFixed(2)})</span>
                            <span className="text-muted-foreground">Special Terms</span>
                            <span className="text-right">${r.specialAmount?.toFixed(2)}</span>
                          </div>
                          {r.accomplishmentsList?.length > 0 && (
                            <div className="mt-1">
                              <span className="text-muted-foreground">Accomplishments:</span>
                              <ul className="list-disc list-inside ml-1">
                                {r.accomplishmentsList.map((a: string, i: number) => (
                                  <li key={i}>{a}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {r.notes && <p className="text-muted-foreground">Notes: {r.notes}</p>}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ---- PROPERTIES SECTION ---- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Building2 className="w-4 h-4 text-primary" />
              Properties
            </h2>
            <Dialog open={propDialogOpen} onOpenChange={setPropDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1" data-testid="button-add-property">
                  <Plus className="w-4 h-4" />
                  Add Property
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Property</DialogTitle>
                </DialogHeader>
                <form
                  onSubmit={e => {
                    e.preventDefault();
                    createPropMutation.mutate();
                  }}
                  className="space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor="newPropertyName">Property Name</Label>
                    <Input
                      id="newPropertyName"
                      value={newPropertyName}
                      onChange={e => setNewPropertyName(e.target.value)}
                      placeholder="e.g. Sunrise Villas"
                      required
                      data-testid="input-new-property-name"
                    />
                    <p className="text-xs text-muted-foreground">
                      A new tab will be created automatically in the Google Sheet.
                    </p>
                  </div>
                  <Button type="submit" className="w-full" disabled={createPropMutation.isPending} data-testid="button-create-property">
                    {createPropMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Add Property
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {propsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Card key={i}>
                  <CardContent className="py-3 h-12 animate-pulse bg-muted/30" />
                </Card>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {propertiesList?.map(prop => (
                <PropertyAdminCard
                  key={prop.id}
                  prop={prop}
                  onDelete={() => deletePropMutation.mutate(prop.id)}
                  deletePending={deletePropMutation.isPending}
                />
              ))}
              {propertiesList?.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No properties yet.</p>
              )}
            </div>
          )}
        </section>

        {/* ---- PROPERTY MANAGER PLAYBOOK SECTION ---- */}
        <PlaybookAdminSection />

        {/* ---- USERS SECTION ---- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <UserCircle className="w-4 h-4 text-primary" />
              Users
            </h2>
            <Dialog open={userDialogOpen} onOpenChange={setUserDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1" data-testid="button-add-user">
                  <Plus className="w-4 h-4" />
                  Add User
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New User</DialogTitle>
                </DialogHeader>
                <form
                  onSubmit={e => {
                    e.preventDefault();
                    createUserMutation.mutate();
                  }}
                  className="space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor="newDisplayName">Display Name</Label>
                    <Input
                      id="newDisplayName"
                      value={newDisplayName}
                      onChange={e => setNewDisplayName(e.target.value)}
                      placeholder="e.g. John Smith"
                      required
                      data-testid="input-new-display-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newUsername">Username</Label>
                    <Input
                      id="newUsername"
                      value={newUsername}
                      onChange={e => setNewUsername(e.target.value)}
                      placeholder="e.g. jsmith"
                      autoCapitalize="none"
                      required
                      data-testid="input-new-username"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">Password</Label>
                    <Input
                      id="newPassword"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="Set a password"
                      required
                      data-testid="input-new-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select value={newRole} onValueChange={setNewRole}>
                      <SelectTrigger data-testid="select-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manager">Property Manager</SelectItem>
                        <SelectItem value="contractor">Contractor</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                        {user?.role === "super_admin" && <SelectItem value="super_admin">Super Admin</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-email">Email</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newEmail}
                      onChange={e => setNewEmail(e.target.value)}
                      placeholder="user@example.com"
                      required
                    />
                  </div>
                  {propertiesList && propertiesList.length > 0 && (
                    <div className="space-y-2">
                      <Label>Home Base Property</Label>
                      <Select value={newHomeProperty} onValueChange={(val) => {
                        setNewHomeProperty(val);
                        // Auto-include home property in assigned properties
                        const homeProp = propertiesList?.find(p => p.name === val);
                        if (homeProp && !newUserPropertyIds.includes(homeProp.id)) {
                          setNewUserPropertyIds(prev => [...prev, homeProp.id]);
                        }
                      }}>
                        <SelectTrigger><SelectValue placeholder="Select home property" /></SelectTrigger>
                        <SelectContent>
                          {propertiesList.map(p => (
                            <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {(newRole === "admin" || newRole === "super_admin") && newEmail && (
                    <>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="daily-time-report"
                          checked={newDailyTimeReport}
                          onCheckedChange={(checked) => setNewDailyTimeReport(checked === true)}
                        />
                        <Label htmlFor="daily-time-report" className="text-sm font-normal cursor-pointer">
                          Daily Time Report
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="daily-tx-report"
                          checked={newDailyTxReport}
                          onCheckedChange={(checked) => setNewDailyTxReport(checked === true)}
                        />
                        <Label htmlFor="daily-tx-report" className="text-sm font-normal cursor-pointer">
                          Daily Transaction Report
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="recon-report"
                          checked={newReconReport}
                          onCheckedChange={(checked) => setNewReconReport(checked === true)}
                        />
                        <Label htmlFor="recon-report" className="text-sm font-normal cursor-pointer">
                          Reconciliation Report
                        </Label>
                      </div>
                    </>
                  )}
                  {newRole === "manager" && propertiesList && propertiesList.length > 0 && (
                    <div className="space-y-2">
                      <Label>Assign Properties</Label>
                      <div className="space-y-2 max-h-40 overflow-y-auto border rounded-md p-2">
                        {propertiesList.map(prop => (
                          <div key={prop.id} className="flex items-center space-x-2">
                            <Checkbox
                              id={`new-user-prop-${prop.id}`}
                              checked={newUserPropertyIds.includes(prop.id)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setNewUserPropertyIds(prev => [...prev, prop.id]);
                                } else {
                                  setNewUserPropertyIds(prev => prev.filter(id => id !== prop.id));
                                }
                              }}
                            />
                            <Label htmlFor={`new-user-prop-${prop.id}`} className="text-sm font-normal cursor-pointer">
                              {prop.name}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <Button type="submit" className="w-full" disabled={createUserMutation.isPending} data-testid="button-create-user">
                    {createUserMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Create User
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {/* Show archived toggle */}
          <div className="flex items-center gap-2 mb-2">
            <Checkbox
              id="show-archived"
              checked={showArchivedToggle}
              onCheckedChange={(v) => setShowArchivedToggle(v === true)}
            />
            <Label htmlFor="show-archived" className="text-sm text-muted-foreground cursor-pointer">
              Show archived users
            </Label>
          </div>

          {usersLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Card key={i}>
                  <CardContent className="py-3 h-16 animate-pulse bg-muted/30" />
                </Card>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {users?.map(u => (
                <Card key={u.id} data-testid={`card-user-${u.id}`} className={u.archived ? "opacity-60 border-amber-500/40" : ""}>
                  <CardContent className="py-3 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      {(u.role === "admin" || u.role === "super_admin") ? (
                        <Shield className="w-5 h-5 text-primary" />
                      ) : (
                        <UserCircle className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium flex items-center gap-1.5">
                        {u.displayName}
                        {!!u.archived && (
                          <Badge variant="outline" className="text-[10px] py-0 h-4 border-amber-500/60 text-amber-700 dark:text-amber-400">Archived</Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">@{u.username} · {u.role === "super_admin" ? "Super Admin" : u.role === "admin" ? "Admin" : u.role === "contractor" ? "Contractor" : "Manager"}</p>
                      {u.email && (
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      )}
                      {u.dailyTimeReport === 1 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-green-600 border-green-300">Time Reports</Badge>
                      )}
                      {u.dailyTransactionReport === 1 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-blue-600 border-blue-300">Transaction Reports</Badge>
                      )}
                      {u.reconciliationReport === 1 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-yellow-600 border-yellow-300">Reconciliation</Badge>
                      )}
                      {u.role === "manager" && u.assignedProperties && u.assignedProperties.length > 0 && (
                        <p className="text-xs text-primary/70 truncate">
                          {u.assignedProperties.join(", ")}
                        </p>
                      )}
                      {(u as any).createdByName && (
                        <p className="text-[11px] text-muted-foreground italic">
                          Created by {(u as any).createdByName}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {u.id !== user?.id && user?.role === "super_admin" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-blue-600"
                            title="Login as this user"
                            onClick={async () => {
                              if (!window.confirm(`Login as ${u.displayName}? You will be logged out of your current session.`)) return;
                              try {
                                const res = await apiRequest("POST", `/api/admin/impersonate/${u.id}`);
                                const data = await res.json();
                                setAuthToken(data.token, true);
                                window.location.reload();
                              } catch { toast({ title: "Failed to impersonate", variant: "destructive" }); }
                            }}
                          >
                            <LogIn className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-primary"
                          onClick={() => {
                            setEditingUser(u);
                            setEditUserName(u.displayName);
                            setEditUserEmail((u as any).email || "");
                            setEditUserPassword("");
                            setEditUserRole(u.role);
                            setEditUserDailyTimeReport((u as any).dailyTimeReport === 1);
                            setEditUserDailyTxReport((u as any).dailyTransactionReport === 1);
                            setEditUserReconReport((u as any).reconciliationReport === 1);
                            setEditUserFirstName((u as any).firstName || "");
                            setEditUserLastName((u as any).lastName || "");
                            setEditUserBaseRate((u as any).baseRate || "");
                            setEditUserOffSiteRate((u as any).offSiteRate || "");
                            // Parse the JSON positions list if it exists.
                            try {
                              const raw = (u as any).positions;
                              if (raw) {
                                const parsed = JSON.parse(raw);
                                setEditUserPositions(Array.isArray(parsed)
                                  ? parsed.map((p: any) => ({ name: String(p.name || ""), rate: String(p.rate || "") }))
                                  : []);
                              } else {
                                setEditUserPositions([]);
                              }
                            } catch { setEditUserPositions([]); }
                            setEditUserHomeProperty((u as any).homeProperty || "");
                            setEditUserAllowOffSite((u as any).allowOffSite === 1);
                            setEditUserMileageRate((u as any).mileageRate || "0.50");
                            setEditUserAllowSpecialTerms((u as any).allowSpecialTerms === 1);
                            setEditUserSpecialTermsAmount((u as any).specialTermsAmount || "");
                            setEditUserW9OrW4((u as any).w9OrW4 || "");
                            setEditUserDocsComplete((u as any).docsComplete === 1);
                            setEditUserRequireFinancialConfirm((u as any).requireFinancialConfirm === 1);
                            setEditUserAllowPastDates((u as any).allowPastDates === 1);
                            setEditUserReceiveTransactionEmails((u as any).receiveTransactionEmails === 1);
                            setEditUserAllowWorkCredits((u as any).allowWorkCredits === 1);
                            setEditUserWorkCreditReport((u as any).workCreditReport === 1);
                            setEditUserDocumentUploadReport((u as any).documentUploadReport === 1);
                            setEditUserDocReminderEnabled((u as any).docReminderEnabled === 1);
                            setEditUserDocReminderDays((u as any).docReminderDays || 3);
                            setEditUserAllowContractorDocs((u as any).allowContractorDocs === 1);
                            setEditUserAllowCreatingContractors((u as any).allowCreatingContractors === 1);
                            setEditUserAllowMiles((u as any).allowMiles === 0 ? false : true);
                            setEditUserDailyReminderEnabled((u as any).dailyReminderEnabled === 1);
                            setEditUserAllowFlatRate((u as any).allowFlatRate === 1);
                            setEditUserShowWorkReport((u as any).showWorkReport === 1);
                            setEditUserShowMyDocuments((u as any).showMyDocuments === 1);
                            setEditUserShowWorkCredit((u as any).showWorkCredit === 1);
                            setEditUserShowMyContractors((u as any).showMyContractors === 1);
                          }}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        {!["admin","super_admin"].includes(u.role) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-primary"
                            onClick={() => openEditProps(u.id)}
                            data-testid={`button-edit-props-${u.id}`}
                          >
                            <Settings className="w-4 h-4" />
                          </Button>
                        )}
                        {u.id !== user?.id && !u.archived && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Archive user (hides them from list, keeps all data)"
                            className="text-muted-foreground hover:text-amber-600"
                            onClick={() => {
                              if (window.confirm(`Archive ${u.displayName}?\n\nThey will be hidden from the user list and unable to log in, but all their cash transactions, receipts, work credits, and time reports will be kept. Their tab on the time-tracking spreadsheet will be hidden (not deleted). You can restore them later.`)) {
                                archiveUserMutation.mutate(u.id);
                              }
                            }}
                            disabled={archiveUserMutation.isPending}
                            data-testid={`button-archive-user-${u.id}`}
                          >
                            <Archive className="w-4 h-4" />
                          </Button>
                        )}
                        {u.id !== user?.id && u.archived && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Restore archived user"
                            className="text-muted-foreground hover:text-green-600"
                            onClick={() => unarchiveUserMutation.mutate(u.id)}
                            disabled={unarchiveUserMutation.isPending}
                            data-testid={`button-unarchive-user-${u.id}`}
                          >
                            <ArchiveRestore className="w-4 h-4" />
                          </Button>
                        )}
                        {u.id !== user?.id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete user permanently (cash/receipts/work credits are kept; spreadsheet tab is removed)"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              if (window.confirm(`Permanently delete ${u.displayName}?\n\nThis removes the user account itself. Their cash transactions, credit-card receipts, and work credits will be kept under their name. Their tab on the time-tracking spreadsheet will be REMOVED.\n\nIf you just want to hide them, use Archive instead.`)) {
                                deleteUserMutation.mutate(u.id);
                              }
                            }}
                            disabled={deleteUserMutation.isPending}
                            data-testid={`button-delete-user-${u.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* ---- EDIT USER DIALOG ---- */}
        <Dialog open={editingUser !== null} onOpenChange={(open) => { if (!open) setEditingUser(null); }}>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Edit User: {editingUser?.username}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Display Name</Label>
                <Input value={editUserName} onChange={e => setEditUserName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email (optional)</Label>
                <Input type="email" value={editUserEmail} onChange={e => setEditUserEmail(e.target.value)} placeholder="user@example.com" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">New Password (leave blank to keep current)</Label>
                <Input type="password" value={editUserPassword} onChange={e => setEditUserPassword(e.target.value)} placeholder="Leave blank to keep unchanged" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Role</Label>
                <Select value={editUserRole} onValueChange={setEditUserRole}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="contractor">Contractor</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    {user?.role === "super_admin" && <SelectItem value="super_admin">Super Admin</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              {(editUserRole === "admin" || editUserRole === "super_admin") && editUserEmail && (
                <>
                  <div className="border-t pt-3 mt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Real-Time Email Notifications</p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-tx-emails" checked={editUserReceiveTransactionEmails} onCheckedChange={c => setEditUserReceiveTransactionEmails(c === true)} />
                    <Label htmlFor="edit-tx-emails" className="text-sm font-normal cursor-pointer">CC Receipts & Cash Transactions (per entry)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-daily-time" checked={editUserDailyTimeReport} onCheckedChange={c => setEditUserDailyTimeReport(c === true)} />
                    <Label htmlFor="edit-daily-time" className="text-sm font-normal cursor-pointer">Work Reports / Time Reporting (per entry + daily)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-wc-report" checked={editUserWorkCreditReport} onCheckedChange={c => setEditUserWorkCreditReport(c === true)} />
                    <Label htmlFor="edit-wc-report" className="text-sm font-normal cursor-pointer">Work Credits (per entry + daily)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-doc-upload-report" checked={editUserDocumentUploadReport} onCheckedChange={c => setEditUserDocumentUploadReport(c === true)} />
                    <Label htmlFor="edit-doc-upload-report" className="text-sm font-normal cursor-pointer">Document Uploads (per upload)</Label>
                  </div>
                  <div className="border-t pt-2 mt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Daily Summary Reports</p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-daily-tx" checked={editUserDailyTxReport} onCheckedChange={c => setEditUserDailyTxReport(c === true)} />
                    <Label htmlFor="edit-daily-tx" className="text-sm font-normal cursor-pointer">Daily Transaction Summary (CC + Cash)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-recon" checked={editUserReconReport} onCheckedChange={c => setEditUserReconReport(c === true)} />
                    <Label htmlFor="edit-recon" className="text-sm font-normal cursor-pointer">Reconciliation Reports</Label>
                  </div>
                </>
              )}

              {/* Workforce fields for contractors (and optionally managers) */}
              {(editUserRole === "contractor" || editUserRole === "manager") && (
                <>
                  <div className="border-t pt-3 mt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Workforce Settings</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">First Name</Label>
                      <Input value={editUserFirstName} onChange={e => setEditUserFirstName(e.target.value)} placeholder="First" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Last Name</Label>
                      <Input value={editUserLastName} onChange={e => setEditUserLastName(e.target.value)} placeholder="Last" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Base Rate ($/hr)</Label>
                      <Input type="number" step="0.01" value={editUserBaseRate} onChange={e => setEditUserBaseRate(e.target.value)} placeholder="0.00" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Off-Site Rate ($/hr)</Label>
                      <Input type="number" step="0.01" value={editUserOffSiteRate} onChange={e => setEditUserOffSiteRate(e.target.value)} placeholder="0.00" />
                    </div>
                  </div>

                  {/* Multi-position pay (optional) */}
                  <div className="space-y-1 border rounded-md p-2 bg-muted/30">
                    <Label className="text-xs font-medium">Positions (optional)</Label>
                    <p className="text-[11px] text-muted-foreground">
                      Add 2 or more positions if this user reports at different rates depending on the work.
                      When filled in, the Work Report screen will ask them to pick a position.
                    </p>
                    {editUserPositions.map((p, i) => (
                      <div key={i} className="grid grid-cols-[1fr_90px_28px] gap-1 items-center">
                        <Input
                          value={p.name}
                          onChange={e => setEditUserPositions(prev => prev.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                          placeholder="e.g. Property Manager"
                          className="h-8 text-xs"
                        />
                        <Input
                          type="number" step="0.01"
                          value={p.rate}
                          onChange={e => setEditUserPositions(prev => prev.map((x, idx) => idx === i ? { ...x, rate: e.target.value } : x))}
                          placeholder="Rate"
                          className="h-8 text-xs"
                        />
                        <Button
                          type="button" variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => setEditUserPositions(prev => prev.filter((_, idx) => idx !== i))}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button" variant="outline" size="sm" className="h-7 text-xs gap-1 w-full"
                      onClick={() => setEditUserPositions(prev => [...prev, { name: "", rate: "" }])}
                    >
                      <Plus className="w-3 h-3" /> Add position
                    </Button>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Home Property</Label>
                    <Select value={editUserHomeProperty} onValueChange={setEditUserHomeProperty}>
                      <SelectTrigger><SelectValue placeholder="Select home property" /></SelectTrigger>
                      <SelectContent>
                        {propertiesList?.map(p => (
                          <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-offsite" checked={editUserAllowOffSite} onCheckedChange={c => setEditUserAllowOffSite(c === true)} />
                    <Label htmlFor="edit-offsite" className="text-sm font-normal cursor-pointer">Allow off-site work</Label>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Mileage Rate ($/mi)</Label>
                    <Input type="number" step="0.01" value={editUserMileageRate} onChange={e => setEditUserMileageRate(e.target.value)} placeholder="0.50" />
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-special" checked={editUserAllowSpecialTerms} onCheckedChange={c => setEditUserAllowSpecialTerms(c === true)} />
                    <Label htmlFor="edit-special" className="text-sm font-normal cursor-pointer">Allow special terms</Label>
                  </div>
                  {editUserAllowSpecialTerms && (
                    <div className="space-y-1">
                      <Label className="text-xs">Special Terms Amount ($)</Label>
                      <Input type="number" step="0.01" value={editUserSpecialTermsAmount} onChange={e => setEditUserSpecialTermsAmount(e.target.value)} placeholder="0.00" />
                    </div>
                  )}
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-docs" checked={editUserDocsComplete} onCheckedChange={c => setEditUserDocsComplete(c === true)} />
                    <Label htmlFor="edit-docs" className="text-sm font-normal cursor-pointer">W-9 / Documents complete</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-financial-confirm" checked={editUserRequireFinancialConfirm} onCheckedChange={c => setEditUserRequireFinancialConfirm(c === true)} />
                    <Label htmlFor="edit-financial-confirm" className="text-sm font-normal cursor-pointer">Require financial review on time reports</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-past-dates" checked={editUserAllowPastDates} onCheckedChange={c => setEditUserAllowPastDates(c === true)} />
                    <Label htmlFor="edit-past-dates" className="text-sm font-normal cursor-pointer">Allow past date reporting (beyond 1 day)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-work-credits" checked={editUserAllowWorkCredits} onCheckedChange={c => setEditUserAllowWorkCredits(c === true)} />
                    <Label htmlFor="edit-work-credits" className="text-sm font-normal cursor-pointer">Allow Work Credits</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-contractor-docs" checked={editUserAllowContractorDocs} onCheckedChange={c => setEditUserAllowContractorDocs(c === true)} />
                    <Label htmlFor="edit-contractor-docs" className="text-sm font-normal cursor-pointer">Allow Contractor Documents</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-create-contractors" checked={editUserAllowCreatingContractors} onCheckedChange={c => setEditUserAllowCreatingContractors(c === true)} />
                    <Label htmlFor="edit-create-contractors" className="text-sm font-normal cursor-pointer">Allow Creating Contractors</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-allow-miles" checked={editUserAllowMiles} onCheckedChange={c => setEditUserAllowMiles(c === true)} />
                    <Label htmlFor="edit-allow-miles" className="text-sm font-normal cursor-pointer">Allow Miles (user can log miles on work reports)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-daily-reminder" checked={editUserDailyReminderEnabled} onCheckedChange={c => setEditUserDailyReminderEnabled(c === true)} />
                    <Label htmlFor="edit-daily-reminder" className="text-sm font-normal cursor-pointer">Daily 7pm reminder (Mon–Sat, Florida time)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-allow-flat-rate" checked={editUserAllowFlatRate} onCheckedChange={c => setEditUserAllowFlatRate(c === true)} />
                    <Label htmlFor="edit-allow-flat-rate" className="text-sm font-normal cursor-pointer">Allow Flat Rate Assignment</Label>
                  </div>
                  {(editingUser?.role === "admin" || editingUser?.role === "super_admin") && (
                    <div className="space-y-2 border rounded-md p-3 bg-muted/20">
                      <p className="text-xs font-medium text-muted-foreground">Dashboard Buttons (admins only)</p>
                      <div className="flex items-center space-x-2">
                        <Checkbox id="edit-show-work-report" checked={editUserShowWorkReport} onCheckedChange={c => setEditUserShowWorkReport(c === true)} />
                        <Label htmlFor="edit-show-work-report" className="text-sm font-normal cursor-pointer">Show Work Report</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox id="edit-show-my-docs" checked={editUserShowMyDocuments} onCheckedChange={c => setEditUserShowMyDocuments(c === true)} />
                        <Label htmlFor="edit-show-my-docs" className="text-sm font-normal cursor-pointer">Show My Documents</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox id="edit-show-work-credit" checked={editUserShowWorkCredit} onCheckedChange={c => setEditUserShowWorkCredit(c === true)} />
                        <Label htmlFor="edit-show-work-credit" className="text-sm font-normal cursor-pointer">Show Work Credit</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox id="edit-show-my-contractors" checked={editUserShowMyContractors} onCheckedChange={c => setEditUserShowMyContractors(c === true)} />
                        <Label htmlFor="edit-show-my-contractors" className="text-sm font-normal cursor-pointer">Show My Contractors</Label>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center space-x-2">
                    <Checkbox id="edit-doc-reminder" checked={editUserDocReminderEnabled} onCheckedChange={c => setEditUserDocReminderEnabled(c === true)} />
                    <Label htmlFor="edit-doc-reminder" className="text-sm font-normal cursor-pointer">Send document upload reminders</Label>
                  </div>
                  {editUserDocReminderEnabled && (
                    <div className="space-y-1 ml-6">
                      <Label className="text-xs">Reminder frequency (days)</Label>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="icon" className="h-8 w-8"
                          onClick={() => setEditUserDocReminderDays(Math.max(1, editUserDocReminderDays - 1))}>
                          <span className="text-lg">&minus;</span>
                        </Button>
                        <span className="text-sm font-medium w-8 text-center">{editUserDocReminderDays}</span>
                        <Button type="button" variant="outline" size="icon" className="h-8 w-8"
                          onClick={() => setEditUserDocReminderDays(Math.min(30, editUserDocReminderDays + 1))}>
                          <span className="text-lg">+</span>
                        </Button>
                        <span className="text-xs text-muted-foreground">days between reminders</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <Button variant="outline" className="flex-1" onClick={() => setEditingUser(null)}>Cancel</Button>
              <Button className="flex-1" disabled={editUserSaving} onClick={async () => {
                setEditUserSaving(true);
                try {
                  await apiRequest("PUT", `/api/users/${editingUser.id}`, {
                    displayName: editUserName,
                    email: editUserEmail || undefined,
                    password: editUserPassword || undefined,
                    role: editUserRole,
                    dailyTimeReport: editUserDailyTimeReport,
                    dailyTransactionReport: editUserDailyTxReport,
                    reconciliationReport: editUserReconReport,
                    firstName: editUserFirstName || undefined,
                    lastName: editUserLastName || undefined,
                    baseRate: editUserBaseRate || undefined,
                    offSiteRate: editUserOffSiteRate || undefined,
                    positions: editUserPositions.filter(p => p.name.trim() && p.rate.trim()),
                    homeProperty: editUserHomeProperty || undefined,
                    allowOffSite: editUserAllowOffSite,
                    mileageRate: editUserMileageRate || undefined,
                    allowSpecialTerms: editUserAllowSpecialTerms,
                    specialTermsAmount: editUserSpecialTermsAmount || undefined,
                    w9OrW4: "w9",
                    docsComplete: editUserDocsComplete,
                    requireFinancialConfirm: editUserRequireFinancialConfirm,
                    allowPastDates: editUserAllowPastDates,
                    receiveTransactionEmails: editUserReceiveTransactionEmails,
                    allowWorkCredits: editUserAllowWorkCredits,
                    workCreditReport: editUserWorkCreditReport,
                    documentUploadReport: editUserDocumentUploadReport,
                    docReminderEnabled: editUserDocReminderEnabled,
                    docReminderDays: editUserDocReminderDays,
                    allowContractorDocs: editUserAllowContractorDocs,
                    allowCreatingContractors: editUserAllowCreatingContractors,
                    allowMiles: editUserAllowMiles,
                    dailyReminderEnabled: editUserDailyReminderEnabled,
                    allowFlatRate: editUserAllowFlatRate,
                    showWorkReport: editUserShowWorkReport,
                    showMyDocuments: editUserShowMyDocuments,
                    showWorkCredit: editUserShowWorkCredit,
                    showMyContractors: editUserShowMyContractors,
                  });
                  queryClient.invalidateQueries({ queryKey: ["/api/users"] });
                  setEditingUser(null);
                  toast({ title: "User updated" });
                } catch { toast({ title: "Failed to update", variant: "destructive" }); }
                finally { setEditUserSaving(false); }
              }}>
                {editUserSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Save Changes
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* ---- EDIT PROPERTIES DIALOG ---- */}
        <Dialog open={editPropsUserId !== null} onOpenChange={(open) => { if (!open) setEditPropsUserId(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign Properties</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {propertiesList?.map(prop => (
                <div key={prop.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`prop-${prop.id}`}
                    checked={editPropsSelected.includes(prop.id)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setEditPropsSelected(prev => [...prev, prop.id]);
                      } else {
                        setEditPropsSelected(prev => prev.filter(id => id !== prop.id));
                      }
                    }}
                  />
                  <Label htmlFor={`prop-${prop.id}`} className="text-sm font-normal cursor-pointer">
                    {prop.name}
                  </Label>
                </div>
              ))}
            </div>
            <Button
              className="w-full"
              onClick={() => saveUserPropsMutation.mutate()}
              disabled={saveUserPropsMutation.isPending}
            >
              {saveUserPropsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save
            </Button>
          </DialogContent>
        </Dialog>
      </div>
      </div>
    </LogoBackground>
  );
}

// ==== Property Manager Playbook admin section ====
// Shows the currently-active playbook (size, last-updated date) and lets an admin
// upload a replacement. Each upload is also archived as a versioned snapshot on
// the server so old welcome-email attachments are never broken.
function PlaybookAdminSection() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const { data: info } = useQuery<any>({
    queryKey: ["/api/playbook/info"],
  });
  const { data: versions } = useQuery<any>({
    queryKey: ["/api/admin/playbook/versions"],
  });

  const onPick = () => fileInputRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf") && f.type !== "application/pdf") {
      toast({ title: "Wrong file type", description: "Please choose a PDF file.", variant: "destructive" });
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum size is 10 MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("playbook", f);
      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/api/admin/playbook`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/info"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/playbook/versions"] });
      toast({
        title: "Playbook updated",
        description: "All property managers will see the new version next time they open the dashboard. New PMs will receive this version in their welcome email.",
      });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const previewUrl = info ? `${API_BASE}/api/playbook/file?token=${getAuthToken()}` : null;
  const downloadUrl = info ? `${API_BASE}/api/playbook/file?download=1&token=${getAuthToken()}` : null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-amber-600" />
          Property Manager Playbook
        </h2>
      </div>
      <Card>
        <CardContent className="py-4 space-y-3">
          {info ? (
            <>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{info.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {info.sizeMB} MB · Updated {new Date(info.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 h-9 rounded-md border text-sm font-medium hover:bg-accent"
                  >
                    <FileText className="w-4 h-4" />
                    Preview
                  </a>
                )}
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    className="flex items-center justify-center gap-1.5 h-9 rounded-md border text-sm font-medium hover:bg-accent"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </a>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No playbook uploaded yet. Upload a PDF to make it available to property managers from their dashboard and to attach to future welcome emails.
            </p>
          )}
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={onPick}
            disabled={uploading}
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {info ? "Replace with new version" : "Upload Playbook PDF"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={onFile}
          />
          {versions?.versions?.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                {versions.versions.length} previous version{versions.versions.length === 1 ? "" : "s"} archived on the server
              </summary>
              <ul className="mt-2 space-y-1 ml-4">
                {versions.versions.slice(0, 5).map((v: any) => (
                  <li key={v.filename}>
                    {new Date(v.savedAt).toLocaleString()} · {(v.sizeBytes / 1024 / 1024).toFixed(2)} MB
                  </li>
                ))}
                {versions.versions.length > 5 && <li>… and {versions.versions.length - 5} older</li>}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ==== PropertyAdminCard ===================================================
// Single property row in the admin Properties section. Shows the property name
// and Sheets-tab status by default; expand to edit the short code (used as the
// prefix on receipt IDs, e.g. "TE") and the Marketing URL the dashboard
// Marketing button opens for property managers.
function PropertyAdminCard({
  prop,
  onDelete,
  deletePending,
}: {
  prop: any;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState<string>(prop.code || "");
  const [marketingUrl, setMarketingUrl] = useState<string>(prop.marketingUrl || "");
  const [masterSheetUrl, setMasterSheetUrl] = useState<string>(prop.masterSheetUrl || "");

  const saveMutation = useMutation({
    mutationFn: async (body: {
      code?: string | null;
      marketingUrl?: string | null;
      masterSheetUrl?: string | null;
    }) => {
      const res = await apiRequest("PUT", `/api/properties/${prop.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties"] });
      toast({ title: "Saved", description: `${prop.name} updated.` });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      code: code.trim() === "" ? null : code.trim().toUpperCase(),
      marketingUrl: marketingUrl.trim() === "" ? null : marketingUrl.trim(),
      masterSheetUrl: masterSheetUrl.trim() === "" ? null : masterSheetUrl.trim(),
    });
  };

  return (
    <Card data-testid={`card-property-${prop.id}`}>
      <CardContent className="py-3 space-y-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex items-center gap-3 flex-1 text-left min-w-0"
            onClick={() => setExpanded(e => !e)}
          >
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Building2 className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium">{prop.name}</p>
                {prop.code && (
                  <Badge variant="outline" className="text-[10px] py-0 h-4 font-mono">
                    {prop.code}
                  </Badge>
                )}
                {prop.marketingUrl && (
                  <Badge variant="outline" className="text-[10px] py-0 h-4 border-orange-500/60 text-orange-700 dark:text-orange-400">
                    Marketing link set
                  </Badge>
                )}
                {prop.masterSheetUrl && (
                  <Badge variant="outline" className="text-[10px] py-0 h-4 border-blue-500/60 text-blue-700 dark:text-blue-400">
                    Master Sheet link set
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {prop.sheetsTabId ? "Sheets tab linked" : "No Sheets tab"}
              </p>
            </div>
            <ChevronRight
              className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive flex-shrink-0"
            onClick={onDelete}
            disabled={deletePending}
            data-testid={`button-delete-property-${prop.id}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>

        {expanded && (
          <div className="space-y-3 pl-11 pr-1">
            <div className="space-y-1">
              <Label className="text-xs">Short code (receipt prefix)</Label>
              <Input
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                placeholder="e.g. TE"
                className="h-8 text-sm font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                1–6 letters/digits. Used as the prefix on receipt identifiers (e.g. <code>TE-7</code>). Leave blank to use numeric IDs only.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Marketing URL</Label>
              <Input
                value={marketingUrl}
                onChange={e => setMarketingUrl(e.target.value)}
                placeholder="https://example.com/listing"
                className="h-8 text-sm"
                type="url"
              />
              <p className="text-[11px] text-muted-foreground">
                Where the dashboard Marketing button takes property managers. Must start with <code>http://</code> or <code>https://</code>. Leave blank to hide.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">PM Master Sheet URL</Label>
              <Input
                value={masterSheetUrl}
                onChange={e => setMasterSheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="h-8 text-sm"
                type="url"
              />
              <p className="text-[11px] text-muted-foreground">
                Where the dashboard <strong>Master Sheet</strong> button takes property managers. Must start with <code>http://</code> or <code>https://</code>. Leave blank to hide.
              </p>
            </div>
            <Button
              size="sm"
              className="w-full gap-2"
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// SyncStatusPanel — a small compliance dashboard so admins can spot rows in
// the local DB that haven't reached Google Sheets. The API is read-only; the
// "Fix All" button below calls the existing /api/admin/resync-sheets endpoint
// which rebuilds every property tab from the DB. Auto-refetches every 60s so
// stray drift is visible without a page reload.
function SyncStatusPanel() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["/api/admin/sync-status"],
    refetchInterval: 60_000,
  });

  const fixAll = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/resync-sheets", {});
      return res.json();
    },
    onSuccess: (r: any) => {
      toast({ title: "Sync repair complete", description: `Rebuilt ${(r.summary || []).length} property tabs across CC/Cash/Check sheets.` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sync-status"] });
      refetch();
    },
    onError: (e: any) => toast({ title: "Fix All failed", description: e.message || "Error", variant: "destructive" }),
  });

  const total = data?.totalUnsynced ?? 0;
  const clean = !isLoading && total === 0;

  return (
    <section className="space-y-3 border rounded-lg p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold flex items-center gap-2">
          {clean ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <AlertTriangle className={`w-4 h-4 ${total > 0 ? "text-amber-600" : "text-muted-foreground"}`} />
          )}
          Sheet Sync Status
        </h2>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground">Checking sheets…</p>
      )}

      {!isLoading && clean && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          Every row in the DB is mirrored to Google Sheets. Nothing missed.
        </p>
      )}

      {!isLoading && total > 0 && data && (
        <>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <strong>{total}</strong> row{total === 1 ? "" : "s"} in the DB haven't reached Google Sheets. Click <strong>Fix All</strong> to rebuild every property tab from the local DB.
          </p>
          <div className="text-[11px] grid grid-cols-2 gap-x-3 gap-y-1">
            {Object.entries(data.perProperty as Record<string, any>)
              .filter(([, v]: any) => v.invoicesUnsynced + v.cashUnsynced + v.checksUnsynced > 0)
              .map(([name, v]: any) => (
                <div key={name} className="flex items-center justify-between gap-2 rounded px-2 py-1 bg-amber-50 dark:bg-amber-950/20">
                  <span className="font-medium">{name}</span>
                  <span className="text-amber-700 dark:text-amber-400">
                    {v.invoicesUnsynced > 0 && `${v.invoicesUnsynced} CC `}
                    {v.cashUnsynced > 0 && `${v.cashUnsynced} Cash `}
                    {v.checksUnsynced > 0 && `${v.checksUnsynced} Check`}
                  </span>
                </div>
              ))}
          </div>
          <Button
            size="sm"
            className="w-full gap-2"
            onClick={() => fixAll.mutate()}
            disabled={fixAll.isPending}
          >
            {fixAll.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Fix All ({total} missed)
          </Button>
        </>
      )}

      {!isLoading && data && (data.missedSamples || []).length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(x => !x)}
          className="w-full text-left text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
          {expanded ? "Hide" : "Show"} up to {data.missedSamples.length} missed row{data.missedSamples.length === 1 ? "" : "s"}
        </button>
      )}

      {expanded && data && (
        <div className="text-[11px] space-y-1 max-h-40 overflow-auto border rounded p-2">
          {data.missedSamples.map((m: any, i: number) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <span>
                <span className="inline-block px-1 rounded bg-muted text-[10px] uppercase mr-1">{m.kind}</span>
                {m.property} · #{m.recordNumber ?? m.id} · {m.date}
              </span>
              <span className="text-muted-foreground">${m.amount}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
