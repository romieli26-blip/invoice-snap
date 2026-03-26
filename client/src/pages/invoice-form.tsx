import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Loader2, CheckCircle2, User, PenLine, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LogoBackground } from "@/components/LogoBackground";

interface PropertyItem { id: number; name: string; sheetsTabId: number | null; }

interface SplitItem {
  description: string;
  purpose: string;
  amount: string;
}

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

  // Single-item fields (used when samePurpose = true)
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState("");
  const [amount, setAmount] = useState("");

  // Split mode
  const [samePurpose, setSamePurpose] = useState(true);
  const [receiptTotal, setReceiptTotal] = useState("");
  const [splitItems, setSplitItems] = useState<SplitItem[]>([
    { description: "", purpose: "", amount: "" },
  ]);

  const [boughtByMode, setBoughtByMode] = useState<"me" | "other">("me");
  const [boughtByCustom, setBoughtByCustom] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "cc">("cc");
  const [lastFourDigits, setLastFourDigits] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const resolvedBoughtBy = boughtByMode === "me" ? (user?.displayName || "") : boughtByCustom;

  // Split items helpers
  function updateSplitItem(index: number, field: keyof SplitItem, value: string) {
    setSplitItems(items => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  }
  function addSplitItem() {
    setSplitItems(items => [...items, { description: "", purpose: "", amount: "" }]);
  }
  function removeSplitItem(index: number) {
    if (splitItems.length <= 1) return;
    setSplitItems(items => items.filter((_, i) => i !== index));
  }

  const splitTotal = splitItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const receiptTotalNum = parseFloat(receiptTotal) || 0;
  const splitDifference = receiptTotalNum > 0 ? Math.abs(receiptTotalNum - splitTotal) : 0;
  const splitDiffPercent = receiptTotalNum > 0 ? (splitDifference / receiptTotalNum) * 100 : 0;
  const splitDiffOk = receiptTotalNum === 0 || splitDiffPercent <= 10;

  function validateForm(): string | null {
    if (!photoPath) return "No photo attached. Please go back and take a photo first.";
    if (!property) return "Please select a property.";
    if (!purchaseDate) return "Please select the date of purchase.";

    if (samePurpose) {
      if (!description.trim()) return "Please enter what was bought.";
      if (!purpose.trim()) return "Please enter what the purchase was for.";
      if (!amount.trim()) return "Please enter the amount.";
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) return "Amount must be greater than $0.";
      if (amountNum > 10000) return "For receipts over $10,000, please contact your asset manager.";
    } else {
      for (let i = 0; i < splitItems.length; i++) {
        const item = splitItems[i];
        if (!item.description.trim()) return `Item ${i + 1}: Please enter what was bought.`;
        if (!item.purpose.trim()) return `Item ${i + 1}: Please enter what it was for.`;
        if (!item.amount.trim()) return `Item ${i + 1}: Please enter the amount.`;
        const amt = parseFloat(item.amount);
        if (isNaN(amt) || amt <= 0) return `Item ${i + 1}: Amount must be greater than $0.`;
        if (amt > 10000) return `Item ${i + 1}: For receipts over $10,000, please contact your asset manager.`;
      }
      if (receiptTotalNum > 0 && !splitDiffOk) {
        return `The difference between the receipt total ($${receiptTotalNum.toFixed(2)}) and items total ($${splitTotal.toFixed(2)}) is ${splitDiffPercent.toFixed(1)}%. Maximum allowed is 10%.`;
      }
    }

    if (boughtByMode === "other" && !boughtByCustom.trim()) return "Please enter who made the purchase.";

    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const error = validateForm();
    if (error) {
      toast({ title: "Please fix the following", description: error, variant: "destructive" });
      return;
    }

    const boughtBy = resolvedBoughtBy || user?.displayName || "Unknown";

    setSubmitting(true);
    try {
      if (samePurpose) {
        await apiRequest("POST", "/api/invoices", {
          photoPath, property, purchaseDate, description, purpose, amount,
          boughtBy, paymentMethod,
          lastFourDigits: paymentMethod === "cc" ? lastFourDigits : undefined,
        });
      } else {
        for (const item of splitItems) {
          await apiRequest("POST", "/api/invoices", {
            photoPath, property, purchaseDate,
            description: item.description,
            purpose: item.purpose,
            amount: item.amount,
            boughtBy, paymentMethod,
            lastFourDigits: paymentMethod === "cc" ? lastFourDigits : undefined,
          });
        }
      }
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      const msg = samePurpose ? "Your receipt has been recorded." : `${splitItems.length} entries recorded from split receipt.`;
      toast({ title: "Receipt submitted", description: msg });
      setTimeout(() => setLocation("/"), 1500);
    } catch (err: any) {
      toast({ title: "Something went wrong", description: "Check your internet connection and try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <LogoBackground>
        <div className="flex items-center justify-center p-4 bg-background" style={{ minHeight: "100vh" }}>
          <div className="text-center space-y-3">
            <CheckCircle2 className="w-16 h-16 text-primary mx-auto" />
            <h2 className="text-lg font-semibold" data-testid="text-success">Receipt Submitted</h2>
            <p className="text-sm text-muted-foreground">Redirecting...</p>
          </div>
        </div>
      </LogoBackground>
    );
  }

  return (
    <LogoBackground>
      <div className="bg-background p-4 pt-6 pb-12">
      <div className="max-w-lg mx-auto space-y-4">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <h1 className="text-xl font-semibold" data-testid="text-form-title">Receipt Details</h1>

        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Property</Label>
                <Select value={property} onValueChange={setProperty}>
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
                  max={new Date().toISOString().split("T")[0]}
                  required
                  data-testid="input-date"
                />
              </div>

              {/* Split receipt toggle */}
              <div className="flex items-center space-x-2 py-1">
                <Checkbox
                  id="same-purpose"
                  checked={samePurpose}
                  onCheckedChange={(checked) => setSamePurpose(checked === true)}
                  data-testid="checkbox-same-purpose"
                />
                <Label htmlFor="same-purpose" className="text-sm font-normal cursor-pointer select-none">
                  All items on this receipt are for the same purpose
                </Label>
              </div>

              {samePurpose ? (
                /* ---- SINGLE ITEM MODE ---- */
                <>
                  <div className="space-y-2">
                    <Label htmlFor="description">What Was Bought</Label>
                    <Input
                      id="description"
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="e.g. Plumbing supplies, cleaning materials"
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
                      data-testid="input-purpose"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount ($)</Label>
                    <Input
                      id="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="10000"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      placeholder="0.00"
                      data-testid="input-amount"
                    />
                  </div>
                </>
              ) : (
                /* ---- SPLIT ITEMS MODE ---- */
                <>
                  <div className="space-y-2">
                    <Label htmlFor="receiptTotal">Receipt Total ($)</Label>
                    <Input
                      id="receiptTotal"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={receiptTotal}
                      onChange={e => setReceiptTotal(e.target.value)}
                      placeholder="Total on the receipt"
                      data-testid="input-receipt-total"
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter the receipt total to verify your split amounts (up to 10% difference allowed for taxes).
                    </p>
                  </div>

                  <div className="space-y-3">
                    {splitItems.map((item, idx) => (
                      <div key={idx} className="border rounded-lg p-3 space-y-2 bg-muted/30 relative">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-muted-foreground">Item {idx + 1}</span>
                          {splitItems.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeSplitItem(idx)}
                              className="text-muted-foreground hover:text-destructive p-0.5"
                              data-testid={`button-remove-item-${idx}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <Input
                          value={item.description}
                          onChange={e => updateSplitItem(idx, "description", e.target.value)}
                          placeholder="What Was Bought"
                          data-testid={`input-split-description-${idx}`}
                        />
                        <Input
                          value={item.purpose}
                          onChange={e => updateSplitItem(idx, "purpose", e.target.value)}
                          placeholder="What For / Use"
                          data-testid={`input-split-purpose-${idx}`}
                        />
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max="10000"
                          value={item.amount}
                          onChange={e => updateSplitItem(idx, "amount", e.target.value)}
                          placeholder="Amount ($)"
                          data-testid={`input-split-amount-${idx}`}
                        />
                      </div>
                    ))}
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-1"
                    onClick={addSplitItem}
                    data-testid="button-add-split-item"
                  >
                    <Plus className="w-4 h-4" />
                    Add Another Item
                  </Button>

                  {/* Totals summary */}
                  {splitItems.length > 0 && (
                    <div className="border rounded-lg p-3 space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Items total:</span>
                        <span className="font-medium">${splitTotal.toFixed(2)}</span>
                      </div>
                      {receiptTotalNum > 0 && (
                        <>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Receipt total:</span>
                            <span className="font-medium">${receiptTotalNum.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Difference:</span>
                            <span className={`font-medium ${splitDiffOk ? "text-primary" : "text-destructive"}`}>
                              ${splitDifference.toFixed(2)} ({splitDiffPercent.toFixed(1)}%)
                              {splitDiffOk ? " ✓" : " ✗ Over 10%"}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

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
                    <SelectItem value="cc">Credit Card</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
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
                disabled={submitting || (!samePurpose && !splitDiffOk)}
                data-testid="button-submit"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {samePurpose ? "Submit Receipt" : `Submit ${splitItems.length} Entries`}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      </div>
    </LogoBackground>
  );
}
