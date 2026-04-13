import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Camera, FileText, LogOut, Users, Download, CreditCard, Banknote, Building2, X, Trash2, Pencil, Loader2, ChevronLeft, ChevronRight, DollarSign, Clock } from "lucide-react";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Invoice } from "@shared/schema";
import { LogoBackground, LogoHeader } from "@/components/LogoBackground";

interface EnrichedInvoice extends Invoice {
  submittedBy: string;
}

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function authImgUrl(photoPath: string) {
  const token = getAuthToken();
  return `${API_BASE}${photoPath}${token ? `?token=${token}` : ""}`;
}

export default function HistoryPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [viewingPhotos, setViewingPhotos] = useState<string[] | null>(null);
  const [viewPhotoIdx, setViewPhotoIdx] = useState(0);
  const [photoZoom, setPhotoZoom] = useState(1);
  const [editingInvoice, setEditingInvoice] = useState<EnrichedInvoice | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editPurpose, setEditPurpose] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editBoughtBy, setEditBoughtBy] = useState("");
  const [editPaymentMethod, setEditPaymentMethod] = useState<"cash" | "cc">("cc");
  const [editLastFour, setEditLastFour] = useState("");
  const [editRmIssue, setEditRmIssue] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const { data: invoices, isLoading } = useQuery<EnrichedInvoice[]>({
    queryKey: ["/api/invoices"],
  });

  const { data: cashBalances } = useQuery<Record<string, number>>({
    queryKey: ["/api/cash-balances"],
  });

  const { data: cashTxs } = useQuery<any[]>({
    queryKey: ["/api/cash-transactions"],
  });

  const { data: timeReports } = useQuery<any[]>({
    queryKey: ["/api/time-reports"],
  });

  const { data: workCredits } = useQuery<any[]>({
    queryKey: ["/api/work-credits"],
  });

  // Cash transaction edit state
  const [editingCashTx, setEditingCashTx] = useState<any | null>(null);
  const [editCashAmount, setEditCashAmount] = useState("");
  const [editCashCategory, setEditCashCategory] = useState("");
  const [editCashDescription, setEditCashDescription] = useState("");
  const [editCashUnitLot, setEditCashUnitLot] = useState("");
  const [editCashTenantName, setEditCashTenantName] = useState("");
  const [editCashBankName, setEditCashBankName] = useState("");
  const [editCashSaving, setEditCashSaving] = useState(false);

  async function handleCashDelete(id: number) {
    if (!window.confirm("Delete this cash transaction?")) return;
    try {
      await apiRequest("DELETE", `/api/cash-transactions/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/cash-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cash-balances"] });
      toast({ title: "Transaction deleted" });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  async function handleCashExport() {
    try {
      const res = await apiRequest("GET", "/api/cash-transactions/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cash-transactions.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  }

  async function handleExport() {
    try {
      const res = await apiRequest("GET", "/api/invoices/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "receipts.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  const deleteInvoiceMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/invoices/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
  });

  return (
    <LogoBackground>
      <div className="bg-background">
      {/* Header */}
      <div className="border-b bg-card px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold" data-testid="text-history-title">Jetsetter Reporting</h1>
            <p className="text-xs text-muted-foreground">
              {user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : user?.displayName}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <LogoHeader />
            {(user?.role === "admin" || user?.role === "super_admin") && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/admin")}
                data-testid="button-admin"
              >
                <Users className="w-5 h-5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Action Buttons */}
        {user?.role !== "contractor" && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              className="h-20 text-sm gap-1.5 flex-col leading-tight"
              onClick={() => setLocation("/capture")}
              data-testid="button-new-invoice"
            >
              <Camera className="w-6 h-6" />
              <span className="text-center">New Credit Card<br/>Receipt</span>
            </Button>
            <Button
              className="h-20 text-sm gap-1.5 flex-col leading-tight bg-orange-100 hover:bg-orange-200 text-orange-800 border border-orange-300"
              variant="outline"
              onClick={() => setLocation("/cash")}
              data-testid="button-cash-transaction"
            >
              <Camera className="w-6 h-6" />
              <span className="text-center">New Cash<br/>Transaction</span>
            </Button>
          </div>
        )}

        {(user?.role === "admin" || user?.role === "super_admin") && (
          <Button
            className="w-full h-12 bg-yellow-400 hover:bg-yellow-500 text-black gap-2"
            onClick={() => setLocation("/reconcile")}
          >
            <FileText className="w-5 h-5" />
            CC Statement Reconciliation
          </Button>
        )}

        {user?.role === "contractor" && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              className="h-16 text-sm gap-1.5 flex-col leading-tight bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => setLocation("/time-report")}
            >
              <Clock className="w-5 h-5" />
              Work Report
            </Button>
            <Button
              className={`h-16 text-sm gap-1.5 flex-col leading-tight ${(user as any)?.docsComplete ? "bg-green-100 hover:bg-green-200 text-green-800 border-green-300" : "bg-orange-100 hover:bg-orange-200 text-orange-800 border-orange-300"}`}
              variant="outline"
              onClick={() => setLocation("/documents")}
            >
              <FileText className="w-5 h-5" />
              My Documents
              {(user as any)?.docsComplete ? <span className="text-[10px]">Complete</span> : <span className="text-[10px]">Action needed</span>}
            </Button>
          </div>
        )}

        {user?.role === "contractor" && ((user as any)?.allowWorkCredits || false) && (
          <Button
            className="w-full h-12 text-sm gap-1.5 bg-purple-600 hover:bg-purple-700 text-white"
            onClick={() => setLocation("/work-credit")}
          >
            <CreditCard className="w-4 h-4" />
            Work Credit
          </Button>
        )}

        {user?.role !== "contractor" && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              className="h-12 text-sm gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => setLocation("/time-report")}
            >
              <Clock className="w-4 h-4" />
              Work Report
            </Button>
            <Button
              className={`h-12 text-sm gap-1.5 ${(user as any)?.docsComplete ? "bg-green-100 hover:bg-green-200 text-green-800 border-green-300" : ""}`}
              variant="outline"
              onClick={() => setLocation("/documents")}
            >
              <FileText className="w-4 h-4" />
              My Documents
            </Button>
          </div>
        )}

        {user?.role !== "contractor" && ((user as any)?.allowWorkCredits || user?.role === "admin" || user?.role === "super_admin") && (
          <Button
            className="w-full h-12 text-sm gap-1.5 bg-purple-600 hover:bg-purple-700 text-white"
            onClick={() => setLocation("/work-credit")}
          >
            <CreditCard className="w-4 h-4" />
            Work Credit
          </Button>
        )}

        {/* Cash Balances */}
        {user?.role !== "contractor" && cashBalances && Object.keys(cashBalances).length > 0 && (
          <div className="border rounded-lg p-3 space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">Cash on Hand</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(cashBalances).map(([prop, balance]) => (
                <div key={prop} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground truncate mr-2">{prop}</span>
                  <span className={`font-medium tabular-nums ${balance < 0 ? "text-destructive" : "text-primary"}`}>
                    ${balance.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {user?.role !== "contractor" && (<>
        {/* Section header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Recent Receipts</h2>
          {(user?.role === "admin" || user?.role === "super_admin") && invoices && invoices.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleExport} className="text-xs gap-1" data-testid="button-export">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </Button>
          )}
        </div>

        {/* Invoice list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <Card key={i}>
                <CardContent className="py-3 flex gap-3">
                  <Skeleton className="w-12 h-12 rounded-lg flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : invoices && invoices.length > 0 ? (
          <div className="space-y-2">
            {invoices.map(inv => (
              <Card key={inv.id} data-testid={`card-invoice-${inv.id}`}>
                <CardContent className="py-3 flex gap-3">
                  <div
                    className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer relative"
                    onClick={() => setViewingPhotos((inv as any).photoPaths || [inv.photoPath])}
                  >
                    <img src={authImgUrl(((inv as any).photoPaths || [inv.photoPath])[0])} alt="Receipt" className="w-full h-full object-cover" />
                    {(inv as any).photoPaths?.length > 1 && (
                      <span className="absolute bottom-0 right-0 bg-black/60 text-white text-[8px] px-1 rounded-tl">{(inv as any).photoPaths.length}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium truncate">{inv.description}</p>
                      <div className="flex items-center gap-1">
                        <span className="text-sm font-semibold whitespace-nowrap">${inv.amount}</span>
                        <button
                          className="text-muted-foreground hover:text-primary p-0.5"
                          onClick={() => {
                            if (window.confirm("You are about to edit this item. Are you sure?")) {
                              setEditDescription(inv.description);
                              setEditPurpose(inv.purpose);
                              setEditAmount(inv.amount);
                              setEditBoughtBy(inv.boughtBy);
                              setEditPaymentMethod(inv.paymentMethod as "cash" | "cc");
                              setEditLastFour(inv.lastFourDigits || "");
                              setEditRmIssue((inv as any).rentManagerIssue || "");
                              setEditingInvoice(inv);
                            }
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          className="text-muted-foreground hover:text-destructive p-0.5"
                          onClick={() => {
                            if (window.confirm("Delete this receipt?")) {
                              deleteInvoiceMutation.mutate(inv.id);
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{inv.purpose}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {inv.recordNumber && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                          #{inv.recordNumber}
                        </Badge>
                      )}
                      {inv.property && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                          <Building2 className="w-2.5 h-2.5" />
                          {inv.property}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{inv.purchaseDate}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                        {inv.paymentMethod === "cc" ? (
                          <>
                            <CreditCard className="w-2.5 h-2.5" />
                            {inv.lastFourDigits ? `••${inv.lastFourDigits}` : "Card"}
                          </>
                        ) : (
                          <>
                            <Banknote className="w-2.5 h-2.5" />
                            Cash
                          </>
                        )}
                      </Badge>
                      {inv.rentManagerIssue && (
                        <span className="text-xs text-muted-foreground">RM #{inv.rentManagerIssue}</span>
                      )}
                      {inv.boughtBy !== inv.submittedBy && (
                        <span className="text-xs text-muted-foreground">buyer: {inv.boughtBy}</span>
                      )}
                      {(user?.role === "admin" || user?.role === "super_admin") && (
                        <span className="text-xs text-muted-foreground">
                          {inv.boughtBy !== inv.submittedBy ? `· ${inv.submittedBy}` : `by ${inv.submittedBy}`}
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-3">
              <FileText className="w-7 h-7 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No receipts yet</p>
            <p className="text-xs text-muted-foreground mt-1">Tap "New Receipt" to submit your first one.</p>
          </div>
        )}

        {/* ---- CASH TRANSACTIONS SECTION ---- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Cash Transactions</h2>
            {(user?.role === "admin" || user?.role === "super_admin") && cashTxs && cashTxs.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleCashExport} className="text-xs gap-1">
                <Download className="w-3.5 h-3.5" /> Export CSV
              </Button>
            )}
          </div>
          {cashTxs && cashTxs.length > 0 ? (
            <div className="space-y-2">
              {cashTxs.map((tx: any) => (
                <Card key={tx.id}>
                  <CardContent className="py-3 flex gap-3">
                    {/* Photo thumbnail */}
                    {tx.photoPath && (
                      <div
                        className="w-12 h-12 rounded-lg bg-muted flex-shrink-0 overflow-hidden cursor-pointer"
                        onClick={() => setViewingPhotos(tx.photoPaths || [tx.photoPath])}
                      >
                        <img src={authImgUrl((tx.photoPaths || [tx.photoPath])[0])} alt="" className="w-full h-full object-cover" />
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-2 flex-1">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${tx.type === "income" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                            {tx.type === "income" ? "Income" : "Spent"}
                          </span>
                          <span className="text-xs text-muted-foreground">{(tx.category || "").replace(/_/g, " ")}</span>
                        </div>
                        <p className="text-sm font-medium mt-1">${tx.amount}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                            <Building2 className="w-2.5 h-2.5" />
                            {tx.property}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{tx.date}</span>
                          {tx.description && <span className="text-xs text-muted-foreground truncate max-w-[120px]">{tx.description}</span>}
                          {tx.recordNumber && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                              #{tx.recordNumber}
                            </Badge>
                          )}
                          {(user?.role === "admin" || user?.role === "super_admin") && tx.submittedBy && (
                            <span className="text-xs text-muted-foreground">by {tx.submittedBy}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button className="text-muted-foreground hover:text-primary p-0.5" onClick={() => {
                          if (window.confirm("You are about to edit this item. Are you sure?")) {
                            setEditingCashTx(tx);
                            setEditCashAmount(tx.amount);
                            setEditCashCategory(tx.category);
                            setEditCashDescription(tx.description || "");
                            setEditCashUnitLot(tx.unitLotNumber || "");
                            setEditCashTenantName(tx.tenantName || "");
                            setEditCashBankName(tx.bankName || "");
                          }
                        }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button className="text-muted-foreground hover:text-destructive p-0.5" onClick={() => handleCashDelete(tx.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No cash transactions yet.</p>
          )}
        </div>
        </>)}

        {/* ---- TIME REPORTS SECTION ---- */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Work Reports</h2>
          {timeReports && timeReports.length > 0 ? (
            <div className="space-y-2">
              {timeReports.map((tr: any) => (
                <Card key={tr.id}>
                  <CardContent className="py-3 flex gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <Clock className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{tr.property} — {tr.date}</p>
                          <p className="text-xs text-muted-foreground">
                            {(() => {
                              try {
                                const blocks = tr.timeBlocks ? JSON.parse(tr.timeBlocks) : [];
                                if (blocks.length > 1) return blocks.map((b: any) => `${b.start}–${b.end}`).join(", ");
                              } catch {}
                              return `${tr.startTime} – ${tr.endTime}`;
                            })()}
                          </p>
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button
                            className="text-muted-foreground hover:text-blue-600 p-0.5"
                            title="Download report"
                            onClick={() => {
                              // Build a text summary for download
                              let blocks: any[] = [];
                              try { blocks = tr.timeBlocks ? JSON.parse(tr.timeBlocks) : []; } catch {}
                              const timeStr = blocks.length > 0
                                ? blocks.map((b: any) => `${b.start} - ${b.end}`).join(", ")
                                : `${tr.startTime} - ${tr.endTime}`;
                              let accs: string[] = [];
                              try { accs = JSON.parse(tr.accomplishments); } catch {}
                              const lines = [
                                `Work Report - ${tr.date}`,
                                `Employee: ${tr.submittedBy || user?.displayName || "N/A"}`,
                                `Property: ${tr.property}`,
                                `Time: ${timeStr}`,
                                ``,
                                `Accomplishments:`,
                                ...accs.map(a => `  - ${a}`),
                              ];
                              if (tr.miles && parseFloat(tr.miles) > 0) lines.push(`Miles: ${tr.miles} ($${tr.mileageAmount})`);
                              if (tr.specialTerms === 1 && tr.specialTermsAmount) lines.push(`Special Terms: $${tr.specialTermsAmount}`);
                              if (tr.notes) lines.push(`Notes: ${tr.notes}`);
                              const blob = new Blob([lines.join("\n")], { type: "text/plain" });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = `Work_Report_${tr.date}_${tr.property.replace(/\s/g, "_")}.txt`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            className="text-muted-foreground hover:text-destructive p-0.5"
                            onClick={async () => {
                              if (!window.confirm("Delete this work report?")) return;
                              try {
                                await apiRequest("DELETE", `/api/time-reports/${tr.id}`);
                                queryClient.invalidateQueries({ queryKey: ["/api/time-reports"] });
                                toast({ title: "Report deleted" });
                              } catch {
                                toast({ title: "Failed to delete", variant: "destructive" });
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1">
                        {(() => {
                          try {
                            const items = JSON.parse(tr.accomplishments);
                            return items.map((item: string, i: number) => (
                              <p key={i} className="text-xs text-muted-foreground">• {item}</p>
                            ));
                          } catch { return <p className="text-xs text-muted-foreground">{tr.accomplishments}</p>; }
                        })()}
                      </div>
                      {tr.miles && parseFloat(tr.miles) > 0 && (
                        <p className="text-xs text-blue-600 mt-1">{tr.miles} mi — ${tr.mileageAmount}</p>
                      )}
                      {tr.specialTerms === 1 && tr.specialTermsAmount && (
                        <p className="text-xs text-purple-600">Special: ${tr.specialTermsAmount}</p>
                      )}
                      {(user?.role === "admin" || user?.role === "super_admin") && tr.submittedBy && (
                        <span className="text-xs text-muted-foreground">by {tr.submittedBy}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No work reports yet.</p>
          )}
        </div>

        {/* ---- WORK CREDITS SECTION ---- */}
        {workCredits && workCredits.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">Work Credits</h2>
            <div className="space-y-2">
              {workCredits.map((wc: any) => {
                let descList: string[] = [];
                try { descList = JSON.parse(wc.workDescriptions); } catch {}
                return (
                  <Card key={wc.id}>
                    <CardContent className="py-3 flex gap-3">
                      <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                        <CreditCard className="w-5 h-5 text-purple-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">{wc.tenantFirstName} {wc.tenantLastName} — {wc.property}</p>
                            <p className="text-xs text-muted-foreground">
                              {wc.date} · Lot/Unit: {wc.lotOrUnit} · {wc.creditType === "fixed" ? "Fixed" : `${wc.hoursWorked}h × $${wc.hourlyRate}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-sm font-semibold text-purple-600">${wc.totalAmount}</span>
                            <button
                              className="text-muted-foreground hover:text-destructive p-0.5"
                              onClick={async () => {
                                if (!window.confirm("Delete this work credit?")) return;
                                try {
                                  await apiRequest("DELETE", `/api/work-credits/${wc.id}`);
                                  queryClient.invalidateQueries({ queryKey: ["/api/work-credits"] });
                                  toast({ title: "Work credit deleted" });
                                } catch {
                                  toast({ title: "Failed to delete", variant: "destructive" });
                                }
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        {descList.length > 0 && (
                          <div className="mt-1">
                            {descList.map((item: string, i: number) => (
                              <p key={i} className="text-xs text-muted-foreground">• {item}</p>
                            ))}
                          </div>
                        )}
                        {(user?.role === "admin" || user?.role === "super_admin") && wc.submittedBy && (
                          <span className="text-xs text-muted-foreground">by {wc.submittedBy}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-center py-6">
        <a
          href="https://www.perplexity.ai/computer"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Created with Perplexity Computer
        </a>
      </div>

      <Dialog open={editingInvoice !== null} onOpenChange={(open) => { if (!open) setEditingInvoice(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Receipt</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">What Was Bought</Label>
              <Input value={editDescription} onChange={e => setEditDescription(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">What For / Use</Label>
              <Input value={editPurpose} onChange={e => setEditPurpose(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount ($)</Label>
              <Input type="number" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Bought By</Label>
              <Input value={editBoughtBy} onChange={e => setEditBoughtBy(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Rent Manager Issue #</Label>
              <Input value={editRmIssue} onChange={e => setEditRmIssue(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setEditingInvoice(null)}>Cancel</Button>
            <Button className="flex-1" disabled={editSaving} onClick={async () => {
              setEditSaving(true);
              try {
                await apiRequest("PUT", `/api/invoices/${editingInvoice!.id}`, {
                  description: editDescription,
                  purpose: editPurpose,
                  amount: editAmount,
                  boughtBy: editBoughtBy,
                  rentManagerIssue: editRmIssue || undefined,
                });
                queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
                setEditingInvoice(null);
                toast({ title: "Receipt updated" });
              } catch (err: any) {
                toast({ title: "Failed to update", description: "Please try again.", variant: "destructive" });
              } finally {
                setEditSaving(false);
              }
            }}>
              {editSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editingCashTx !== null} onOpenChange={(open) => { if (!open) setEditingCashTx(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Cash Transaction</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Amount ($)</Label>
              <Input type="number" step="0.01" value={editCashAmount} onChange={e => setEditCashAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input value={editCashDescription} onChange={e => setEditCashDescription(e.target.value)} />
            </div>
            {editingCashTx?.category === "bank_deposit" && (
              <div className="space-y-1">
                <Label className="text-xs">Bank Name</Label>
                <Input value={editCashBankName} onChange={e => setEditCashBankName(e.target.value)} />
              </div>
            )}
            {editingCashTx?.category === "rental_income" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Unit/Lot</Label>
                  <Input value={editCashUnitLot} onChange={e => setEditCashUnitLot(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Tenant Name</Label>
                  <Input value={editCashTenantName} onChange={e => setEditCashTenantName(e.target.value)} />
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setEditingCashTx(null)}>Cancel</Button>
            <Button className="flex-1" disabled={editCashSaving} onClick={async () => {
              setEditCashSaving(true);
              try {
                await apiRequest("PUT", `/api/cash-transactions/${editingCashTx!.id}`, {
                  amount: editCashAmount,
                  description: editCashDescription,
                  bankName: editCashBankName || undefined,
                  unitLotNumber: editCashUnitLot || undefined,
                  tenantName: editCashTenantName || undefined,
                });
                queryClient.invalidateQueries({ queryKey: ["/api/cash-transactions"] });
                queryClient.invalidateQueries({ queryKey: ["/api/cash-balances"] });
                setEditingCashTx(null);
                toast({ title: "Transaction updated" });
              } catch {
                toast({ title: "Failed to update", variant: "destructive" });
              } finally {
                setEditCashSaving(false);
              }
            }}>
              {editCashSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {viewingPhotos && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => { setViewingPhotos(null); setViewPhotoIdx(0); setPhotoZoom(1); }}
        >
          <div className="relative max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <div className="overflow-auto max-h-[80vh] rounded-lg" style={{ cursor: photoZoom > 1 ? "grab" : "default" }}>
              <img
                src={authImgUrl(viewingPhotos[viewPhotoIdx])}
                alt="Receipt"
                className="w-full rounded-lg transition-transform"
                style={{ transform: `scale(${photoZoom})`, transformOrigin: "center center" }}
                onDoubleClick={() => setPhotoZoom(z => z === 1 ? 2.5 : 1)}
              />
            </div>
            {/* Zoom controls */}
            <div className="absolute top-2 left-2 flex gap-1">
              <button className="w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center text-lg font-bold" onClick={() => setPhotoZoom(z => Math.min(z + 0.5, 4))}>+</button>
              <button className="w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center text-lg font-bold" onClick={() => setPhotoZoom(z => Math.max(z - 0.5, 1))}>-</button>
              {photoZoom > 1 && <button className="h-8 px-2 rounded-full bg-black/50 text-white flex items-center justify-center text-xs" onClick={() => setPhotoZoom(1)}>Reset</button>}
            </div>
            {viewingPhotos.length > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
                {viewPhotoIdx + 1} / {viewingPhotos.length}
              </div>
            )}
            {viewingPhotos.length > 1 && viewPhotoIdx > 0 && (
              <button className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => { setViewPhotoIdx(i => i - 1); setPhotoZoom(1); }}>
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {viewingPhotos.length > 1 && viewPhotoIdx < viewingPhotos.length - 1 && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => { setViewPhotoIdx(i => i + 1); setPhotoZoom(1); }}>
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
            <button
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center"
              onClick={() => { setViewingPhotos(null); setViewPhotoIdx(0); }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
      </div>
    </LogoBackground>
  );
}
