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
import { ArrowLeft, Plus, Trash2, Loader2, Clock } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";

interface Property {
  id: number;
  name: string;
}

export default function TimeReportPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [property, setProperty] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [timeBlocks, setTimeBlocks] = useState<{ start: string; end: string }[]>([{ start: "", end: "" }]);
  const [accomplishments, setAccomplishments] = useState<string[]>([""]);
  const [miles, setMiles] = useState("");
  const [specialTerms, setSpecialTerms] = useState(false);
  const [specialTermsAmount, setSpecialTermsAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
  const totalMinutes = timeBlocks.reduce((sum, b) => {
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

  async function handleSubmit(e: React.FormEvent) {
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
    // Derive startTime/endTime from first and last block for backward compat
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

          <form onSubmit={handleSubmit} className="space-y-4">
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
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} required />
            </div>

            {/* Time blocks */}
            <div className="space-y-2">
              <Label>Time Worked</Label>
              {timeBlocks.map((block, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input type="time" value={block.start} onChange={e => updateTimeBlock(idx, "start", e.target.value)} className="flex-1" />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input type="time" value={block.end} onChange={e => updateTimeBlock(idx, "end", e.target.value)} className="flex-1" />
                  {timeBlocks.length > 1 && (
                    <button type="button" onClick={() => removeTimeBlock(idx)} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
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

            {allowOffSite && (
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
            )}

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
              Submit Work Report
            </Button>
          </form>
        </div>
      </div>
    </LogoBackground>
  );
}
