import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Trash2, Loader2, CreditCard, AlertTriangle, Pencil, Check } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

interface Property { id: number; name: string; }

// Generate 5-minute interval time options (00:00 to 23:55)
const TIME_OPTIONS: string[] = [];
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 5) {
    const hh = h.toString().padStart(2, "0");
    const mm = m.toString().padStart(2, "0");
    TIME_OPTIONS.push(`${hh}:${mm}`);
  }
}

function formatTime12(t: string): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

export default function WorkCreditPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const homeProperty = user?.homeProperty || "";
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const today = new Date().toISOString().split("T")[0];

  const { data: properties } = useQuery<Property[]>({ queryKey: ["/api/properties"] });

  const [property, setProperty] = useState(homeProperty);
  const [date, setDate] = useState(today);
  const [tenantFirstName, setTenantFirstName] = useState("");
  const [tenantLastName, setTenantLastName] = useState("");
  const [lotOrUnit, setLotOrUnit] = useState("");
  const [workDescriptions, setWorkDescriptions] = useState<string[]>([""]);
  const [creditType, setCreditType] = useState<"fixed" | "hourly">("fixed");
  const [fixedAmount, setFixedAmount] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [timeBlocks, setTimeBlocks] = useState<{ start: string; end: string }[]>([{ start: "", end: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [confirmStep, setConfirmStep] = useState(0); // 0=form, 1=financial review, 2=manual entry reminder

  // Work descriptions helpers
  function addDescription() {
    setWorkDescriptions(prev => [...prev, ""]);
  }
  function updateDescription(idx: number, val: string) {
    const updated = [...workDescriptions];
    updated[idx] = val;
    setWorkDescriptions(updated);
  }
  function removeDescription(idx: number) {
    if (workDescriptions.length <= 1) return;
    setWorkDescriptions(workDescriptions.filter((_, i) => i !== idx));
  }

  // Time block helpers (for hourly)
  function addTimeBlock() {
    setTimeBlocks(prev => [...prev, { start: "", end: "" }]);
  }
  function removeTimeBlock(idx: number) {
    if (timeBlocks.length <= 1) return;
    setTimeBlocks(prev => prev.filter((_, i) => i !== idx));
  }
  function updateTimeBlock(idx: number, field: "start" | "end", value: string) {
    setTimeBlocks(prev => prev.map((b, i) => i === idx ? { ...b, [field]: value } : b));
  }

  // Calculate total hours/minutes for hourly type
  const hasInvalidBlock = timeBlocks.some(b => {
    if (!b.start || !b.end) return false;
    const [sh, sm] = b.start.split(":").map(Number);
    const [eh, em] = b.end.split(":").map(Number);
    return (eh * 60 + em) <= (sh * 60 + sm);
  });
  const totalMinutes = hasInvalidBlock ? 0 : timeBlocks.reduce((sum, b) => {
    if (!b.start || !b.end) return sum;
    const [sh, sm] = b.start.split(":").map(Number);
    const [eh, em] = b.end.split(":").map(Number);
    return sum + ((eh * 60 + em) - (sh * 60 + sm));
  }, 0);
  const totalHours = (totalMinutes / 60).toFixed(1);
  const allBlocksFilled = timeBlocks.every(b => b.start && b.end);

  // Computed total
  const computedTotal = creditType === "fixed"
    ? fixedAmount
    : (hourlyRate && totalMinutes > 0 ? (totalMinutes / 60 * parseFloat(hourlyRate)).toFixed(2) : "");

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    const filtered = workDescriptions.filter(d => d.trim());
    if (!property) {
      toast({ title: "Please select a property", variant: "destructive" });
      return;
    }
    if (!tenantFirstName.trim() || !tenantLastName.trim()) {
      toast({ title: "Tenant name is required", variant: "destructive" });
      return;
    }
    if (!lotOrUnit.trim()) {
      toast({ title: "Lot/Unit is required", variant: "destructive" });
      return;
    }
    if (filtered.length === 0) {
      toast({ title: "At least one work description is required", variant: "destructive" });
      return;
    }
    if (creditType === "fixed") {
      if (!fixedAmount || parseFloat(fixedAmount) <= 0) {
        toast({ title: "Amount must be greater than 0", variant: "destructive" });
        return;
      }
    } else {
      if (!allBlocksFilled) {
        toast({ title: "Please fill in all time blocks", variant: "destructive" });
        return;
      }
      for (let i = 0; i < timeBlocks.length; i++) {
        const b = timeBlocks[i];
        const [sh, sm] = b.start.split(":").map(Number);
        const [eh, em] = b.end.split(":").map(Number);
        if (eh * 60 + em <= sh * 60 + sm) {
          toast({ title: `Time block ${i + 1}: end time must be after start time`, variant: "destructive" });
          return;
        }
      }
      if (!hourlyRate || parseFloat(hourlyRate) <= 0) {
        toast({ title: "Hourly rate must be greater than 0", variant: "destructive" });
        return;
      }
    }
    setConfirmStep(1);
  }

  async function handleFinalSubmit() {
    const filtered = workDescriptions.filter(d => d.trim());
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/work-credits", {
        property,
        date,
        tenantFirstName: tenantFirstName.trim(),
        tenantLastName: tenantLastName.trim(),
        lotOrUnit: lotOrUnit.trim(),
        workDescriptions: filtered,
        creditType,
        fixedAmount: creditType === "fixed" ? fixedAmount : undefined,
        hoursWorked: creditType === "hourly" ? totalHours : undefined,
        hourlyRate: creditType === "hourly" ? hourlyRate : undefined,
        timeBlocks: creditType === "hourly" ? timeBlocks : undefined,
        totalAmount: computedTotal,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/work-credits"] });
      toast({ title: "Work credit submitted" });
      setLocation("/");
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  const filteredDescriptions = workDescriptions.filter(d => d.trim());

  // ---- CONFIRMATION STEP 1: Financial Review ----
  if (confirmStep === 1) {
    return (
      <LogoBackground>
        <div className="bg-background min-h-screen p-4 pt-6 pb-12">
          <div className="max-w-lg mx-auto space-y-4">
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              <h1 className="text-lg font-semibold">Review Before Submitting</h1>
            </div>

            <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-800">
              <CardContent className="py-3 px-4">
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  This entry has financial implications. Please review all details carefully.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="grid grid-cols-2 gap-y-2 text-sm">
                  <span className="text-muted-foreground">Property</span>
                  <span className="font-medium text-right">{property}</span>

                  <span className="text-muted-foreground">Date</span>
                  <span className="font-medium text-right">{date}</span>

                  <span className="text-muted-foreground">Tenant</span>
                  <span className="font-medium text-right">{tenantFirstName} {tenantLastName}</span>

                  <span className="text-muted-foreground">Lot/Unit</span>
                  <span className="font-medium text-right">{lotOrUnit}</span>

                  <span className="text-muted-foreground">Credit Type</span>
                  <span className="font-medium text-right">{creditType === "fixed" ? "Fixed Amount" : "Hourly Rate"}</span>
                </div>

                {creditType === "hourly" && (
                  <div className="border-t pt-2">
                    <p className="text-xs text-muted-foreground mb-1">Time Blocks</p>
                    {timeBlocks.map((b, idx) => (
                      <div key={idx} className="text-sm font-medium">
                        {formatTime12(b.start)} – {formatTime12(b.end)}
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-y-1 text-sm mt-2">
                      <span className="text-muted-foreground">Total Hours</span>
                      <span className="font-medium text-right">{totalHours} hrs</span>
                      <span className="text-muted-foreground">Rate</span>
                      <span className="font-medium text-right">${hourlyRate}/hr</span>
                    </div>
                  </div>
                )}

                {filteredDescriptions.length > 0 && (
                  <div className="border-t pt-2">
                    <p className="text-xs text-muted-foreground mb-1">Work Description</p>
                    <ul className="list-disc list-inside text-sm space-y-0.5">
                      {filteredDescriptions.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="border-t pt-2">
                  <div className="grid grid-cols-2 text-sm">
                    <span className="text-muted-foreground">Credit Amount</span>
                    <span className="font-semibold text-right text-lg">${computedTotal}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 gap-1"
                onClick={() => setConfirmStep(0)}
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </Button>
              <Button
                className="flex-1 gap-1 bg-purple-600 hover:bg-purple-700"
                onClick={() => setConfirmStep(2)}
              >
                <Check className="w-4 h-4" />
                Confirm
              </Button>
            </div>
          </div>
        </div>
      </LogoBackground>
    );
  }

  // ---- CONFIRMATION STEP 2: Manual Entry Reminder ----
  if (confirmStep === 2) {
    return (
      <LogoBackground>
        <div className="bg-background min-h-screen p-4 pt-6 pb-12">
          <div className="max-w-lg mx-auto space-y-4">
            <div className="flex items-center gap-2 text-purple-600">
              <AlertTriangle className="w-5 h-5" />
              <h1 className="text-lg font-semibold">Manual Entry Required</h1>
            </div>

            <Card className="border-purple-200 bg-purple-50/50 dark:bg-purple-950/20 dark:border-purple-800">
              <CardContent className="py-4 px-4">
                <p className="text-sm text-purple-800 dark:text-purple-300">
                  I confirm that this entry needs to be manually entered to the relevant property management system (Rent Manager or Firefly) as this is for reporting purposes and does not appear on the tenant's transaction sheet.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="py-3 text-sm">
                <div className="grid grid-cols-2 gap-y-1">
                  <span className="text-muted-foreground">Tenant</span>
                  <span className="font-medium text-right">{tenantFirstName} {tenantLastName}</span>
                  <span className="text-muted-foreground">Property</span>
                  <span className="font-medium text-right">{property}</span>
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-semibold text-right">${computedTotal}</span>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 gap-1"
                onClick={() => setConfirmStep(1)}
              >
                Go Back
              </Button>
              <Button
                className="flex-1 gap-1 bg-purple-600 hover:bg-purple-700"
                disabled={submitting}
                onClick={handleFinalSubmit}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                I Confirm & Submit
              </Button>
            </div>
          </div>
        </div>
      </LogoBackground>
    );
  }

  // ---- FORM SCREEN ----
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

          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-purple-600" />
            <h1 className="text-xl font-semibold">Work Credit</h1>
          </div>

          <form onSubmit={handleFormSubmit} className="space-y-4">
            {/* Property: selector for admin, read-only for managers */}
            <div className="space-y-2">
              <Label>Property</Label>
              {isAdmin ? (
                <Select value={property} onValueChange={setProperty}>
                  <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
                  <SelectContent>
                    {properties?.map(p => (
                      <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value={property} readOnly className="bg-muted/40" />
              )}
            </div>

            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                max={today}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Tenant First Name</Label>
                <Input
                  value={tenantFirstName}
                  onChange={e => setTenantFirstName(e.target.value)}
                  placeholder="First name"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Tenant Last Name</Label>
                <Input
                  value={tenantLastName}
                  onChange={e => setTenantLastName(e.target.value)}
                  placeholder="Last name"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Lot/Unit Number</Label>
              <Input
                value={lotOrUnit}
                onChange={e => setLotOrUnit(e.target.value)}
                placeholder="e.g. Lot 42 or Unit 3B"
                required
              />
            </div>

            {/* Work Descriptions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Work Description</Label>
                <Button type="button" variant="ghost" size="sm" className="gap-1 text-xs" onClick={addDescription}>
                  <Plus className="w-3 h-3" /> Add
                </Button>
              </div>
              {workDescriptions.map((d, idx) => (
                <div key={idx} className="flex gap-2">
                  <Input
                    value={d}
                    onChange={e => updateDescription(idx, e.target.value)}
                    placeholder={`Work item ${idx + 1}`}
                  />
                  {workDescriptions.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeDescription(idx)}>
                      <Trash2 className="w-4 h-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {/* Credit Type Toggle */}
            <div className="space-y-2">
              <Label>Credit Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={creditType === "fixed" ? "default" : "outline"}
                  className={creditType === "fixed" ? "flex-1 bg-purple-600 hover:bg-purple-700" : "flex-1"}
                  onClick={() => setCreditType("fixed")}
                >
                  Fixed Amount
                </Button>
                <Button
                  type="button"
                  variant={creditType === "hourly" ? "default" : "outline"}
                  className={creditType === "hourly" ? "flex-1 bg-purple-600 hover:bg-purple-700" : "flex-1"}
                  onClick={() => setCreditType("hourly")}
                >
                  Hourly Rate
                </Button>
              </div>
            </div>

            {creditType === "fixed" && (
              <div className="space-y-2">
                <Label>Credit Amount ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={fixedAmount}
                  onChange={e => setFixedAmount(e.target.value)}
                  placeholder="0.00"
                  required
                />
              </div>
            )}

            {creditType === "hourly" && (
              <>
                <div className="space-y-2">
                  <Label>Time Worked</Label>
                  {timeBlocks.map((block, idx) => {
                    const blockInvalid = block.start && block.end && (() => {
                      const [sh, sm] = block.start.split(":").map(Number);
                      const [eh, em] = block.end.split(":").map(Number);
                      return (eh * 60 + em) <= (sh * 60 + sm);
                    })();
                    return (
                      <div key={idx}>
                        <div className="flex items-center gap-2">
                          <Select value={block.start} onValueChange={v => updateTimeBlock(idx, "start", v)}>
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder="Start" />
                            </SelectTrigger>
                            <SelectContent className="max-h-[200px]">
                              {TIME_OPTIONS.map(t => (
                                <SelectItem key={`s-${idx}-${t}`} value={t}>{formatTime12(t)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span className="text-xs text-muted-foreground">to</span>
                          <Select value={block.end} onValueChange={v => updateTimeBlock(idx, "end", v)}>
                            <SelectTrigger className={`flex-1 ${blockInvalid ? "border-destructive" : ""}`}>
                              <SelectValue placeholder="End" />
                            </SelectTrigger>
                            <SelectContent className="max-h-[200px]">
                              {TIME_OPTIONS.map(t => (
                                <SelectItem key={`e-${idx}-${t}`} value={t}>{formatTime12(t)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {timeBlocks.length > 1 && (
                            <button type="button" onClick={() => removeTimeBlock(idx)} className="text-muted-foreground hover:text-destructive">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {blockInvalid && (
                          <p className="text-xs text-destructive mt-1">End time must be after start time</p>
                        )}
                      </div>
                    );
                  })}
                  <Button type="button" variant="outline" size="sm" className="w-full gap-1 text-xs" onClick={addTimeBlock}>
                    <Plus className="w-3 h-3" /> Add Time Block
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Hourly Rate ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={hourlyRate}
                    onChange={e => setHourlyRate(e.target.value)}
                    placeholder="0.00"
                    required
                  />
                </div>

                {totalMinutes > 0 && hourlyRate && (
                  <div className="bg-purple-50 dark:bg-purple-950/30 rounded p-2 text-xs text-center">
                    Total: <strong>{totalHours} hours</strong>
                    <span> × ${hourlyRate}/hr = <strong>${(totalMinutes / 60 * parseFloat(hourlyRate)).toFixed(2)}</strong></span>
                  </div>
                )}
              </>
            )}

            {/* Total display */}
            {computedTotal && parseFloat(computedTotal) > 0 && (
              <div className="bg-purple-100 dark:bg-purple-950/40 rounded-lg p-3 text-center">
                <p className="text-xs text-purple-600 dark:text-purple-400">Credit Amount</p>
                <p className="text-2xl font-bold text-purple-700 dark:text-purple-300">${computedTotal}</p>
              </div>
            )}

            <Button
              type="submit"
              className="w-full bg-purple-600 hover:bg-purple-700"
              disabled={submitting || !property}
            >
              Review & Submit
            </Button>
          </form>
        </div>
      </div>
    </LogoBackground>
  );
}
