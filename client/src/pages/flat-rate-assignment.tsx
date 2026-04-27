import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LogoBackground } from "@/components/LogoBackground";
import { ArrowLeft, DollarSign, Plus, Trash2, Loader2, AlertTriangle, CheckCircle } from "lucide-react";
import type { Property } from "@shared/schema";

interface FlatRateAssignment {
  id: number;
  userId: number;
  property: string;
  date: string;
  rate: string;
  accomplishments: string;
  notes: string | null;
  createdAt: string;
  submittedBy?: string;
}

export default function FlatRateAssignmentPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const today = new Date().toISOString().slice(0, 10);
  const [property, setProperty] = useState("");
  const [date, setDate] = useState(today);
  const [rate, setRate] = useState("");
  const [accomplishments, setAccomplishments] = useState<string[]>([""]);
  const [notes, setNotes] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: properties } = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const { data: existingRows, isLoading } = useQuery<FlatRateAssignment[]>({
    queryKey: ["/api/flat-rate-assignments"],
  });

  function updateAccomplishment(idx: number, val: string) {
    setAccomplishments(prev => prev.map((a, i) => (i === idx ? val : a)));
  }
  function addAccomplishment() { setAccomplishments(prev => [...prev, ""]); }
  function removeAccomplishment(idx: number) {
    setAccomplishments(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  }

  function validate(): string | null {
    if (!property) return "Please select a property";
    if (!date) return "Please select a date";
    if (date > today) return "Date cannot be in the future";
    const r = parseFloat(rate);
    if (!rate || isNaN(r) || r <= 0) return "Rate must be greater than 0";
    if (r > 10000) return "Rate cannot exceed $10,000";
    const filled = accomplishments.filter(a => a.trim().length > 0);
    if (filled.length === 0) return "Add at least one accomplishment";
    return null;
  }

  function handleReview() {
    const err = validate();
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    setReviewing(true);
  }

  async function handleConfirmSubmit() {
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/flat-rate-assignments", {
        property,
        date,
        rate: parseFloat(rate),
        accomplishments: accomplishments.filter(a => a.trim().length > 0),
        notes: notes.trim() || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/flat-rate-assignments"] });
      toast({ title: `Flat rate of $${parseFloat(rate).toFixed(2)} submitted` });
      // Reset form
      setProperty("");
      setDate(today);
      setRate("");
      setAccomplishments([""]);
      setNotes("");
      setReviewing(false);
    } catch (e: any) {
      toast({ title: "Failed to submit", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this flat-rate assignment?")) return;
    try {
      await apiRequest("DELETE", `/api/flat-rate-assignments/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/flat-rate-assignments"] });
      toast({ title: "Deleted" });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
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
            <DollarSign className="w-5 h-5 text-pink-600" />
            <h1 className="text-xl font-semibold">Flat Rate Assignment</h1>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Log a one-off, fixed-amount task for the day. This is in addition to your regular hours, and is added to your pay calculator.
          </p>

          {!reviewing ? (
            // ----- Form -----
            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Property</Label>
                  <Select value={property} onValueChange={setProperty}>
                    <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
                    <SelectContent>
                      {properties?.map(p => (
                        <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Date</Label>
                    <Input type="date" value={date} max={today} onChange={e => setDate(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Flat Rate ($)</Label>
                    <Input type="number" step="0.01" min="0" max="10000" value={rate}
                           onChange={e => setRate(e.target.value)} placeholder="e.g. 10.00" />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Accomplishments</Label>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                            onClick={addAccomplishment}>
                      <Plus className="w-3 h-3" /> Add
                    </Button>
                  </div>
                  {accomplishments.map((a, i) => (
                    <div key={i} className="flex gap-1">
                      <Input value={a} onChange={e => updateAccomplishment(i, e.target.value)}
                             placeholder={`Accomplishment ${i + 1}`} />
                      {accomplishments.length > 1 && (
                        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0"
                                onClick={() => removeAccomplishment(i)}>
                          <Trash2 className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Notes (optional)</Label>
                  <Textarea value={notes} onChange={e => setNotes(e.target.value)}
                            placeholder="Any additional context" rows={3} />
                </div>

                <Button className="w-full bg-pink-600 hover:bg-pink-700 text-white" onClick={handleReview}>
                  Review &amp; Submit
                </Button>
              </CardContent>
            </Card>
          ) : (
            // ----- Review screen -----
            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-800 dark:text-amber-300">
                    <strong>Financial confirmation:</strong> This entry will be added to your pay calculation.
                    Please review the details below before confirming.
                  </div>
                </div>

                <div className="text-sm space-y-2">
                  <div className="flex justify-between"><span className="text-muted-foreground">Property</span><span className="font-medium">{property}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span className="font-medium">{date}</span></div>
                  <div className="flex justify-between border-t pt-2"><span className="font-semibold">Flat Rate Pay</span><span className="font-bold text-pink-700 dark:text-pink-400">${parseFloat(rate || "0").toFixed(2)}</span></div>
                </div>

                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Accomplishments</p>
                  <ul className="text-sm list-disc list-inside space-y-0.5 ml-1">
                    {accomplishments.filter(a => a.trim()).map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                </div>

                {notes.trim() && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm whitespace-pre-wrap">{notes}</p>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button variant="outline" className="flex-1" onClick={() => setReviewing(false)} disabled={submitting}>
                    Edit
                  </Button>
                  <Button className="flex-1 bg-pink-600 hover:bg-pink-700 text-white gap-2" onClick={handleConfirmSubmit} disabled={submitting}>
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                    Confirm &amp; Submit
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Past entries are now listed on the main dashboard alongside Work Reports.
              The Flat Rate Assignment page is form-only. */}
          <p className="text-xs text-muted-foreground text-center mt-2">
            Your past flat-rate entries appear on the main dashboard alongside your other reports.
          </p>
        </div>
      </div>
    </LogoBackground>
  );
}
