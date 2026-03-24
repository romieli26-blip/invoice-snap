import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Loader2, CheckCircle2, User, PenLine, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PropertyItem { id: number; name: string; sheetsTabId: number | null; }

export default function InvoiceFormPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  const photoPath = (window as any).__invoicePhotoPath || "";

  const { data: propertiesList, isLoading: propsLoading } = useQuery<PropertyItem[]>({
    queryKey: ["/api/properties"],
  });

  const [property, setProperty] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split("T")[0]);
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [amount, setAmount] = useState("");
  const [boughtByMode, setBoughtByMode] = useState<"me" | "other">("me");
  const [boughtByCustom, setBoughtByCustom] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "cc">("cash");
  const [lastFourDigits, setLastFourDigits] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const resolvedBoughtBy = boughtByMode === "me" ? (user?.displayName || "") : boughtByCustom;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!photoPath) return;

    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/invoices", {
        photoPath,
        property,
        purchaseDate,
        description,
        purpose,
        amount,
        boughtBy: resolvedBoughtBy || user?.displayName || "Unknown",
        paymentMethod,
        lastFourDigits: paymentMethod === "cc" ? lastFourDigits : undefined,
      });

      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });

      toast({
        title: "Invoice submitted",
        description: "Your invoice has been recorded.",
      });

      setTimeout(() => setLocation("/"), 1500);
    } catch (err: any) {
      toast({
        title: "Failed to submit",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="text-center space-y-3">
          <CheckCircle2 className="w-16 h-16 text-primary mx-auto" />
          <h2 className="text-lg font-semibold" data-testid="text-success">Invoice Submitted</h2>
          <p className="text-sm text-muted-foreground">Redirecting to home...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 pt-6">
      <div className="max-w-lg mx-auto space-y-4">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <h1 className="text-xl font-semibold" data-testid="text-form-title">Invoice Details</h1>

        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Property</Label>
                <Select
                  value={property}
                  onValueChange={setProperty}
                >
                  <SelectTrigger data-testid="select-property">
                    <SelectValue placeholder="Select property" />
                  </SelectTrigger>
                  <SelectContent>
                    {propsLoading ? (
                      <SelectItem value="__loading" disabled>Loading...</SelectItem>
                    ) : (
                      propertiesList?.map(p => (
                        <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="purchaseDate">Date of Purchase</Label>
                <Input
                  id="purchaseDate"
                  type="date"
                  value={purchaseDate}
                  onChange={e => setPurchaseDate(e.target.value)}
                  required
                  data-testid="input-date"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">What Was Bought</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="e.g. Plumbing supplies, cleaning materials"
                  required
                  data-testid="input-description"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="purpose">What For / Use</Label>
                <Input
                  id="purpose"
                  value={purpose}
                  onChange={e => setPurpose(e.target.value)}
                  placeholder="e.g. Unit 4B bathroom repair, Park entrance"
                  required
                  data-testid="input-purpose"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="amount">Amount ($)</Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.00"
                  required
                  data-testid="input-amount"
                />
              </div>

              <div className="space-y-2">
                <Label>Bought By</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setBoughtByMode("me")}
                    className={`flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                      boughtByMode === "me"
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                    }`}
                    data-testid="button-bought-by-me"
                  >
                    <User className="w-4 h-4" />
                    Me
                  </button>
                  <button
                    type="button"
                    onClick={() => setBoughtByMode("other")}
                    className={`flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                      boughtByMode === "other"
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                    }`}
                    data-testid="button-bought-by-other"
                  >
                    <PenLine className="w-4 h-4" />
                    Someone Else
                  </button>
                </div>
                {boughtByMode === "me" ? (
                  <p className="text-xs text-muted-foreground mt-1" data-testid="text-bought-by-name">
                    Will be recorded as: {user?.displayName}
                  </p>
                ) : (
                  <Input
                    value={boughtByCustom}
                    onChange={e => setBoughtByCustom(e.target.value)}
                    placeholder="e.g. Roland Maintenance, ABC Plumbing"
                    required
                    className="mt-1"
                    autoFocus
                    data-testid="input-bought-by-custom"
                  />
                )}
              </div>

              <div className="space-y-2">
                <Label>Payment Method</Label>
                <Select
                  value={paymentMethod}
                  onValueChange={(v: "cash" | "cc") => setPaymentMethod(v)}
                >
                  <SelectTrigger data-testid="select-payment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="cc">Credit Card</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {paymentMethod === "cc" && (
                <div className="space-y-2">
                  <Label htmlFor="lastFour">Last 4 Digits of Card</Label>
                  <Input
                    id="lastFour"
                    value={lastFourDigits}
                    onChange={e => {
                      const v = e.target.value.replace(/\D/g, "").slice(0, 4);
                      setLastFourDigits(v);
                    }}
                    placeholder="1234"
                    maxLength={4}
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    data-testid="input-last-four"
                  />
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={submitting}
                data-testid="button-submit"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Submit Invoice
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
