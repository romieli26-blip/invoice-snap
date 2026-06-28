import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LogoBackground } from "@/components/LogoBackground";
import { ArrowLeft, Loader2, CheckCircle2, Upload, Camera, X } from "lucide-react";

interface PropertyItem { id: number; name: string; sheetsTabId: number | null; }
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Dedicated New Check Transaction flow. Lives outside Cash so we can:
// 1. Track a "deposited" lifecycle independent of cash on hand
// 2. Sync to its own Check Transactions Google Sheet
// 3. Power a separate "Checks on Hand" dashboard card
export default function CheckTransactionPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Property scoping mirrors the cash flow exactly.
  const { data: properties = [] } = useQuery<PropertyItem[]>({ queryKey: ["/api/properties"] });

  const [property, setProperty] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [payerName, setPayerName] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [unitLotNumber, setUnitLotNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [photoPath, setPhotoPath] = useState("");
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // After save, ask the user whether the check was already deposited so we
  // know whether to count it toward "Checks on Hand" or not.
  const [askDeposited, setAskDeposited] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // Default property to the user's home base for one-tap submission.
  useEffect(() => {
    const home = (user as any)?.homeProperty;
    if (home && !property && properties.some(p => p.name === home)) {
      setProperty(home);
    }
  }, [user, properties, property]);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setPhotoPath(data.path);
      setPhotoPreviewUrl(URL.createObjectURL(file));
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function validate(): string | null {
    if (!property) return "Please choose a property.";
    if (!amount || parseFloat(amount) <= 0) return "Amount must be greater than $0.";
    if (parseFloat(amount) > 50000) return "Amount exceeds the $50,000 cap.";
    if (!date) return "Please pick a date.";
    if (new Date(date) > new Date()) return "Date cannot be in the future.";
    if (!payerName.trim()) return "Please enter who the check is from.";
    if (!photoPath) return "Please take or upload a photo of the check.";
    return null;
  }

  async function doSubmit(depositedNow: boolean) {
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/check-transactions", {
        property, amount, date, payerName: payerName.trim(),
        checkNumber: checkNumber.trim() || undefined,
        unitLotNumber: unitLotNumber.trim() || undefined,
        notes: notes.trim() || undefined,
        photoPath,
        deposited: depositedNow,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/check-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/check-transactions/balances"] });
      setSubmitted(true);
      setTimeout(() => setLocation("/"), 1500);
    } catch (e: any) {
      toast({
        title: "Submission failed",
        description: e?.message || "Check your internet connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
      setAskDeposited(false);
    }
  }

  function handleSubmitClick(e: React.FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      toast({ title: err, variant: "destructive" });
      return;
    }
    // Open the deposit-status confirmation dialog. The actual API call happens
    // once the user picks Yes/No.
    setAskDeposited(true);
  }

  if (submitted) {
    return (
      <LogoBackground>
        <div className="min-h-screen flex items-center justify-center px-4">
          <Card className="max-w-md w-full">
            <CardContent className="p-8 text-center space-y-3">
              <CheckCircle2 className="w-16 h-16 text-primary mx-auto" />
              <h1 className="text-xl font-semibold">Check submitted</h1>
              <p className="text-sm text-muted-foreground">Returning to the dashboard…</p>
            </CardContent>
          </Card>
        </div>
      </LogoBackground>
    );
  }

  return (
    <LogoBackground>
      <div className="min-h-screen px-4 py-4">
        <div className="max-w-md mx-auto space-y-3">
          <button
            type="button"
            onClick={() => setLocation("/")}
            className="text-sm text-muted-foreground flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <h1 className="text-xl font-semibold">New Check Transaction</h1>

          <Card>
            <CardContent className="p-4">
              <form onSubmit={handleSubmitClick} className="space-y-3">
                <div className="space-y-1">
                  <Label>Property</Label>
                  <Select value={property} onValueChange={setProperty}>
                    <SelectTrigger><SelectValue placeholder="Choose a property" /></SelectTrigger>
                    <SelectContent>
                      {properties.map(p => (
                        <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label>Amount ($)</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Date</Label>
                  <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
                </div>

                <div className="space-y-1">
                  <Label>From <span className="text-red-500">*</span></Label>
                  <Input
                    value={payerName} onChange={e => setPayerName(e.target.value)}
                    placeholder="Who is the check from?"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Check # (optional)</Label>
                  <Input
                    value={checkNumber} onChange={e => setCheckNumber(e.target.value)}
                    placeholder="e.g. 1042"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Unit / Lot Number (optional)</Label>
                  <Input
                    value={unitLotNumber} onChange={e => setUnitLotNumber(e.target.value)}
                    placeholder="e.g. Unit 4B, Lot 12"
                  />
                </div>

                <div className="space-y-1">
                  <Label>Notes (optional)</Label>
                  <Textarea
                    value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder="Anything to add?"
                    rows={2}
                  />
                </div>

                <div className="space-y-1">
                  <Label>Check Photo <span className="text-red-500">*</span></Label>
                  {photoPreviewUrl ? (
                    <div className="relative">
                      <img src={photoPreviewUrl} alt="Check" className="w-full rounded-md" />
                      <button
                        type="button"
                        onClick={() => { setPhotoPath(""); setPhotoPreviewUrl(""); }}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" variant="outline" disabled={uploading} onClick={() => cameraInputRef.current?.click()}>
                        <Camera className="w-4 h-4 mr-1" /> Take Photo
                      </Button>
                      <Button type="button" variant="outline" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                        <Upload className="w-4 h-4 mr-1" /> Upload
                      </Button>
                      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                    </div>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={submitting || uploading}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Review & Submit
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Deposit-status confirmation. Yes = already deposited (no Checks-on-Hand impact). */}
      <Dialog open={askDeposited} onOpenChange={(open) => { if (!open) setAskDeposited(false); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Was this check already deposited?</DialogTitle>
            <DialogDescription>
              If yes, it won't be added to Checks on Hand. You can always change this later from the dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-semibold text-right">${parseFloat(amount || "0").toFixed(2)}</span>
              <span className="text-muted-foreground">From</span>
              <span className="text-right">{payerName}</span>
              <span className="text-muted-foreground">Property</span>
              <span className="text-right">{property}</span>
              {checkNumber && <><span className="text-muted-foreground">Check #</span><span className="text-right">{checkNumber}</span></>}
            </div>
          </div>
          <div className="flex flex-col gap-2 mt-3">
            <Button onClick={() => doSubmit(true)} disabled={submitting}>
              Yes, already deposited
            </Button>
            <Button variant="outline" onClick={() => doSubmit(false)} disabled={submitting}>
              No, hold in Checks on Hand
            </Button>
            <Button variant="ghost" onClick={() => setAskDeposited(false)} disabled={submitting} size="sm">
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </LogoBackground>
  );
}
