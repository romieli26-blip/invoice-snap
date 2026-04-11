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
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2, UserCircle, Shield, Loader2, Building2, Settings } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

interface UserItem {
  id: number;
  username: string;
  displayName: string;
  role: string;
  email?: string;
  dailyReport?: number;
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
  const [newDailyReport, setNewDailyReport] = useState(false);

  const [newUserPropertyIds, setNewUserPropertyIds] = useState<number[]>([]);

  // Edit properties assignment state
  const [editPropsUserId, setEditPropsUserId] = useState<number | null>(null);
  const [editPropsSelected, setEditPropsSelected] = useState<number[]>([]);

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
        dailyReport: newDailyReport,
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
      setNewDailyReport(false);
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

  if (user?.role !== "admin") {
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
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-email">Email (optional)</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newEmail}
                      onChange={e => setNewEmail(e.target.value)}
                      placeholder="user@example.com"
                    />
                  </div>
                  {newRole === "admin" && newEmail && (
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="daily-report"
                        checked={newDailyReport}
                        onCheckedChange={(checked) => setNewDailyReport(checked === true)}
                      />
                      <Label htmlFor="daily-report" className="text-sm font-normal cursor-pointer">
                        Subscribe to daily reports
                      </Label>
                    </div>
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
                      {u.role === "admin" ? (
                        <Shield className="w-5 h-5 text-primary" />
                      ) : (
                        <UserCircle className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{u.displayName}</p>
                      <p className="text-xs text-muted-foreground">@{u.username} · {u.role === "admin" ? "Admin" : "Manager"}</p>
                      {u.email && (
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                      )}
                      {u.dailyReport === 1 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-green-600 border-green-300">Daily Reports</Badge>
                      )}
                      {u.role === "manager" && u.assignedProperties && u.assignedProperties.length > 0 && (
                        <p className="text-xs text-primary/70 truncate">
                          {u.assignedProperties.join(", ")}
                        </p>
                      )}
                    </div>
                    {u.id !== user?.id && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {u.role !== "admin" && (
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
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

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
