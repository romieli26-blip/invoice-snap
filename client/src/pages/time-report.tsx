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
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [accomplishments, setAccomplishments] = useState<string[]>([""]);
  const [miles, setMiles] = useState("");
  const [specialTerms, setSpecialTerms] = useState(false);
  const [specialTermsAmount, setSpecialTermsAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  // Calculate hours
  function calcHours(): number {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    return diff > 0 ? diff / 60 : 0;
  }

  const hours = calcHours();
  const mileageAmount = miles ? (parseFloat(miles) * mileageRate).toFixed(2) : "";

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
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/time-reports", {
        property,
        date,
        startTime,
        endTime,
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label>End Time</Label>
                <Input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} required />
              </div>
            </div>
            {hours > 0 && currentRate && (
              <p className="text-xs text-muted-foreground">{hours.toFixed(2)} hours × ${currentRate}/hr = ${(hours * parseFloat(currentRate)).toFixed(2)}</p>
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

            <Button type="submit" className="w-full" disabled={submitting || !property || !startTime || !endTime}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Submit Work Report
            </Button>
          </form>
        </div>
      </div>
    </LogoBackground>
  );
}
