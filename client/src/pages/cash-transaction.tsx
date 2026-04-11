import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Loader2, CheckCircle2, DollarSign, TrendingUp, TrendingDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LogoBackground } from "@/components/LogoBackground";

interface PropertyItem { id: number; name: string; sheetsTabId: number | null; }

const INCOME_CATEGORIES = [
  { value: "rental_income", label: "Rental Income" },
  { value: "washer", label: "Washer" },
  { value: "dryer", label: "Dryer" },
  { value: "vending", label: "Vending" },
  { value: "store_items", label: "Store Items" },
  { value: "other", label: "Other" },
];

const SPENT_CATEGORIES = [
  { value: "bank_deposit", label: "Bank Deposit" },
  { value: "item_purchased", label: "Item Purchased" },
  { value: "contractor_pay", label: "Contractor Pay" },
  { value: "other", label: "Other" },
];

export default function CashTransactionPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  // Multi-step: 1 = choose type, 2 = fill details, 3 = confirm
  const [step, setStep] = useState(1);
  const [txType, setTxType] = useState<"income" | "spent" | "">("");

  // Form fields
  const [property, setProperty] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [unitLotNumber, setUnitLotNumber] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [bankName, setBankName] = useState("");
  const [description, setDescription] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const { data: propertiesList, isLoading: propsLoading } = useQuery<PropertyItem[]>({
    queryKey: ["/api/properties"],
  });

  const categories = txType === "income" ? INCOME_CATEGORIES : SPENT_CATEGORIES;

  function validateForm(): string | null {
    if (!property) return "Please select a property.";
    if (!category) return "Please select a category.";
    if (!amount.trim()) return "Please enter the amount.";
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return "Amount must be greater than $0.";
    if (amountNum > 50000) return "For amounts over $50,000, please contact your asset manager.";
    if (!date) return "Please select the date.";

    if (txType === "income" && category === "rental_income") {
      if (!unitLotNumber.trim()) return "Please enter the unit/lot number for rental income.";
      if (!tenantName.trim()) return "Please enter the tenant name for rental income.";
    }
    if (txType === "spent" && category === "bank_deposit") {
      if (!bankName.trim()) return "Please enter the bank name for deposits.";
    }

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
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/cash-transactions", {
        property,
        type: txType,
        category,
        amount,
        date,
        unitLotNumber: unitLotNumber || undefined,
        tenantName: tenantName || undefined,
        bankName: bankName || undefined,
        description: description || undefined,
      });
      setShowConfirm(false);
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ["/api/cash-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cash-balances"] });
      toast({ title: "Cash transaction recorded", description: `${txType === "income" ? "Income" : "Spent"}: $${amount}` });
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
            <h2 className="text-lg font-semibold">Transaction Recorded</h2>
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
          onClick={() => {
            if (step > 1) {
              setStep(step - 1);
              if (step === 2) { setTxType(""); setCategory(""); }
            } else {
              setLocation("/");
            }
          }}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
          {step > 1 ? "Back" : "Home"}
        </button>

        <h1 className="text-xl font-semibold">
          {step === 1 ? "Cash Transaction" : txType === "income" ? "Cash Income" : "Cash Spent"}
        </h1>

        {/* Step 1: Choose type */}
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">What type of cash transaction?</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setTxType("income"); setStep(2); }}
                className="flex flex-col items-center gap-3 rounded-xl border-2 border-border bg-card p-6 hover:border-primary hover:bg-primary/5 transition-colors"
                data-testid="button-type-income"
              >
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                  <TrendingUp className="w-7 h-7 text-green-600" />
                </div>
                <span className="text-base font-medium">Income</span>
                <span className="text-xs text-muted-foreground text-center">Rent, washer, dryer, vending, etc.</span>
              </button>
              <button
                onClick={() => { setTxType("spent"); setStep(2); }}
                className="flex flex-col items-center gap-3 rounded-xl border-2 border-border bg-card p-6 hover:border-primary hover:bg-primary/5 transition-colors"
                data-testid="button-type-spent"
              >
                <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center">
                  <TrendingDown className="w-7 h-7 text-red-600" />
                </div>
                <span className="text-base font-medium">Spent</span>
                <span className="text-xs text-muted-foreground text-center">Bank deposit, purchase, contractor, etc.</span>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Fill details */}
        {step === 2 && (
          <Card>
            <CardContent className="pt-6">
              <form onSubmit={handlePreSubmit} className="space-y-4">
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
                  <Label>Category</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger data-testid="select-category">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map(c => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cash-amount">Amount ($)</Label>
                  <Input
                    id="cash-amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0.00"
                    data-testid="input-amount"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cash-date">Date</Label>
                  <Input
                    id="cash-date"
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    max={new Date().toISOString().split("T")[0]}
                    required
                    data-testid="input-date"
                  />
                </div>

                {/* Income-specific: rental_income needs unit/lot + tenant */}
                {txType === "income" && category === "rental_income" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="unit-lot">Unit / Lot Number</Label>
                      <Input
                        id="unit-lot"
                        value={unitLotNumber}
                        onChange={e => setUnitLotNumber(e.target.value)}
                        placeholder="e.g. Unit 4B, Lot 12"
                        data-testid="input-unit-lot"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tenant-name">Tenant Name</Label>
                      <Input
                        id="tenant-name"
                        value={tenantName}
                        onChange={e => setTenantName(e.target.value)}
                        placeholder="e.g. John Smith"
                        data-testid="input-tenant-name"
                      />
                    </div>
                  </>
                )}

                {/* Income other categories can still have unit/lot and tenant optionally */}
                {txType === "income" && category && category !== "rental_income" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="unit-lot">Unit / Lot Number (optional)</Label>
                      <Input
                        id="unit-lot"
                        value={unitLotNumber}
                        onChange={e => setUnitLotNumber(e.target.value)}
                        placeholder="e.g. Laundry Room A"
                        data-testid="input-unit-lot"
                      />
                    </div>
                  </>
                )}

                {/* Spent: bank_deposit needs bank name */}
                {txType === "spent" && category === "bank_deposit" && (
                  <div className="space-y-2">
                    <Label htmlFor="bank-name">Bank Name</Label>
                    <Input
                      id="bank-name"
                      value={bankName}
                      onChange={e => setBankName(e.target.value)}
                      placeholder="e.g. Chase, Wells Fargo"
                      data-testid="input-bank-name"
                    />
                  </div>
                )}

                {/* Description for all spent categories */}
                {txType === "spent" && (
                  <div className="space-y-2">
                    <Label htmlFor="cash-description">Description {category === "bank_deposit" ? "(optional)" : ""}</Label>
                    <Input
                      id="cash-description"
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder={category === "bank_deposit" ? "e.g. Weekly deposit" : "e.g. Plumbing repair parts"}
                      data-testid="input-description"
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
                  Review & Submit
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Cash Transaction</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground text-xs">Type</span>
              <p className={`font-medium ${txType === "income" ? "text-green-600" : "text-red-600"}`}>
                {txType === "income" ? "Income" : "Spent"}
              </p>
            </div>
            <div><span className="text-muted-foreground text-xs">Property</span><p className="font-medium">{property}</p></div>
            <div><span className="text-muted-foreground text-xs">Category</span><p className="font-medium">{categories.find(c => c.value === category)?.label || category}</p></div>
            <div><span className="text-muted-foreground text-xs">Amount</span><p className="font-medium">${amount}</p></div>
            <div><span className="text-muted-foreground text-xs">Date</span><p className="font-medium">{date}</p></div>
            {unitLotNumber && <div><span className="text-muted-foreground text-xs">Unit/Lot</span><p className="font-medium">{unitLotNumber}</p></div>}
            {tenantName && <div><span className="text-muted-foreground text-xs">Tenant</span><p className="font-medium">{tenantName}</p></div>}
            {bankName && <div><span className="text-muted-foreground text-xs">Bank</span><p className="font-medium">{bankName}</p></div>}
            {description && <div><span className="text-muted-foreground text-xs">Description</span><p className="font-medium break-words">{description}</p></div>}
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
    </LogoBackground>
  );
}
