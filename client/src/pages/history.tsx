import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Camera, FileText, LogOut, Users, Download, CreditCard, Banknote, Building2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Invoice } from "@shared/schema";
import { LogoBackground } from "@/components/LogoBackground";

interface EnrichedInvoice extends Invoice {
  submittedBy: string;
}

export default function HistoryPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();

  const { data: invoices, isLoading } = useQuery<EnrichedInvoice[]>({
    queryKey: ["/api/invoices"],
  });

  async function handleExport() {
    try {
      const res = await apiRequest("GET", "/api/invoices/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "invoices.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <LogoBackground>
      <div className="bg-background">
      {/* Header */}
      <div className="border-b bg-card px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold" data-testid="text-history-title">Invoice Snap</h1>
            <p className="text-xs text-muted-foreground">{user?.displayName}</p>
          </div>
          <div className="flex items-center gap-2">
            {user?.role === "admin" && (
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
        {/* New Invoice Button */}
        <Button
          className="w-full h-14 text-base gap-2"
          onClick={() => setLocation("/capture")}
          data-testid="button-new-invoice"
        >
          <Camera className="w-5 h-5" />
          New Invoice
        </Button>

        {/* Section header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Recent Invoices</h2>
          {invoices && invoices.length > 0 && (
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
                  <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium truncate">{inv.description}</p>
                      <span className="text-sm font-semibold whitespace-nowrap">${inv.amount}</span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{inv.purpose}</p>
                    <div className="flex items-center gap-2 mt-1">
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
                      {inv.boughtBy !== inv.submittedBy && (
                        <span className="text-xs text-muted-foreground">buyer: {inv.boughtBy}</span>
                      )}
                      {user?.role === "admin" && (
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
            <p className="text-sm font-medium">No invoices yet</p>
            <p className="text-xs text-muted-foreground mt-1">Tap "New Invoice" to submit your first one.</p>
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
      </div>
    </LogoBackground>
  );
}
