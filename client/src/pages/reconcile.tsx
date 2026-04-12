import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLocation } from "wouter";
import { apiRequest, apiUpload, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Upload, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LogoBackground } from "@/components/LogoBackground";

interface PropertyItem { id: number; name: string; }

export default function ReconcilePage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Upload form state
  const [property, setProperty] = useState("");
  const [ccDigits, setCcDigits] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Result state
  const [statementId, setStatementId] = useState<number | null>(null);
  const [txCount, setTxCount] = useState(0);
  const [reconciling, setReconciling] = useState(false);
  const [result, setResult] = useState<any>(null);

  const { data: propertiesList } = useQuery<PropertyItem[]>({ queryKey: ["/api/properties"] });
  const { data: statements } = useQuery<any[]>({ queryKey: ["/api/admin/statements"] });

  async function handleUpload() {
    if (!file || !property || !ccDigits || !startDate || !endDate) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("statement", file);
      formData.append("property", property);
      formData.append("ccLastDigits", ccDigits);
      formData.append("startDate", startDate);
      formData.append("endDate", endDate);

      const res = await apiUpload("/api/admin/upload-statement", formData);
      const data = await res.json();
      setStatementId(data.id);
      setTxCount(data.transactions);
      setShowConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/statements"] });
      toast({ title: "Statement uploaded", description: `${data.transactions} transactions found` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleReconcile(id: number) {
    setReconciling(true);
    try {
      const res = await apiRequest("POST", `/api/admin/reconcile/${id}`);
      const data = await res.json();
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/statements"] });
      toast({ title: "Report generated", description: `${data.matched}/${data.total} matched` });
    } catch (err: any) {
      toast({ title: "Reconciliation failed", description: err.message, variant: "destructive" });
    } finally {
      setReconciling(false);
    }
  }

  return (
    <LogoBackground>
      <div className="bg-background p-4 pt-6 pb-12">
        <div className="max-w-lg mx-auto space-y-4">
          <button onClick={() => setLocation("/")} className="flex items-center gap-1 text-sm text-muted-foreground">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>

          <h1 className="text-xl font-semibold">CC Statement Reconciliation</h1>

          {/* Upload section */}
          {!statementId && !result && (
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-2">
                  <Label>Property</Label>
                  <Select value={property} onValueChange={setProperty}>
                    <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
                    <SelectContent>
                      {propertiesList?.map(p => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Last 4 or 5 Digits of Credit Card</Label>
                  <Input value={ccDigits} onChange={e => setCcDigits(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="1234 or 12345" maxLength={5} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Start Date</Label>
                    <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} max={new Date().toISOString().split("T")[0]} />
                  </div>
                  <div className="space-y-2">
                    <Label>End Date</Label>
                    <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} max={new Date().toISOString().split("T")[0]} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Statement File (CSV or PDF)</Label>
                  <Input type="file" accept=".csv,.pdf,text/csv,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} />
                </div>
                <Button
                  className="w-full bg-yellow-500 hover:bg-yellow-600 text-black"
                  disabled={!property || !ccDigits || !startDate || !endDate || !file}
                  onClick={() => setShowConfirm(true)}
                >
                  <Upload className="w-4 h-4 mr-2" /> Upload & Analyze Statement
                </Button>
              </CardContent>
            </Card>
          )}

          {/* After upload - reconcile button */}
          {statementId && !result && (
            <Card>
              <CardContent className="pt-6 text-center space-y-3">
                <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto" />
                <p className="font-medium">Statement uploaded - {txCount} transactions found</p>
                <p className="text-sm text-muted-foreground">Property: {property} | CC: ••{ccDigits} | {startDate} to {endDate}</p>
                <Button onClick={() => handleReconcile(statementId)} disabled={reconciling} className="w-full">
                  {reconciling ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Generate Reconciliation Report
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Results */}
          {result && (
            <Card>
              <CardContent className="pt-6 space-y-3">
                <h2 className="font-semibold text-lg">Reconciliation Results</h2>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="bg-green-50 rounded-lg p-3">
                    <p className="text-2xl font-bold text-green-600">{result.matched}</p>
                    <p className="text-xs text-muted-foreground">Matched</p>
                  </div>
                  <div className={`rounded-lg p-3 ${result.unmatched > 0 ? "bg-red-50" : "bg-green-50"}`}>
                    <p className={`text-2xl font-bold ${result.unmatched > 0 ? "text-red-600" : "text-green-600"}`}>{result.unmatched}</p>
                    <p className="text-xs text-muted-foreground">Missing</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-2xl font-bold">{result.total}</p>
                    <p className="text-xs text-muted-foreground">Total</p>
                  </div>
                </div>

                {result.unmatchedDetails?.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="font-medium text-red-600 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> Missing Transactions</h3>
                    {result.unmatchedDetails.map((tx: any, i: number) => (
                      <div key={i} className="bg-red-50 rounded p-2 text-sm flex justify-between">
                        <span>{tx.date} - {tx.description}</span>
                        <span className="font-medium">${tx.amount}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => { setStatementId(null); setResult(null); setFile(null); }}>
                    Upload Another
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Previous statements */}
          {statements && statements.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Previous Reconciliations</h3>
              {statements.map((s: any) => (
                <Card key={s.id}>
                  <CardContent className="py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{s.property} - ••{s.ccLastDigits}</p>
                        <p className="text-xs text-muted-foreground">{s.startDate} to {s.endDate}</p>
                      </div>
                      <div className="text-right">
                        {s.matched !== null && s.matched !== undefined && s.total ? (
                          <p className="text-sm"><span className="text-green-600 font-medium">{s.matched}</span>/{s.total} matched</p>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => handleReconcile(s.id)} disabled={reconciling}>
                            Reconcile
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Confirmation dialog */}
          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogContent>
              <DialogHeader><DialogTitle>Confirm Statement Upload</DialogTitle></DialogHeader>
              <div className="space-y-2 text-sm">
                <div><span className="text-muted-foreground">Property:</span> <strong>{property}</strong></div>
                <div><span className="text-muted-foreground">Credit Card:</span> <strong>••{ccDigits}</strong></div>
                <div><span className="text-muted-foreground">Period:</span> <strong>{startDate} to {endDate}</strong></div>
                <div><span className="text-muted-foreground">File:</span> <strong>{file?.name}</strong></div>
              </div>
              <div className="flex gap-2 mt-4">
                <Button variant="outline" className="flex-1" onClick={() => setShowConfirm(false)}>Cancel</Button>
                <Button className="flex-1" onClick={handleUpload} disabled={uploading}>
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Confirm & Upload
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </LogoBackground>
  );
}
