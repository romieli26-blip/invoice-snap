import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useLocation } from "wouter";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
function authImgUrl(path: string) {
  const token = getAuthToken();
  return `${API_BASE}${path}${token ? `?token=${token}` : ""}`;
}
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Loader2, CheckCircle2, User, PenLine, Plus, Trash2, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LogoBackground } from "@/components/LogoBackground";

interface PropertyItem { id: number; name: string; sheetsTabId: number | null; }

interface SplitItem {
  description: string;
  purpose: string;
  amount: string;
  hasRmIssue: boolean;
  rentManagerIssue: string;
}

export default function InvoiceFormPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  const photoPath = (window as any).__invoicePhotoPath || "";
  const photoPaths: string[] = (window as any).__invoicePhotoPaths || (photoPath ? [photoPath] : []);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [confirmPhotoIndex, setConfirmPhotoIndex] = useState(0);

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
    { description: "", purpose: "", amount: "", hasRmIssue: false, rentManagerIssue: "" },
  ]);

  const [boughtByMode, setBoughtByMode] = useState<"me" | "other">("me");
  const [boughtByCustom, setBoughtByCustom] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "cc">("cc");
  const [lastFourDigits, setLastFourDigits] = useState("");
  const [hasRmIssue, setHasRmIssue] = useState(false);
  const [rentManagerIssue, setRentManagerIssue] = useState("");
  const [receiptType, setReceiptType] = useState<"expense" | "refund">("expense");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [zoomPhoto, setZoomPhoto] = useState(false);

  const resolvedBoughtBy = boughtByMode === "me" ? (user?.displayName || "") : boughtByCustom;

  // Split items helpers
  function updateSplitItem(index: number, field: keyof SplitItem, value: string) {
    setSplitItems(items => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  }
  function addSplitItem() {
    setSplitItems(items => [...items, { description: "", purpose: "", amount: "", hasRmIssue: false, rentManagerIssue: "" }]);
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

    if (receiptType === "refund") {
      if (!amount.trim()) return "Please enter the refund amount.";
      if (!purpose.trim()) return "Please enter the reason for the refund.";
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) return "Amount must be greater than $0.";
      if (amountNum > 10000) return "For refunds over $10,000, please contact your asset manager.";
      return null;
    }

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

  function handlePreSubmit(e: React.FormEvent) {
    e.preventDefault();

    const error = validateForm();
    if (error) {
      toast({ title: "Please fix the following", description: error, variant: "destructive" });
      return;
    }

    setShowConfirm(true);
  }

  async function handleConfirmSubmit() {
    const boughtBy = resolvedBoughtBy || user?.displayName || "Unknown";
    const rmIssue = hasRmIssue ? rentManagerIssue : undefined;
    const photoPathsJson = JSON.stringify(photoPaths);

    setSubmitting(true);
    try {
      if (receiptType === "refund") {
        await apiRequest("POST", "/api/invoices", {
          photoPath, photoPaths: photoPathsJson,
          property, purchaseDate,
          description: "Refund",
          purpose,
          amount,
          boughtBy: user?.displayName || "Unknown",
          paymentMethod: "cash",
          receiptType: "refund",
        });
      } else if (samePurpose) {
        await apiRequest("POST", "/api/invoices", {
          photoPath, photoPaths: photoPathsJson,
          property, purchaseDate, description, purpose, amount,
          boughtBy, paymentMethod,
          lastFourDigits: paymentMethod === "cc" ? lastFourDigits : undefined,
          rentManagerIssue: rmIssue,
          receiptType,
        });
      } else {
        for (const item of splitItems) {
          await apiRequest("POST", "/api/invoices", {
            photoPath, photoPaths: photoPathsJson,
            property, purchaseDate,
            description: item.description,
            purpose: item.purpose,
            amount: item.amount,
            boughtBy, paymentMethod,
            lastFourDigits: paymentMethod === "cc" ? lastFourDigits : undefined,
            rentManagerIssue: item.hasRmIssue ? item.rentManagerIssue : undefined,
            receiptType,
          });
        }
      }
      setShowConfirm(false);
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
            <form onSubmit={handlePreSubmit} className="space-y-4">
              {/* Receipt Type Toggle */}
              <div className="space-y-2">
                <Label>Receipt Type</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setReceiptType("expense")}
                    className={`flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                      receiptType === "expense"
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                    }`}
                    data-testid="button-type-expense"
                  >
                    Expense
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceiptType("refund")}
                    className={`flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                      receiptType === "refund"
                        ? "border-green-600 bg-green-600/10 text-green-600 font-medium"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                    }`}
                    data-testid="button-type-refund"
                  >
                    Refund
                  </button>
                </div>
              </div>

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

              {receiptType === "refund" ? (
                /* ---- REFUND: simplified form ---- */
                <>
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
                  <div className="space-y-2">
                    <Label htmlFor="purpose">Reason for Refund</Label>
                    <Input
                      id="purpose"
                      value={purpose}
                      onChange={e => setPurpose(e.target.value)}
                      placeholder="e.g. Overcharge on unit 5B, duplicate payment"
                      data-testid="input-purpose"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={submitting}
                    data-testid="button-submit"
                  >
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Submit Refund
                  </Button>
                </>
              ) : (
                /* ---- EXPENSE: full form ---- */
                <>
              {/* Split receipt toggle */}
              <div className="flex items-center space-x-2 py-1">
                <Checkbox
                  id="same-purpose"
                  checked={samePurpose}
                  onCheckedChange={(checked) => setSamePurpose(checked === true)}
                  data-testid="checkbox-same-purpose"
                />
                <Label htmlFor="same-purpose" className="text-sm font-normal cursor-pointer select-none">
                  All items on this receipt are for the same Task/Project
                </Label>
              </div>

              {samePurpose ? (
                /* ---- SINGLE ITEM MODE ---- */
                <>
                  <div className="space-y-2">
                    <Label htmlFor="description">What Was Bought — List each item separated by a comma</Label>
                    <Input
                      id="description"
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="e.g. Plumbing supplies, cleaning materials"
                      data-testid="input-description"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="purpose">What For / Use — Description; Unit, service ticket, or project/task</Label>
                    <Input
                      id="purpose"
                      value={purpose}
                      onChange={e => setPurpose(e.target.value)}
                      placeholder="e.g. Unit 4B bathroom repair, Park entrance"
                      data-testid="input-purpose"
                    />
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="rm-issue"
                      checked={hasRmIssue}
                      onCheckedChange={(checked) => setHasRmIssue(checked === true)}
                      data-testid="checkbox-rm-issue"
                    />
                    <Label htmlFor="rm-issue" className="text-sm font-normal cursor-pointer select-none">
                      Is there an open issue on Rent Manager for this item?
                    </Label>
                  </div>
                  {hasRmIssue && (
                    <div className="space-y-2">
                      <Label htmlFor="rmIssueNumber">Service Issue Number in Rent Manager</Label>
                      <Input
                        id="rmIssueNumber"
                        value={rentManagerIssue}
                        onChange={e => setRentManagerIssue(e.target.value)}
                        placeholder="e.g. 12345"
                        data-testid="input-rm-issue"
                      />
                    </div>
                  )}

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
                          <span className="text-xs font-medium text-muted-foreground">Task/Project {idx + 1}</span>
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
                        <div className="flex items-center space-x-2 pt-1">
                          <Checkbox
                            id={`rm-split-${idx}`}
                            checked={item.hasRmIssue}
                            onCheckedChange={(checked) => {
                              setSplitItems(items => items.map((it, i) => i === idx ? { ...it, hasRmIssue: checked === true } : it));
                            }}
                          />
                          <Label htmlFor={`rm-split-${idx}`} className="text-xs font-normal cursor-pointer select-none">
                            RM service issue?
                          </Label>
                        </div>
                        {item.hasRmIssue && (
                          <Input
                            value={item.rentManagerIssue}
                            onChange={e => updateSplitItem(idx, "rentManagerIssue", e.target.value)}
                            placeholder="e.g. 12345"
                            className="h-8 text-xs"
                            data-testid={`input-split-rm-${idx}`}
                          />
                        )}
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
                    Add Another Task/Project
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
                {samePurpose ? "Submit Receipt" : `Submit ${splitItems.length} Tasks/Projects`}
              </Button>
              </>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
      </div>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Receipt Details</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {/* Photo carousel — tap to zoom */}
            {photoPaths.length > 0 && (
              <div className="relative w-full h-32 rounded-lg overflow-hidden bg-muted cursor-pointer" onClick={() => { setShowConfirm(false); setZoomPhoto(true); }}>
                {photoPaths[confirmPhotoIndex]?.includes(".pdf") ? (
                  <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
                    <FileText className="w-6 h-6" />
                    <span className="text-sm">PDF Document</span>
                  </div>
                ) : (
                  <img src={authImgUrl(photoPaths[confirmPhotoIndex])} alt="Receipt" className="w-full h-full object-contain" />
                )}
                {photoPaths.length > 1 && (
                  <div className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                    {confirmPhotoIndex + 1} / {photoPaths.length}
                  </div>
                )}
                {photoPaths.length > 1 && confirmPhotoIndex > 0 && (
                  <button className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/40 text-white flex items-center justify-center" onClick={(e) => { e.stopPropagation(); setConfirmPhotoIndex(i => i - 1); }}>
                    <ChevronLeft className="w-3 h-3" />
                  </button>
                )}
                {photoPaths.length > 1 && confirmPhotoIndex < photoPaths.length - 1 && (
                  <button className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/40 text-white flex items-center justify-center" onClick={(e) => { e.stopPropagation(); setConfirmPhotoIndex(i => i + 1); }}>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
            <div><span className="text-muted-foreground text-xs">Type</span><p className={`font-medium ${receiptType === "refund" ? "text-green-600" : ""}`}>{receiptType === "refund" ? "Refund" : "Expense"}</p></div>
            <div><span className="text-muted-foreground text-xs">Property</span><p className="font-medium">{property}</p></div>
            <div><span className="text-muted-foreground text-xs">Date</span><p className="font-medium">{purchaseDate}</p></div>
            {samePurpose ? (
              <>
                <div><span className="text-muted-foreground text-xs">What Was Bought</span><p className="font-medium break-words">{description}</p></div>
                <div><span className="text-muted-foreground text-xs">What For / Use</span><p className="font-medium break-words">{purpose}</p></div>
                <div><span className="text-muted-foreground text-xs">Amount</span><p className="font-medium">${amount}</p></div>
              </>
            ) : (
              splitItems.map((item, i) => (
                <div key={i} className="border-t pt-2 mt-2">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Task/Project {i + 1}</p>
                  <div><span className="text-muted-foreground text-xs">What</span><p className="font-medium break-words">{item.description}</p></div>
                  <div><span className="text-muted-foreground text-xs">For</span><p className="font-medium break-words">{item.purpose}</p></div>
                  <div><span className="text-muted-foreground text-xs">Amount</span><p className="font-medium">${item.amount}</p></div>
                </div>
              ))
            )}
            <div><span className="text-muted-foreground text-xs">Bought By</span><p className="font-medium">{resolvedBoughtBy}</p></div>
            <div><span className="text-muted-foreground text-xs">Payment</span><p className="font-medium">{paymentMethod === "cc" ? `Credit Card ••${lastFourDigits}` : "Cash"}</p></div>
            {hasRmIssue && rentManagerIssue && (
              <div><span className="text-muted-foreground text-xs">RM Issue</span><p className="font-medium">{rentManagerIssue}</p></div>
            )}
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setShowConfirm(false)}>Edit</Button>
            <Button className="flex-1" onClick={handleConfirmSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirm & Submit
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Fullscreen photo zoom with carousel */}
      <Dialog open={zoomPhoto} onOpenChange={(open) => { setZoomPhoto(open); if (!open) setShowConfirm(true); }}>
        <DialogContent className="max-w-lg p-2 bg-black border-none">
          <div className="relative">
            <img src={photoPaths[confirmPhotoIndex] ? authImgUrl(photoPaths[confirmPhotoIndex]) : ""} alt="Receipt" className="w-full rounded-lg" />
            {photoPaths.length > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
                {confirmPhotoIndex + 1} / {photoPaths.length}
              </div>
            )}
            {photoPaths.length > 1 && confirmPhotoIndex > 0 && (
              <button className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => setConfirmPhotoIndex(i => i - 1)}>
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {photoPaths.length > 1 && confirmPhotoIndex < photoPaths.length - 1 && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => setConfirmPhotoIndex(i => i + 1)}>
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </LogoBackground>
  );
}
