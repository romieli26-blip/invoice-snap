import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Trash2, Loader2, Clock, AlertTriangle, Pencil, Check } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

interface Property {
  id: number;
  name: string;
}

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

export default function TimeReportPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [property, setProperty] = useState(user?.homeProperty || "");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [timeBlocks, setTimeBlocks] = useState<{ start: string; end: string }[]>([{ start: "", end: "" }]);
  const [accomplishments, setAccomplishments] = useState<string[]>([""]);
  const [miles, setMiles] = useState("");
  const [specialTerms, setSpecialTerms] = useState(false);
  const [specialTermsAmount, setSpecialTermsAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

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

  // Calculate total hours across all blocks
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

  const { data: properties } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  // Get user's mileage rate for calculation
  const mileageRate = parseFloat(user?.mileageRate || "0.50");
  const allowOffSite = user?.allowOffSite === 1;
  const allowSpecialTermsUser = user?.allowSpecialTerms === 1;
  const homeProperty = user?.homeProperty || "";
  const baseRate = user?.baseRate || "";
  const offSiteRate = user?.offSiteRate || "";

  const isOffSite = property && property !== homeProperty;
  const currentRate = isOffSite && allowOffSite ? offSiteRate : baseRate;

  const mileageAmount = miles ? (parseFloat(miles) * mileageRate).toFixed(2) : "";
  const requireFinancialConfirm = (user as any)?.requireFinancialConfirm === 1 || (user as any)?.requireFinancialConfirm === true;
  const allowPastDates = (user as any)?.allowPastDates === 1 || (user as any)?.allowPastDates === true;

  // Date limits: today is max, min is yesterday unless allowPastDates
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  // Check if all time blocks are filled
  const allBlocksFilled = timeBlocks.every(b => b.start && b.end);

  function addAccomplishment() {
    setAccomplishments([...accomplishments, ""]);
  }

  function updateAccomplishment(idx: number, val: string) {
    const updated = [...accomplishments];
    updated[idx] = val;
    setAccomplishments(updated);
  }

  function removeAccomplishment(idx: number) {
    if (accomplishments.length <= 1) return;
    setAccomplishments(accomplishments.filter((_, i) => i !== idx));
  }

  // Show confirmation screen or submit directly based on user setting
  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    const filtered = accomplishments.filter(a => a.trim());
    if (filtered.length === 0) {
      toast({ title: "At least one accomplishment is required", variant: "destructive" });
      return;
    }
    if (!allBlocksFilled) {
      toast({ title: "Please fill in all time blocks", variant: "destructive" });
      return;
    }
    // Validate end time is after start time for each block
    for (let i = 0; i < timeBlocks.length; i++) {
      const b = timeBlocks[i];
      const [sh, sm] = b.start.split(":").map(Number);
      const [eh, em] = b.end.split(":").map(Number);
      if (eh * 60 + em <= sh * 60 + sm) {
        toast({ title: `Time block ${i + 1}: end time must be after start time`, variant: "destructive" });
        return;
      }
    }
    if (requireFinancialConfirm) {
      setShowConfirm(true);
    } else {
      // No financial review needed — submit directly
      handleConfirmedSubmit();
    }
  }

  async function handleConfirmedSubmit() {
    const filtered = accomplishments.filter(a => a.trim());
    const startTime = timeBlocks[0].start;
    const endTime = timeBlocks[timeBlocks.length - 1].end;
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/time-reports", {
        property,
        date,
        startTime,
        endTime,
        timeBlocks,
        accomplishments: filtered,
        miles: miles || undefined,
        mileageAmount: mileageAmount || undefined,
        specialTerms,
        specialTermsAmount: specialTerms ? specialTermsAmount : undefined,
        notes: notes || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/time-reports"] });
      toast({ title: "Time report submitted" });
      setLocation("/");
    } catch (err: any) {
      toast({ title: "Failed to submit", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  const filteredAccomplishments = accomplishments.filter(a => a.trim());
  const totalPay = currentRate ? (totalMinutes / 60 * parseFloat(currentRate)).toFixed(2) : "";

  // ---- CONFIRMATION SCREEN ----
  if (showConfirm) {
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
                  This report has financial implications. Please review all details carefully before confirming.
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
                </div>

                <div className="border-t pt-2">
                  <p className="text-xs text-muted-foreground mb-1">Time Blocks</p>
                  {timeBlocks.map((b, idx) => (
                    <div key={idx} className="text-sm font-medium">
                      {formatTime12(b.start)} – {formatTime12(b.end)}
                    </div>
                  ))}
                </div>

                <div className="border-t pt-2 grid grid-cols-2 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Total Hours</span>
                  <span className="font-medium text-right">{totalHours} hrs</span>

                  {currentRate && (
                    <>
                      <span className="text-muted-foreground">Rate</span>
                      <span className="font-medium text-right">${currentRate}/hr{isOffSite && allowOffSite ? " (off-site)" : ""}</span>

                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="font-semibold text-right">${totalPay}</span>
                    </>
                  )}

                  {miles && parseFloat(miles) > 0 && (
                    <>
                      <span className="text-muted-foreground">Mileage</span>
                      <span className="font-medium text-right">{miles} mi × ${mileageRate.toFixed(2)} = ${mileageAmount}</span>
                    </>
                  )}

                  {specialTerms && specialTermsAmount && (
                    <>
                      <span className="text-muted-foreground">Travel Expenses</span>
                      <span className="font-medium text-right">${specialTermsAmount}</span>
                    </>
                  )}
                </div>

                {filteredAccomplishments.length > 0 && (
                  <div className="border-t pt-2">
                    <p className="text-xs text-muted-foreground mb-1">Accomplishments</p>
                    <ul className="list-disc list-inside text-sm space-y-0.5">
                      {filteredAccomplishments.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {notes && (
                  <div className="border-t pt-2">
                    <p className="text-xs text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm">{notes}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 gap-1"
                onClick={() => setShowConfirm(false)}
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </Button>
              <Button
                className="flex-1 gap-1"
                disabled={submitting}
                onClick={handleConfirmedSubmit}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Confirm & Submit
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
            <Clock className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold">Work Report</h1>
          </div>

          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Property</Label>
              <Select value={property} onValueChange={setProperty} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select property" />
                </SelectTrigger>
                <SelectContent>
                  {properties?.map(p => (
                    <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isOffSite && allowOffSite && (
                <p className="text-xs text-blue-600">Off-site rate: ${offSiteRate}/hr</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                max={today}
                min={allowPastDates ? undefined : yesterday}
                required
              />
            </div>

            {/* Time blocks */}
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
                <Plus className="w-3 h-3" /> Add Time Block (e.g. returned after break)
              </Button>
            </div>
            {totalMinutes > 0 && (
              <div className="bg-muted/40 rounded p-2 text-xs text-center">
                Total: <strong>{totalHours} hours</strong>
                {currentRate && <span> × ${currentRate}/hr = <strong>${(totalMinutes / 60 * parseFloat(currentRate)).toFixed(2)}</strong></span>}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>What did you accomplish?</Label>
                <Button type="button" variant="ghost" size="sm" className="gap-1 text-xs" onClick={addAccomplishment}>
                  <Plus className="w-3 h-3" /> Add
                </Button>
              </div>
              {accomplishments.map((a, idx) => (
                <div key={idx} className="flex gap-2">
                  <Input
                    value={a}
                    onChange={e => updateAccomplishment(idx, e.target.value)}
                    placeholder={`Accomplishment ${idx + 1}`}
                  />
                  {accomplishments.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeAccomplishment(idx)}>
                      <Trash2 className="w-4 h-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {/* Miles input is shown for every user. Miles driven are a
                legitimate pay/expense item regardless of whether the user
                is flagged for off-site work. Uses the user's mileage rate
                (defaults to $0.50/mi if not set on the profile). */}
            <div className="space-y-2">
              <Label>Miles Driven (optional)</Label>
              <Input
                type="number"
                step="0.1"
                value={miles}
                onChange={e => setMiles(e.target.value)}
                placeholder="0"
              />
              {miles && parseFloat(miles) > 0 && (
                <p className="text-xs text-muted-foreground">{miles} mi × ${mileageRate.toFixed(2)} = ${mileageAmount}</p>
              )}
            </div>

            {allowSpecialTermsUser && (
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="special-terms"
                    checked={specialTerms}
                    onCheckedChange={c => setSpecialTerms(c === true)}
                  />
                  <Label htmlFor="special-terms" className="text-sm font-normal cursor-pointer">Special Terms</Label>
                </div>
                {specialTerms && (
                  <div className="space-y-1">
                    <Label className="text-xs">Amount ($)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={specialTermsAmount}
                      onChange={e => setSpecialTermsAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any additional notes" />
            </div>

            <Button type="submit" className="w-full" disabled={submitting || !property || !allBlocksFilled}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {requireFinancialConfirm ? "Review & Submit" : "Submit Work Report"}
            </Button>
          </form>
        </div>
      </div>
    </LogoBackground>
  );
}
