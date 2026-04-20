import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { apiRequest, queryClient, setAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2, UserCircle, Shield, Loader2, Building2, Settings, Pencil, LogIn, Clock } from "lucide-react";
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
  const { data: users, isLoading: usersLoading } = useQuery<UserItem[]>({
    queryKey: ["/api/users"],
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
      return apiRequest("DELETE", `/api/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User removed" });
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

        {/* ---- SYNC BUTTON ---- */}
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          data-testid="button-resync"
          onClick={async () => {
            try {
              const res = await apiRequest("POST", "/api/admin/resync");
              const data = await res.json();
              toast({ title: "Sync complete", description: `${data.sheetsSync} rows synced to Sheets, ${data.driveSync} photos synced to Drive (${data.total} total receipts).` });
            } catch (e: any) {
              toast({ title: "Sync failed", description: e.message || "Check Google API configuration.", variant: "destructive" });
            }
          }}
        >
          Re-sync All Receipts to Google
        </Button>

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
        <Button
          variant="outline"
          className="w-full"
          onClick={async () => {
            try {
              toast({ title: "Syncing time reports to Google Sheet..." });
              await apiRequest("POST", "/api/admin/sync-time-reports-sheet");
              toast({ title: "Time reports spreadsheet updated", description: "Check Time Reporting folder on Google Drive" });
            } catch (e: any) {
              toast({ title: "Sync failed", description: e.message, variant: "destructive" });
            }
          }}
        >
          Sync All Time Reports to Sheet
        </Button>

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
                  <div className="text-muted-foreground">Rate</div>
                  <div className="text-right font-medium">${wfResult.summary.baseRate}/hr</div>
                  <div className="text-muted-foreground">Labor ({wfResult.summary.totalHours}h × ${wfResult.summary.baseRate})</div>
                  <div className="text-right font-semibold">${wfResult.summary.laborCost?.toFixed(2)}</div>
                  <div className="text-muted-foreground">Mileage ({wfResult.summary.totalMiles} mi)</div>
                  <div className="text-right">${wfResult.summary.totalMileagePay?.toFixed(2)}</div>
                  <div className="text-muted-foreground">Special Terms / Travel</div>
                  <div className="text-right">${wfResult.summary.totalSpecialTerms?.toFixed(2)}</div>
                </div>
                <div className="border-t border-blue-200 dark:border-blue-800 mt-2 pt-2 flex justify-between items-center">
                  <span className="font-bold text-sm">Total Pay</span>
                  <span className="font-bold text-lg text-blue-700 dark:text-blue-300">${wfResult.summary.grandTotal?.toFixed(2)}</span>
                </div>
              </div>

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
                <Card key={prop.id} data-testid={`card-property-${prop.id}`}>
                  <CardContent className="py-3 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Building2 className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{prop.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {prop.sheetsTabId ? "Sheets tab linked" : "No Sheets tab"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive flex-shrink-0"
                      onClick={() => deletePropMutation.mutate(prop.id)}
                      disabled={deletePropMutation.isPending}
                      data-testid={`button-delete-property-${prop.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
              {propertiesList?.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No properties yet.</p>
              )}
            </div>
          )}
        </section>

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
                <Card key={u.id} data-testid={`card-user-${u.id}`}>
                  <CardContent className="py-3 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      {(u.role === "admin" || u.role === "super_admin") ? (
                        <Shield className="w-5 h-5 text-primary" />
                      ) : (
                        <UserCircle className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{u.displayName}</p>
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
                        {u.id !== user?.id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => deleteUserMutation.mutate(u.id)}
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
